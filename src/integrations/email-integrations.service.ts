import { Injectable, BadRequestException, Inject, forwardRef } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import { EmailIntegration, EmailIntegrationDocument } from './entities/email-integration.entity';
import { ConnectEmailDto } from './dto/connect-email.dto';
import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'crypto';
import { EmailsService } from '../emails/emails.service';

@Injectable()
export class EmailIntegrationsService {
  constructor(
    @InjectModel(EmailIntegration.name)
    private emailModel: Model<EmailIntegrationDocument>,
    private configService: ConfigService,
    @Inject(forwardRef(() => EmailsService))
    private emailsService: EmailsService,
  ) {}

  private getKey(): Buffer {
    const secret = this.configService.get<string>('EMAIL_SECRET_KEY') || 'cconehub_dev_secret_key';
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

  private decryptSecret(enc: string): string {
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

  async testConnection(tenantId: string, dto: ConnectEmailDto) {
    // If passwords are not provided, get them from existing integration
    let testDto = dto;
    if (!dto.smtpPass || !dto.imapPass) {
      const existing = await this.emailModel.findOne({ tenantId: new Types.ObjectId(tenantId) });
      if (existing) {
        testDto = {
          ...dto,
          smtpPass: dto.smtpPass || this.decryptSecret(existing.smtp.passEnc),
          imapPass: dto.imapPass || this.decryptSecret(existing.imap.passEnc),
        };
      }
    }
    const [smtp, imap] = await Promise.all([this.testSmtp(testDto), this.testImap(testDto)]);
    return { smtp, imap };
  }

  async connect(tenantId: string, dto: ConnectEmailDto) {
    const result = await this.testConnection(tenantId, dto);
    if (!result.smtp.ok || !result.imap.ok) {
      throw new BadRequestException({ message: 'Email connection failed', details: result });
    }

    // Get existing integration to preserve passwords if not provided
    const existing = await this.emailModel.findOne({ tenantId: new Types.ObjectId(tenantId) });

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

    const now = new Date();

    const doc = await this.emailModel.findOneAndUpdate(
      { tenantId: new Types.ObjectId(tenantId) },
      {
        tenantId: new Types.ObjectId(tenantId),
        smtp,
        imap,
        status: 'connected',
        lastTestAt: now,
        connectedAt: now,
        lastError: null,
      },
      { upsert: true, new: true },
    );

    // Start auto-sync for this tenant
    this.emailsService.startAutoSync(tenantId);

    return this.sanitize(doc);
  }

  async status(tenantId: string) {
    const doc = await this.emailModel.findOne({ tenantId: new Types.ObjectId(tenantId) }).exec();
    if (!doc) {
      return { status: 'disconnected' };
    }
    return this.sanitize(doc);
  }

  async disconnect(tenantId: string) {
    const doc = await this.emailModel.findOneAndUpdate(
      { tenantId: new Types.ObjectId(tenantId) },
      { status: 'disconnected' },
      { new: true },
    );
    if (!doc) return { status: 'disconnected' };
    return this.sanitize(doc);
  }

  private sanitize(doc: EmailIntegrationDocument | null) {
    if (!doc) return { status: 'disconnected' };
    const json = doc.toObject();
    return {
      _id: json._id,
      tenantId: json.tenantId,
      status: json.status,
      lastTestAt: json.lastTestAt,
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
