import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import { EmailIntegration, EmailIntegrationDocument } from './entities/email-integration.entity';
import { ConnectEmailDto } from './dto/connect-email.dto';
import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'crypto';
import { EmailsService } from '../emails/emails.service';
import { BillingService } from '../billing/billing.service';

@Injectable()
export class EmailIntegrationsService {
  constructor(
    @InjectModel(EmailIntegration.name)
    private emailModel: Model<EmailIntegrationDocument>,
    private configService: ConfigService,
    @Inject(forwardRef(() => EmailsService))
    private emailsService: EmailsService,
    private billingService: BillingService,
  ) {}

  // ─── Crypto ───

  private getKey(): Buffer {
    const secret = this.configService.get<string>('EMAIL_SECRET_KEY') || 'axentyc_dev_secret_key';
    // Derive a 32-byte key using SHA-256 of the secret
    return createHash('sha256').update(secret).digest();
  }

  private encryptSecret(plain: string): string {
    const key = this.getKey();
    const iv = randomBytes(12); // GCM recommended 12 bytes IV
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('base64')}:${ct.toString('base64')}:${tag.toString('base64')}`;
  }

  decryptSecret(enc: string): string {
    const [ivB64, ctB64, tagB64] = (enc || '').split(':');
    if (!ivB64 || !ctB64 || !tagB64) throw new BadRequestException('Invalid encrypted data');
    const key = this.getKey();
    const iv = Buffer.from(ivB64, 'base64');
    const ct = Buffer.from(ctB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString('utf8');
  }

  // ─── Helpers ───

  /** Normalized identity of a mailbox: the "from" address, else a login that looks like an email. */
  static resolveEmailAddress(dto: {
    fromAddress?: string;
    smtpUser?: string;
    imapUser?: string;
  }): string {
    const candidates = [dto.fromAddress, dto.smtpUser, dto.imapUser]
      .map((v) => (v || '').trim().toLowerCase())
      .filter(Boolean);
    return candidates.find((v) => v.includes('@')) || candidates[0] || '';
  }

  private oid(id: string) {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Email account not found');
    return new Types.ObjectId(id);
  }

  private async findOwned(tenantId: string, id: string, workspaceId?: string): Promise<EmailIntegrationDocument> {
    const doc = await this.emailModel.findOne({
      _id: this.oid(id),
      tenantId: new Types.ObjectId(tenantId),
      ...(workspaceId ? { workspaceId: new Types.ObjectId(workspaceId) } : {}),
    });
    if (!doc) throw new NotFoundException('Email account not found');
    return doc;
  }

  /**
   * Resolve a connected mailbox. With `integrationId` that exact account is returned;
   * otherwise the default account of the scope (falling back to the oldest connected one).
   */
  async resolveConnected(
    tenantId: string,
    integrationId?: string,
    workspaceId?: string,
  ): Promise<EmailIntegrationDocument> {
    // A mailbox belongs to one workspace (company) of the agency
    const query: any = { tenantId: new Types.ObjectId(tenantId), status: 'connected' };
    if (integrationId) query._id = this.oid(integrationId);
    if (workspaceId) query.workspaceId = new Types.ObjectId(workspaceId);

    const doc = await this.emailModel.findOne(query).sort({ isDefault: -1, createdAt: 1 });
    if (!doc) {
      throw new BadRequestException(
        integrationId ? 'Email account not found or disconnected' : 'Email integration not configured',
      );
    }
    return doc;
  }

  /** Make sure a scope (tenant + workspace) with connected accounts has exactly one default. */
  private async ensureDefault(tenantId: string, workspaceId?: Types.ObjectId | null) {
    const scope: any = { tenantId: new Types.ObjectId(tenantId), workspaceId: workspaceId ?? null };
    const connected = await this.emailModel.find({ ...scope, status: 'connected' }).sort({ createdAt: 1 });
    if (connected.length === 0) return;

    const defaults = connected.filter((c) => c.isDefault);
    if (defaults.length === 1) return;

    const keep = defaults[0] || connected[0];
    await this.emailModel.updateMany({ ...scope, _id: { $ne: keep._id } }, { $set: { isDefault: false } });
    await this.emailModel.updateOne({ _id: keep._id }, { $set: { isDefault: true } });
  }

  // ─── Connection tests ───

  private async testSmtp(dto: ConnectEmailDto): Promise<{ ok: boolean; info?: any; error?: string }> {
    try {
      // Use dynamic require to avoid compile-time dependency
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const nodemailer = require('nodemailer');
      const transporter = nodemailer.createTransport({
        host: dto.smtpHost,
        port: dto.smtpPort,
        secure: dto.smtpSecure,
        auth: { user: dto.smtpUser, pass: dto.smtpPass },
        connectionTimeout: 20000,
        greetingTimeout: 20000,
        socketTimeout: 30000,
      });
      await transporter.verify();
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message || 'SMTP test failed' };
    }
  }

  private async testImap(dto: ConnectEmailDto): Promise<{ ok: boolean; info?: any; error?: string }> {
    let client: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { ImapFlow } = require('imapflow');
      client = new ImapFlow({
        host: dto.imapHost,
        port: dto.imapPort,
        secure: dto.imapSecure,
        auth: { user: dto.imapUser, pass: dto.imapPass },
        logger: false,
        tls: {
          rejectUnauthorized: false,
        },
        socketTimeout: 30000,
        greetingTimeout: 30000,
      });

      // Handle errors to prevent crashes
      client.on('error', (err: any) => {
        console.error('[IMAP Test] Error:', err.message);
      });

      await client.connect();
      try { await client.logout(); } catch {}
      return { ok: true };
    } catch (e: any) {
      try { if (client) await client.logout(); } catch {}
      const errorMsg = e?.code === 'ETIMEOUT'
        ? `Timeout: No se pudo conectar a ${dto.imapHost}:${dto.imapPort}. Verifica firewall/puerto.`
        : e?.message || 'IMAP test failed';
      return { ok: false, error: errorMsg };
    }
  }

  /** Fill missing passwords from the stored account referenced by `dto.integrationId`. */
  private async withStoredPasswords(tenantId: string, dto: ConnectEmailDto): Promise<ConnectEmailDto> {
    if (!dto.integrationId || (dto.smtpPass && dto.imapPass)) return dto;
    const existing = await this.findOwned(tenantId, dto.integrationId, dto.workspaceId);
    return {
      ...dto,
      smtpPass: dto.smtpPass || this.decryptSecret(existing.smtp.passEnc),
      imapPass: dto.imapPass || this.decryptSecret(existing.imap.passEnc),
    };
  }

  async testSmtpOnly(tenantId: string, dto: ConnectEmailDto) {
    return { smtp: await this.testSmtp(await this.withStoredPasswords(tenantId, dto)) };
  }

  async testImapOnly(tenantId: string, dto: ConnectEmailDto) {
    return { imap: await this.testImap(await this.withStoredPasswords(tenantId, dto)) };
  }

  async testConnection(tenantId: string, dto: ConnectEmailDto) {
    const testDto = await this.withStoredPasswords(tenantId, dto);
    const [smtp, imap] = await Promise.all([this.testSmtp(testDto), this.testImap(testDto)]);
    return { smtp, imap };
  }

  /** Test a saved account with its stored credentials and record the outcome. */
  async testStored(tenantId: string, id: string, workspaceId?: string) {
    const doc = await this.findOwned(tenantId, id, workspaceId);
    const dto: ConnectEmailDto = {
      smtpHost: doc.smtp.host,
      smtpPort: doc.smtp.port,
      smtpSecure: doc.smtp.secure,
      smtpUser: doc.smtp.user,
      smtpPass: this.decryptSecret(doc.smtp.passEnc),
      imapHost: doc.imap.host,
      imapPort: doc.imap.port,
      imapSecure: doc.imap.secure,
      imapUser: doc.imap.user,
      imapPass: this.decryptSecret(doc.imap.passEnc),
    };
    const [smtp, imap] = await Promise.all([this.testSmtp(dto), this.testImap(dto)]);
    const ok = smtp.ok && imap.ok;
    await this.emailModel.updateOne(
      { _id: doc._id },
      {
        $set: {
          lastTestAt: new Date(),
          lastError: ok ? null : [smtp.error && `SMTP: ${smtp.error}`, imap.error && `IMAP: ${imap.error}`].filter(Boolean).join(' | '),
        },
      },
    );
    return { smtp, imap };
  }

  // ─── Accounts CRUD ───

  /** Create a new mailbox, or update the one referenced by `dto.integrationId`. */
  async connect(tenantId: string, dto: ConnectEmailDto) {
    const tenantObjectId = new Types.ObjectId(tenantId);
    const existing = dto.integrationId ? await this.findOwned(tenantId, dto.integrationId, dto.workspaceId) : null;

    const emailAddress = EmailIntegrationsService.resolveEmailAddress(dto);
    if (!emailAddress) {
      throw new BadRequestException('Debes indicar el correo de la cuenta (usuario SMTP o dirección de envío)');
    }

    const duplicate = await this.emailModel.findOne({
      tenantId: tenantObjectId,
      emailAddress,
      ...(existing ? { _id: { $ne: existing._id } } : {}),
    });
    if (duplicate) {
      throw new ConflictException(`La cuenta ${emailAddress} ya está vinculada a esta agencia`);
    }

    // Plan capacity: new account, or re-activating a disconnected one
    if (!existing || existing.status === 'disconnected') {
      await this.billingService.assertCanConnectEmail(
        tenantId,
        existing?.workspaceId?.toString() || dto.workspaceId,
      );
    }

    const result = await this.testConnection(tenantId, dto);
    if (!result.smtp.ok || !result.imap.ok) {
      throw new BadRequestException({ message: 'Email connection failed', details: result });
    }

    const smtp = {
      host: dto.smtpHost,
      port: dto.smtpPort,
      secure: dto.smtpSecure,
      user: dto.smtpUser,
      passEnc: dto.smtpPass ? this.encryptSecret(dto.smtpPass) : existing?.smtp?.passEnc,
      fromName: dto.fromName,
      fromAddress: dto.fromAddress,
    };
    const imap = {
      host: dto.imapHost,
      port: dto.imapPort,
      secure: dto.imapSecure,
      user: dto.imapUser,
      passEnc: dto.imapPass ? this.encryptSecret(dto.imapPass) : existing?.imap?.passEnc,
    };
    if (!smtp.passEnc || !imap.passEnc) {
      throw new BadRequestException('Las contraseñas SMTP e IMAP son obligatorias');
    }

    const now = new Date();
    const label = dto.label?.trim() || existing?.label || emailAddress;
    let doc: EmailIntegrationDocument;

    if (existing) {
      existing.set({
        label,
        emailAddress,
        smtp,
        imap,
        status: 'connected',
        lastTestAt: now,
        connectedAt: existing.status === 'connected' ? existing.connectedAt : now,
        lastError: null,
      });
      doc = await existing.save();
    } else {
      doc = await this.emailModel.create({
        tenantId: tenantObjectId,
        workspaceId: dto.workspaceId ? new Types.ObjectId(dto.workspaceId) : undefined,
        label,
        emailAddress,
        smtp,
        imap,
        isDefault: false,
        status: 'connected',
        lastTestAt: now,
        connectedAt: now,
        lastError: null,
      });
    }

    await this.ensureDefault(tenantId, doc.workspaceId ?? null);
    const fresh = (await this.emailModel.findById(doc._id)) as EmailIntegrationDocument;

    // (Re)start the sync loop of this mailbox
    this.emailsService.startAutoSync(fresh._id.toString(), tenantId);

    return this.sanitize(fresh);
  }

  async list(tenantId: string, workspaceId?: string) {
    const query: any = { tenantId: new Types.ObjectId(tenantId) };
    if (workspaceId) query.workspaceId = new Types.ObjectId(workspaceId);

    const docs = await this.emailModel.find(query).sort({ isDefault: -1, createdAt: 1 }).exec();
    const unread = await this.emailsService.getUnreadByIntegration(tenantId);

    return docs.map((doc) => ({
      ...this.sanitize(doc),
      unreadCount: unread[doc._id.toString()] || 0,
    }));
  }

  async setDefault(tenantId: string, id: string, workspaceId?: string) {
    const doc = await this.findOwned(tenantId, id, workspaceId);
    if (doc.status !== 'connected') {
      throw new BadRequestException('Solo una cuenta conectada puede ser la predeterminada');
    }
    await this.emailModel.updateMany(
      { tenantId: doc.tenantId, workspaceId: doc.workspaceId ?? null, _id: { $ne: doc._id } },
      { $set: { isDefault: false } },
    );
    doc.isDefault = true;
    await doc.save();
    return this.sanitize(doc);
  }

  async disconnect(tenantId: string, id: string, workspaceId?: string) {
    const doc = await this.findOwned(tenantId, id, workspaceId);
    doc.status = 'disconnected';
    doc.isDefault = false;
    await doc.save();

    this.emailsService.stopAutoSync(id);
    await this.ensureDefault(tenantId, doc.workspaceId ?? null);
    return this.sanitize(doc);
  }

  /** Permanently remove a mailbox together with its locally cached messages. */
  async remove(tenantId: string, id: string, workspaceId?: string) {
    const doc = await this.findOwned(tenantId, id, workspaceId);
    this.emailsService.stopAutoSync(id);
    const deleted = await this.emailsService.deleteAllForIntegration(tenantId, id);
    await this.emailModel.deleteOne({ _id: doc._id });
    await this.ensureDefault(tenantId, doc.workspaceId ?? null);
    return { success: true, messagesDeleted: deleted };
  }

  /** Called by the sync loop to surface the mailbox health in the UI. */
  async recordSync(id: string, error?: string | null) {
    const update: any = error
      ? { lastError: error.slice(0, 500) }
      : { lastError: null, lastSyncAt: new Date() };
    await this.emailModel.updateOne({ _id: new Types.ObjectId(id) }, { $set: update });
  }

  /** Oldest mailbox of a tenant regardless of status (owner of pre-multi-account messages). */
  async findOldestByTenant(tenantId: string): Promise<EmailIntegrationDocument | null> {
    return this.emailModel.findOne({ tenantId: new Types.ObjectId(tenantId) }).sort({ createdAt: 1 });
  }

  async findConnectedIds(): Promise<{ id: string; tenantId: string }[]> {
    const docs = await this.emailModel.find({ status: 'connected' }).select('_id tenantId').lean();
    return docs.map((d) => ({ id: d._id.toString(), tenantId: d.tenantId.toString() }));
  }

  async findConnectedByTenant(tenantId: string, workspaceId?: string) {
    const query: any = { tenantId: new Types.ObjectId(tenantId), status: 'connected' };
    if (workspaceId) query.workspaceId = new Types.ObjectId(workspaceId);
    return this.emailModel.find(query).sort({ isDefault: -1, createdAt: 1 });
  }

  // ─── One-time migration for data created before multi-account support ───

  async migrateLegacyAccounts() {
    const legacy = await this.emailModel.find({
      $or: [{ emailAddress: { $exists: false } }, { emailAddress: null }, { emailAddress: '' }],
    });
    for (const doc of legacy) {
      doc.emailAddress = EmailIntegrationsService.resolveEmailAddress({
        fromAddress: doc.smtp?.fromAddress,
        smtpUser: doc.smtp?.user,
        imapUser: doc.imap?.user,
      });
      if (!doc.label) doc.label = doc.smtp?.fromName || doc.emailAddress;
      await doc.save();
    }

    const scopes = await this.emailModel.aggregate([
      { $group: { _id: { t: '$tenantId', w: { $ifNull: ['$workspaceId', null] } } } },
    ]);
    for (const s of scopes) {
      await this.ensureDefault(s._id.t.toString(), s._id.w);
    }
    return legacy.length;
  }

  private sanitize(doc: EmailIntegrationDocument | null) {
    if (!doc) return { status: 'disconnected' };
    const json = doc.toObject();
    return {
      _id: json._id,
      tenantId: json.tenantId,
      workspaceId: json.workspaceId,
      label: json.label || json.emailAddress,
      emailAddress: json.emailAddress,
      isDefault: !!json.isDefault,
      status: json.status,
      lastTestAt: json.lastTestAt,
      lastSyncAt: json.lastSyncAt,
      lastError: json.lastError || null,
      connectedAt: json.connectedAt,
      smtp: {
        host: json.smtp?.host,
        port: json.smtp?.port,
        secure: json.smtp?.secure,
        user: json.smtp?.user,
        fromName: json.smtp?.fromName,
        fromAddress: json.smtp?.fromAddress,
      },
      imap: {
        host: json.imap?.host,
        port: json.imap?.port,
        secure: json.imap?.secure,
        user: json.imap?.user,
      },
    };
  }
}
