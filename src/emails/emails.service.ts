import { Injectable, NotFoundException, BadRequestException, OnModuleInit, Inject, forwardRef, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { EmailMessage, EmailMessageDocument } from './entities/email-message.entity';
import { SendEmailDto } from './dto/send-email.dto';
import { EmailIntegrationsService } from '../integrations/email-integrations.service';
import { EmailIntegrationDocument } from '../integrations/entities/email-integration.entity';
import { EventsGateway } from '../events/events.gateway';

const AUTO_SYNC_INTERVAL_MS = 30000;
const MAILBOX_CACHE_TTL_MS = 5 * 60 * 1000;

// Standard folder name mapping (display names)
const STANDARD_NAMES: Record<string, string> = {
  inbox: 'INBOX',
  sent: 'Sent',
  'sent items': 'Sent',
  'sent mail': 'Sent',
  drafts: 'Drafts',
  draft: 'Drafts',
  trash: 'Trash',
  'deleted items': 'Trash',
  junk: 'Junk',
  spam: 'Junk',
  archive: 'Archive',
};

@Injectable()
export class EmailsService implements OnModuleInit {
  private readonly logger = new Logger(EmailsService.name);

  /** integrationId -> auto-sync timer. One loop per mailbox. */
  private syncIntervals: Map<string, NodeJS.Timeout> = new Map();
  /** Mailboxes currently syncing, to avoid overlapping runs of the same mailbox. */
  private syncing: Set<string> = new Set();
  /** integrationId -> cached IMAP mailbox list (avoids reconnecting on every folder refresh). */
  private mailboxCache: Map<string, { at: number; list: any[] }> = new Map();

  constructor(
    @InjectModel(EmailMessage.name)
    private emailModel: Model<EmailMessageDocument>,
    @Inject(forwardRef(() => EmailIntegrationsService))
    private emailIntegrationsService: EmailIntegrationsService,
    private eventsGateway: EventsGateway,
  ) {}

  // ─── Query helpers ───

  // Mail is scoped by tenant + workspace (+ mailbox when given)
  private buildQuery(tenantId: string, workspaceId?: string, integrationId?: string) {
    const query: any = { tenantId: new Types.ObjectId(tenantId) };
    if (workspaceId) query.workspaceId = new Types.ObjectId(workspaceId);
    if (integrationId) query.integrationId = new Types.ObjectId(integrationId);
    return query;
  }

  async onModuleInit() {
    // Do not block application start-up: migrate legacy data, then start the sync loops
    setTimeout(() => {
      this.bootstrap().catch((e) => this.logger.error(`Email bootstrap failed: ${e?.message || e}`));
    }, 5000);
  }

  private async bootstrap() {
    await this.migrateLegacyData();
    await this.initAutoSyncForAllTenants();
  }

  /**
   * Upgrade data created when an agency could only have one mailbox:
   *  1. backfill identity/default flags on existing mailboxes,
   *  2. drop the old unique index (tenant, uid, folder) that would collide across mailboxes,
   *  3. attach pre-existing messages to the mailbox that owned them.
   */
  private async migrateLegacyData() {
    const migrated = await this.emailIntegrationsService.migrateLegacyAccounts();
    if (migrated > 0) this.logger.log(`Migrated ${migrated} legacy mailbox(es) to multi-account`);

    try {
      await this.emailModel.collection.dropIndex('tenantId_1_messageId_1_folder_1');
      this.logger.log('Dropped legacy unique index tenantId_1_messageId_1_folder_1');
    } catch (e: any) {
      if (e?.codeName !== 'IndexNotFound' && e?.code !== 27 && e?.code !== 26) {
        this.logger.warn(`Could not drop legacy email index: ${e?.message || e}`);
      }
    }

    // Make sure the per-mailbox unique index exists (needed to guarantee idempotent syncs)
    try {
      await this.emailModel.createIndexes();
    } catch (e: any) {
      this.logger.warn(`Email index sync warning: ${e?.message || e}`);
    }

    const tenants = await this.emailModel.distinct('tenantId', { integrationId: null });
    for (const tenant of tenants) {
      const owner = await this.emailIntegrationsService.findOldestByTenant(tenant.toString());
      if (!owner) continue;
      const res = await this.emailModel.updateMany(
        { tenantId: tenant, integrationId: null },
        { $set: { integrationId: owner._id, ...(owner.workspaceId ? { workspaceId: owner.workspaceId } : {}) } },
      );
      this.logger.log(`Attached ${res.modifiedCount} legacy message(s) of tenant ${tenant} to mailbox ${owner.emailAddress}`);
    }
  }

  // ─── Mailbox access ───

  private async getImapCredentials(tenantId: string, integrationId?: string, workspaceId?: string) {
    const integration = await this.emailIntegrationsService.resolveConnected(tenantId, integrationId, workspaceId);
    const imapPass = this.emailIntegrationsService.decryptSecret(integration.imap.passEnc);
    return { integration, imapPass };
  }

  private createImapClient(integration: any, imapPass: string) {
    const { ImapFlow } = require('imapflow');
    return new ImapFlow({
      host: integration.imap.host,
      port: integration.imap.port,
      secure: integration.imap.secure,
      auth: { user: integration.imap.user, pass: imapPass },
      logger: false,
      tls: { rejectUnauthorized: false, minVersion: 'TLSv1.2' },
      socketTimeout: 120000,
      greetingTimeout: 120000,
      connectionTimeout: 120000,
    });
  }

  private async connectClient(client: any, timeoutMs = 30000) {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        client.connect(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Connection timeout')), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // Helper: open IMAP connection, run a callback, then disconnect
  private async withImap<T>(
    tenantId: string,
    folder: string,
    fn: (client: any, lock: any, integration: EmailIntegrationDocument) => Promise<T>,
    opts: { integrationId?: string; workspaceId?: string } = {},
  ): Promise<T> {
    const { integration, imapPass } = await this.getImapCredentials(tenantId, opts.integrationId, opts.workspaceId);
    const client = this.createImapClient(integration, imapPass);
    client.on('error', (err) => console.error('[IMAP] Error:', err));
    try {
      await this.connectClient(client);
      const lock = await client.getMailboxLock(folder);
      try {
        return await fn(client, lock, integration);
      } finally {
        lock.release();
      }
    } finally {
      try { if (client.usable) await client.logout(); } catch {}
    }
  }

  // ─── Send ───

  async sendEmail(tenantId: string, dto: SendEmailDto) {
    const integration = await this.emailIntegrationsService.resolveConnected(
      tenantId,
      dto.integrationId,
      dto.workspaceId,
    );

    const smtpPass = this.emailIntegrationsService.decryptSecret(integration.smtp.passEnc);

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host: integration.smtp.host,
      port: integration.smtp.port,
      secure: integration.smtp.secure,
      auth: { user: integration.smtp.user, pass: smtpPass },
    });

    const mailOptions: any = {
      from: integration.smtp.fromAddress
        ? `${integration.smtp.fromName || integration.smtp.user} <${integration.smtp.fromAddress}>`
        : integration.smtp.user,
      to: dto.to.map((r) => (r.name ? `${r.name} <${r.address}>` : r.address)),
      subject: dto.subject,
      text: dto.textBody,
      html: dto.htmlBody,
    };

    if (dto.cc?.length) {
      mailOptions.cc = dto.cc.map((r) => (r.name ? `${r.name} <${r.address}>` : r.address));
    }
    if (dto.bcc?.length) {
      mailOptions.bcc = dto.bcc.map((r) => (r.name ? `${r.name} <${r.address}>` : r.address));
    }
    if (dto.inReplyTo) {
      mailOptions.inReplyTo = dto.inReplyTo;
    }
    if (dto.references?.length) {
      mailOptions.references = dto.references;
    }
    if (dto.attachments?.length) {
      mailOptions.attachments = dto.attachments.map((att) => ({
        filename: att.filename,
        content: Buffer.from(att.content, 'base64'),
        contentType: att.contentType,
      }));
    }

    const info = await transporter.sendMail(mailOptions);

    // Append to IMAP Sent folder so it appears on the mail server
    let sentPath = 'Sent';
    try {
      const imapPass = this.emailIntegrationsService.decryptSecret(integration.imap.passEnc);
      const client = this.createImapClient(integration, imapPass);
      client.on('error', () => {});
      await this.connectClient(client, 15000);

      // Find Sent folder path
      const mailboxes = await client.list();
      const sentMb = mailboxes.find((mb: any) => mb.specialUse === '\\Sent');
      sentPath = sentMb?.path || 'Sent';

      // Build raw message for IMAP APPEND (default export, not named)
      const MailComposer = require('nodemailer/lib/mail-composer');
      const composer = new MailComposer(mailOptions);
      const rawMsg: Buffer = await new Promise((resolve, reject) => {
        composer.compile().build((err: any, msg: Buffer) => {
          if (err) reject(err); else resolve(msg);
        });
      });

      await client.append(sentPath, rawMsg, ['\\Seen']);
      try { if (client.usable) await client.logout(); } catch {}
    } catch (err: any) {
      console.error('[Email] Failed to append to IMAP Sent:', err?.message);
    }

    // Save locally with the correct Sent folder path
    const sentMessage = new this.emailModel({
      tenantId: new Types.ObjectId(tenantId),
      workspaceId: dto.workspaceId ? new Types.ObjectId(dto.workspaceId) : integration.workspaceId,
      integrationId: integration._id,
      messageId: `local_${info.messageId || Date.now()}`,
      folder: sentPath,
      from: { address: integration.smtp.fromAddress || integration.smtp.user, name: integration.smtp.fromName },
      to: dto.to,
      cc: dto.cc || [],
      bcc: dto.bcc || [],
      subject: dto.subject,
      textBody: dto.textBody,
      htmlBody: dto.htmlBody,
      date: new Date(),
      isRead: true,
      inReplyTo: dto.inReplyTo,
      references: dto.references || [],
    });
    await sentMessage.save();

    this.eventsGateway.emitToTenant(tenantId, 'email.sent', {
      integrationId: integration._id.toString(),
      workspaceId: integration.workspaceId?.toString(),
    });

    return { success: true, messageId: info.messageId, integrationId: integration._id.toString() };
  }

  // ─── Sync ───

  /**
   * Sync one folder of one mailbox. The mailbox lock for `folderPath` must be held by the caller.
   * Everything (lookups, flag updates, deletions) is scoped to the mailbox, so several mailboxes
   * of the same agency never touch each other's messages.
   */
  private async syncOneFolder(
    client: any,
    tenantId: string,
    integration: EmailIntegrationDocument,
    folderPath: string,
    limit: number,
    emitEach: boolean,
  ) {
    const integrationId = integration._id as Types.ObjectId;
    const scope = { tenantId: new Types.ObjectId(tenantId), integrationId, folder: folderPath };

    const status = await client.status(folderPath, { messages: true });
    const total = status.messages || 0;

    if (total === 0) {
      // Empty folder on the server: drop local leftovers of this mailbox only
      const orphans = await this.emailModel.deleteMany(scope);
      return { folder: folderPath, synced: 0, flagsUpdated: 0, removed: orphans.deletedCount };
    }

    const syncLimit = Math.min(limit, 50);
    const fetchRange = total > syncLimit ? `${total - syncLimit + 1}:*` : '1:*';

    // PASS 1: envelopes + flags
    const fetched: any[] = [];
    for await (const msg of client.fetch(fetchRange, {
      envelope: true, uid: true, flags: true, internalDate: true,
    }, { uid: true })) {
      fetched.push(msg);
    }

    const serverUids = new Set<string>(fetched.map((m) => String(m.uid)));
    const existingDocs = await this.emailModel
      .find({ ...scope, messageId: { $in: [...serverUids] } })
      .select('messageId isRead isFlagged')
      .lean();
    const existingByUid = new Map(existingDocs.map((d) => [d.messageId, d]));

    const newMsgMeta: any[] = [];
    const flagUpdates: { uid: string; isRead: boolean; isFlagged: boolean }[] = [];
    for (const msg of fetched) {
      const uid = String(msg.uid);
      const existing = existingByUid.get(uid);
      if (!existing) {
        newMsgMeta.push({ uid: msg.uid, envelope: msg.envelope, flags: msg.flags, internalDate: msg.internalDate });
      } else {
        const serverRead = msg.flags?.has('\\Seen') || false;
        const serverFlagged = msg.flags?.has('\\Flagged') || false;
        if (existing.isRead !== serverRead || existing.isFlagged !== serverFlagged) {
          flagUpdates.push({ uid, isRead: serverRead, isFlagged: serverFlagged });
        }
      }
    }

    for (const upd of flagUpdates) {
      await this.emailModel.updateOne(
        { ...scope, messageId: upd.uid },
        { isRead: upd.isRead, isFlagged: upd.isFlagged },
      );
    }

    // Remove local emails deleted on the server (only within the fetched UID range)
    const minFetchedUid = serverUids.size > 0
      ? Math.min(...[...serverUids].map(Number).filter((n) => !isNaN(n)))
      : 0;

    const localEmails = await this.emailModel.find(scope).select('messageId').lean();
    const toDelete = localEmails.filter((e) => {
      // Never delete locally-created emails (from sendEmail)
      if (e.messageId.startsWith('local_')) return false;
      const uidNum = Number(e.messageId);
      if (isNaN(uidNum) || uidNum < minFetchedUid) return false;
      return !serverUids.has(e.messageId);
    });
    if (toDelete.length > 0) {
      await this.emailModel.deleteMany({ _id: { $in: toDelete.map((e) => e._id) } });
    }

    // Replace local_ entries (our own sent copy) once the real IMAP version arrives
    for (const meta of newMsgMeta) {
      const localDup = await this.emailModel.findOne({
        ...scope,
        messageId: { $regex: /^local_/ },
        subject: meta.envelope?.subject || '(No Subject)',
      });
      if (localDup) {
        await this.emailModel.deleteOne({ _id: localDup._id });
      }
    }

    // PASS 2: download new messages
    const { simpleParser } = require('mailparser');
    let savedCount = 0;

    for (const meta of newMsgMeta) {
      let textBody = '';
      let htmlBody = '';
      try {
        const dl = await client.download(String(meta.uid), undefined, { uid: true });
        const chunks: Buffer[] = [];
        for await (const chunk of dl.content) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const parsed = await simpleParser(Buffer.concat(chunks));
        textBody = (parsed.text || '').trim();
        htmlBody = (parsed.html || '').toString().trim();
      } catch (err: any) {
        console.error(`[Email Parse] ${folderPath} UID ${meta.uid} error:`, err?.message);
      }

      const doc = new this.emailModel({
        tenantId: new Types.ObjectId(tenantId),
        workspaceId: integration.workspaceId,
        integrationId,
        messageId: String(meta.uid),
        folder: folderPath,
        from: {
          address: meta.envelope?.from?.[0]?.address || 'unknown',
          name: meta.envelope?.from?.[0]?.name || '',
        },
        to: (meta.envelope?.to || []).map((t: any) => ({ address: t.address, name: t.name })),
        cc: (meta.envelope?.cc || []).map((t: any) => ({ address: t.address, name: t.name })),
        subject: meta.envelope?.subject || '(No Subject)',
        textBody,
        htmlBody,
        date: meta.internalDate || new Date(),
        isRead: meta.flags?.has('\\Seen') || false,
        isFlagged: meta.flags?.has('\\Flagged') || false,
        inReplyTo: meta.envelope?.inReplyTo,
        references: meta.envelope?.references || [],
      });

      try {
        await doc.save();
      } catch (err: any) {
        // Duplicate key: another sync run stored it first. Safe to skip.
        if (err?.code === 11000) continue;
        throw err;
      }
      savedCount++;
      if (emitEach) this.eventsGateway.emitToTenant(tenantId, 'email.received', doc);
    }

    if (savedCount > 0 || flagUpdates.length > 0 || toDelete.length > 0) {
      this.logger.log(`[IMAP Sync] ${integration.emailAddress} ${folderPath}: +${savedCount} new, ${flagUpdates.length} flags, -${toDelete.length} removed`);
    }

    return { folder: folderPath, synced: savedCount, flagsUpdated: flagUpdates.length, removed: toDelete.length };
  }

  async syncFolder(
    tenantId: string,
    folder = 'INBOX',
    limit = 50,
    integrationId?: string,
    workspaceId?: string,
  ) {
    return this.withImap(
      tenantId,
      folder,
      (client, _lock, integration) => this.syncOneFolder(client, tenantId, integration, folder, limit, true),
      { integrationId, workspaceId },
    );
  }

  /**
   * Sync ALL IMAP folders of ONE mailbox in a single connection.
   */
  async syncAllFolders(tenantId: string, limit = 50, integrationId?: string, workspaceId?: string) {
    const { integration, imapPass } = await this.getImapCredentials(tenantId, integrationId, workspaceId);
    const mailboxId = integration._id.toString();

    if (this.syncing.has(mailboxId)) {
      return { folders: [], totalSynced: 0, skipped: true, integrationId: mailboxId };
    }
    this.syncing.add(mailboxId);

    const client = this.createImapClient(integration, imapPass);
    client.on('error', (err) => console.error('[IMAP] Error:', err));

    try {
      await this.connectClient(client);

      // 1. List all real mailboxes from the server
      const mailboxes = await client.list();
      this.mailboxCache.set(mailboxId, { at: Date.now(), list: mailboxes });
      const folderPaths = mailboxes.map((mb: any) => mb.path as string).filter((p: string) => !!p);

      // Clean up emails of THIS mailbox stored under folder names that no longer exist
      const orphaned = await this.emailModel.deleteMany({
        tenantId: new Types.ObjectId(tenantId),
        integrationId: integration._id,
        folder: { $nin: folderPaths },
      });
      if (orphaned.deletedCount > 0) {
        this.logger.log(`[IMAP SyncAll] ${integration.emailAddress}: cleaned ${orphaned.deletedCount} emails with non-existent folders`);
      }

      const results: { folder: string; synced: number; flagsUpdated: number; removed: number }[] = [];

      // 2. Sync each folder sequentially using the same connection
      for (const folderPath of folderPaths) {
        try {
          const lock = await client.getMailboxLock(folderPath);
          try {
            results.push(await this.syncOneFolder(client, tenantId, integration, folderPath, limit, false));
          } finally {
            lock.release();
          }
        } catch (err: any) {
          console.error(`[IMAP SyncAll] Error syncing ${integration.emailAddress} ${folderPath}:`, err?.message);
          results.push({ folder: folderPath, synced: 0, flagsUpdated: 0, removed: 0 });
        }
      }

      const totalSynced = results.reduce((s, r) => s + r.synced, 0);
      await this.emailIntegrationsService.recordSync(mailboxId, null);

      if (totalSynced > 0) {
        const workspaceId = integration.workspaceId?.toString();
        const unreadCount = await this.getUnreadCount(tenantId, workspaceId);
        this.eventsGateway.emitToTenant(tenantId, 'email.sync.complete', {
          newEmails: totalSynced,
          unreadCount,
          workspaceId,
          integrationId: mailboxId,
          accountLabel: integration.label || integration.emailAddress,
        });
      }

      return { folders: results, totalSynced, integrationId: mailboxId };
    } catch (error: any) {
      this.logger.error(`[IMAP SyncAll] ${integration.emailAddress}: ${error.message}`);
      await this.emailIntegrationsService.recordSync(mailboxId, error.message);
      throw new Error(`Error de sincronización IMAP (${integration.emailAddress}): ${error.message}`);
    } finally {
      this.syncing.delete(mailboxId);
      try { if (client.usable) await client.logout(); } catch {}
    }
  }

  /** Sync every connected mailbox of the agency. One failing mailbox never blocks the others. */
  async syncAllAccounts(tenantId: string, limit = 50, workspaceId?: string) {
    const accounts = await this.emailIntegrationsService.findConnectedByTenant(tenantId, workspaceId);
    const results: any[] = [];
    let totalSynced = 0;

    for (const account of accounts) {
      const id = account._id.toString();
      try {
        const r = await this.syncAllFolders(tenantId, limit, id, workspaceId);
        totalSynced += r.totalSynced;
        results.push({ integrationId: id, emailAddress: account.emailAddress, totalSynced: r.totalSynced, ok: true });
      } catch (e: any) {
        results.push({ integrationId: id, emailAddress: account.emailAddress, totalSynced: 0, ok: false, error: e.message });
      }
    }
    return { accounts: results, totalSynced };
  }

  // ─── Purge / delete-all ───

  // Delete synced emails (of one mailbox, or the whole agency) so a re-sync fetches fresh content
  async purgeEmails(tenantId: string, workspaceId?: string, integrationId?: string) {
    const result = await this.emailModel.deleteMany(this.buildQuery(tenantId, workspaceId, integrationId));
    this.logger.log(`[Purge] Deleted ${result.deletedCount} emails for tenant ${tenantId}${integrationId ? ` mailbox ${integrationId}` : ''}`);
    return { deleted: result.deletedCount };
  }

  async deleteAllForIntegration(tenantId: string, integrationId: string): Promise<number> {
    const result = await this.emailModel.deleteMany({
      tenantId: new Types.ObjectId(tenantId),
      integrationId: new Types.ObjectId(integrationId),
    });
    this.mailboxCache.delete(integrationId);
    return result.deletedCount;
  }

  // ─── Read ───

  async listEmails(
    tenantId: string,
    folder = 'INBOX',
    page = 1,
    limit = 50,
    workspaceId?: string,
    integrationId?: string,
  ) {
    const skip = (page - 1) * limit;
    const query = { ...this.buildQuery(tenantId, workspaceId, integrationId), folder };

    const docs = await this.emailModel
      .find(query)
      .sort({ date: -1 })
      .skip(skip)
      .limit(limit)
      .exec();

    // Build lightweight list with preview — strip htmlBody to avoid sending huge payloads
    const emails = docs.map((d) => {
      const obj: any = d.toObject();
      // Preview: prefer textBody, fallback to stripped HTML
      let preview = (obj.textBody || '').replace(/\s+/g, ' ').trim();
      if (!preview && obj.htmlBody) {
        preview = obj.htmlBody
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
      }
      obj.preview = preview.slice(0, 160);
      delete obj.htmlBody;
      delete obj.textBody;
      return obj;
    });

    const total = await this.emailModel.countDocuments(query);

    return { emails, total, page, limit };
  }

  async getEmail(tenantId: string, id: string, workspaceId?: string) {
    return this.emailModel.findOne({
      _id: new Types.ObjectId(id),
      ...this.buildQuery(tenantId, workspaceId),
    });
  }

  async markAsRead(tenantId: string, id: string, isRead = true, workspaceId?: string) {
    const email = await this.emailModel.findOneAndUpdate(
      { _id: id, ...this.buildQuery(tenantId, workspaceId) },
      { isRead },
      { returnDocument: 'after' },
    );

    if (!email) {
      throw new NotFoundException('Email not found');
    }

    // Propagate read/unread flag to the IMAP server of the mailbox that owns the message
    try {
      await this.withImap(tenantId, email.folder, async (client) => {
        if (isRead) {
          await client.messageFlagsAdd(email.messageId, ['\\Seen'], { uid: true });
        } else {
          await client.messageFlagsRemove(email.messageId, ['\\Seen'], { uid: true });
        }
      }, { integrationId: email.integrationId?.toString(), workspaceId });
    } catch (err: any) {
      console.error(`[IMAP] Failed to update read flag on server:`, err?.message);
      // Don't throw — local update succeeded, server sync is best-effort
    }

    this.eventsGateway.emitToTenant(tenantId, 'email.updated', email);

    return email;
  }

  // Find the Trash folder IMAP path from server
  private async findTrashPath(client: any): Promise<string | null> {
    try {
      const mailboxes = await client.list();
      const trash = mailboxes.find((mb: any) => mb.specialUse === '\\Trash');
      return trash?.path || null;
    } catch {
      return null;
    }
  }

  async deleteEmail(tenantId: string, id: string, workspaceId?: string) {
    const email = await this.emailModel.findOne({
      _id: id,
      ...this.buildQuery(tenantId, workspaceId),
    });

    if (!email) {
      throw new NotFoundException('Email not found');
    }

    let creds: { integration: EmailIntegrationDocument; imapPass: string };
    try {
      creds = await this.getImapCredentials(tenantId, email.integrationId?.toString(), workspaceId);
    } catch {
      // Mailbox disconnected/removed: nothing to do on the server, drop the local copy
      await this.emailModel.deleteOne({ _id: id });
      this.eventsGateway.emitToTenant(tenantId, 'email.deleted', { id });
      return { success: true };
    }

    const client = this.createImapClient(creds.integration, creds.imapPass);
    client.on('error', (err) => console.error('[IMAP] Error:', err));

    try {
      await this.connectClient(client);

      const trashPath = await this.findTrashPath(client);
      const isAlreadyInTrash = trashPath && email.folder === trashPath;

      const lock = await client.getMailboxLock(email.folder);
      try {
        if (isAlreadyInTrash || !trashPath) {
          // Already in Trash or no Trash folder → permanently delete
          await client.messageFlagsAdd(email.messageId, ['\\Deleted'], { uid: true });
          await client.messageDelete(email.messageId, { uid: true });
          await this.emailModel.deleteOne({ _id: id });
          this.eventsGateway.emitToTenant(tenantId, 'email.deleted', { id });
        } else {
          // Move to Trash on IMAP server
          await client.messageMove(email.messageId, trashPath, { uid: true });

          const fromFolder = email.folder;
          // Update local document immediately to show in Trash folder
          email.folder = trashPath;
          await email.save();

          this.eventsGateway.emitToTenant(tenantId, 'email.deleted', { id, oldFolder: fromFolder });
          this.eventsGateway.emitToTenant(tenantId, 'email.moved', {
            id,
            email: email.toObject(),
            fromFolder,
            toFolder: trashPath,
            integrationId: email.integrationId?.toString(),
          });
        }
      } finally {
        lock.release();
      }
    } catch (err: any) {
      console.error(`[IMAP] Failed to delete/move on server:`, err?.message);
      // Fallback: just remove locally
      await this.emailModel.deleteOne({ _id: id });
      this.eventsGateway.emitToTenant(tenantId, 'email.deleted', { id });
    } finally {
      try { if (client.usable) await client.logout(); } catch {}
    }

    return { success: true };
  }

  async bulkDelete(tenantId: string, ids: string[], workspaceId?: string) {
    if (!ids?.length) return { deleted: 0 };

    const emails = await this.emailModel.find({
      _id: { $in: ids.map((id) => new Types.ObjectId(id)) },
      ...this.buildQuery(tenantId, workspaceId),
    });
    if (!emails.length) return { deleted: 0 };

    // Group by mailbox: each mailbox needs its own IMAP connection
    const byMailbox = new Map<string, EmailMessageDocument[]>();
    for (const email of emails) {
      const key = email.integrationId?.toString() || '';
      byMailbox.set(key, [...(byMailbox.get(key) || []), email]);
    }

    const movedEvents: { id: string; email: any; toFolder: string }[] = [];
    const deletedIds: string[] = [];
    let movedCount = 0;

    for (const [mailboxKey, group] of byMailbox.entries()) {
      let creds: { integration: EmailIntegrationDocument; imapPass: string } | null = null;
      try {
        creds = await this.getImapCredentials(tenantId, mailboxKey || undefined, workspaceId);
      } catch {
        // Mailbox no longer connected: just drop the local copies
        deletedIds.push(...group.map((e) => e._id.toString()));
        continue;
      }

      const client = this.createImapClient(creds.integration, creds.imapPass);
      client.on('error', (err) => console.error('[IMAP] Error:', err));

      try {
        await this.connectClient(client);
        const trashPath = await this.findTrashPath(client);

        const byFolder = new Map<string, EmailMessageDocument[]>();
        for (const e of group) byFolder.set(e.folder, [...(byFolder.get(e.folder) || []), e]);

        for (const [folder, folderEmails] of byFolder.entries()) {
          const inTrash = !!trashPath && folder === trashPath;
          try {
            const lock = await client.getMailboxLock(folder);
            try {
              for (const email of folderEmails) {
                try {
                  if (inTrash || !trashPath) {
                    await client.messageFlagsAdd(email.messageId, ['\\Deleted'], { uid: true });
                    await client.messageDelete(email.messageId, { uid: true });
                    deletedIds.push(email._id.toString());
                  } else {
                    await client.messageMove(email.messageId, trashPath, { uid: true });
                    await this.emailModel.updateOne({ _id: email._id }, { $set: { folder: trashPath } });
                    email.folder = trashPath;
                    movedEvents.push({ id: email._id.toString(), email: email.toObject(), toFolder: trashPath });
                    movedCount++;
                  }
                } catch {}
              }
            } finally {
              lock.release();
            }
          } catch (err: any) {
            console.error(`[IMAP] Bulk delete error for folder ${folder}:`, err?.message);
          }
        }
      } catch (err: any) {
        console.error(`[IMAP] Bulk delete connection error:`, err?.message);
      } finally {
        try { if (client.usable) await client.logout(); } catch {}
      }
    }

    for (const ev of movedEvents) {
      this.eventsGateway.emitToTenant(tenantId, 'email.deleted', { id: ev.id });
      this.eventsGateway.emitToTenant(tenantId, 'email.moved', ev);
    }

    // Permanently delete emails that were in Trash (or whose mailbox is gone)
    if (deletedIds.length > 0) {
      await this.emailModel.deleteMany({ _id: { $in: deletedIds.map((id) => new Types.ObjectId(id)) } });
      for (const id of deletedIds) {
        this.eventsGateway.emitToTenant(tenantId, 'email.deleted', { id });
      }
    }

    return { deleted: movedCount + deletedIds.length };
  }

  // ─── Folders ───

  private async listMailboxes(integration: EmailIntegrationDocument, imapPass: string): Promise<any[]> {
    const key = integration._id.toString();
    const cached = this.mailboxCache.get(key);
    if (cached && Date.now() - cached.at < MAILBOX_CACHE_TTL_MS) return cached.list;

    const client = this.createImapClient(integration, imapPass);
    client.on('error', () => {});
    try {
      await this.connectClient(client, 15000);
      const list = await client.list();
      this.mailboxCache.set(key, { at: Date.now(), list });
      return list;
    } finally {
      try { if (client.usable) await client.logout(); } catch {}
    }
  }

  private async localFolderCounts(tenantId: string, workspaceId?: string, integrationId?: string) {
    return this.emailModel.aggregate([
      { $match: this.buildQuery(tenantId, workspaceId, integrationId) },
      {
        $group: {
          _id: '$folder',
          count: { $sum: 1 },
          unread: { $sum: { $cond: ['$isRead', 0, 1] } },
        },
      },
    ]);
  }

  /**
   * Folders of one mailbox (`integrationId`), or — without it — the unified inbox that merges the
   * INBOX of every mailbox of the agency (folder names are provider specific, so only INBOX is merged).
   */
  async getFolders(tenantId: string, workspaceId?: string, integrationId?: string) {
    if (!integrationId) {
      const counts = await this.emailModel.aggregate([
        { $match: { ...this.buildQuery(tenantId, workspaceId), folder: 'INBOX' } },
        { $group: { _id: null, count: { $sum: 1 }, unread: { $sum: { $cond: ['$isRead', 0, 1] } } } },
      ]);
      return [{
        name: 'INBOX',
        path: 'INBOX',
        specialUse: null,
        count: counts[0]?.count || 0,
        unread: counts[0]?.unread || 0,
      }];
    }

    // Real IMAP folders of the mailbox (cached), with local counts
    try {
      const { integration, imapPass } = await this.getImapCredentials(tenantId, integrationId, workspaceId);
      const mailboxes = await this.listMailboxes(integration, imapPass);

      const localCounts = await this.localFolderCounts(tenantId, workspaceId, integrationId);
      const countMap = new Map(localCounts.map((c) => [c._id, { count: c.count, unread: c.unread }]));

      const folders = mailboxes.map((mb: any) => {
        const path = mb.path || mb.name;
        const displayName = STANDARD_NAMES[(mb.name || '').toLowerCase()] || mb.name || path;
        const counts = countMap.get(path) || countMap.get(displayName) || { count: 0, unread: 0 };
        return {
          name: displayName,
          path,
          specialUse: mb.specialUse || null,
          count: counts.count,
          unread: counts.unread,
        };
      });

      // Sort: INBOX first, then alphabetically
      folders.sort((a: any, b: any) => {
        if (a.path === 'INBOX') return -1;
        if (b.path === 'INBOX') return 1;
        return a.name.localeCompare(b.name);
      });

      return folders;
    } catch (err: any) {
      console.error('[IMAP Folders] Failed to fetch from server, falling back to local:', err?.message);
      const folders = await this.localFolderCounts(tenantId, workspaceId, integrationId);
      folders.sort((a, b) => String(a._id).localeCompare(String(b._id)));
      return folders.map((f) => ({
        name: f._id,
        path: f._id,
        specialUse: null,
        count: f.count,
        unread: f.unread,
      }));
    }
  }

  // ─── Unread counters ───

  async getUnreadCount(tenantId: string, workspaceId?: string, integrationId?: string) {
    return this.emailModel.countDocuments({
      ...this.buildQuery(tenantId, workspaceId, integrationId),
      folder: 'INBOX',
      isRead: false,
    });
  }

  /** INBOX unread messages per mailbox: { [integrationId]: n } */
  async getUnreadByIntegration(tenantId: string): Promise<Record<string, number>> {
    const rows = await this.emailModel.aggregate([
      { $match: { tenantId: new Types.ObjectId(tenantId), folder: 'INBOX', isRead: false, integrationId: { $ne: null } } },
      { $group: { _id: '$integrationId', unread: { $sum: 1 } } },
    ]);
    return Object.fromEntries(rows.map((r) => [r._id.toString(), r.unread]));
  }

  // ─── Auto-sync: one loop per mailbox ───

  startAutoSync(integrationId: string, tenantId: string, initialDelayMs = 5000) {
    // Clear existing loop of this mailbox if any
    this.stopAutoSync(integrationId);

    const run = async (label: string) => {
      try {
        const result: any = await this.syncAllFolders(tenantId, 50, integrationId);
        if (!result.skipped && result.totalSynced > 0) {
          this.logger.log(`[Auto-Sync] ${label} ${integrationId}: ${result.totalSynced} new emails`);
        }
      } catch (error: any) {
        // Mailbox disconnected or deleted meanwhile: stop its loop
        if (error instanceof BadRequestException) {
          this.stopAutoSync(integrationId);
          return;
        }
        console.error(`[Auto-Sync] ${integrationId}:`, error.message);
      }
    };

    // Initial sync shortly after start, then periodically
    const initial = setTimeout(() => run('initial'), initialDelayMs);
    const interval = setInterval(() => run('periodic'), AUTO_SYNC_INTERVAL_MS);

    // Keep a single handle that clears both timers
    const handle: any = interval;
    handle.__initial = initial;
    this.syncIntervals.set(integrationId, handle);
    this.logger.log(`[Auto-Sync] Started for mailbox ${integrationId}`);
  }

  stopAutoSync(integrationId: string) {
    const handle: any = this.syncIntervals.get(integrationId);
    if (handle) {
      clearInterval(handle);
      if (handle.__initial) clearTimeout(handle.__initial);
      this.syncIntervals.delete(integrationId);
      this.mailboxCache.delete(integrationId);
      this.logger.log(`[Auto-Sync] Stopped for mailbox ${integrationId}`);
    }
  }

  // Initialize auto-sync for every connected mailbox on startup (staggered to avoid a connection burst)
  async initAutoSyncForAllTenants() {
    try {
      const mailboxes = await this.emailIntegrationsService.findConnectedIds();
      mailboxes.forEach((m, i) => this.startAutoSync(m.id, m.tenantId, 2000 + i * 2000));
      this.logger.log(`[Auto-Sync] Initialized for ${mailboxes.length} mailbox(es)`);
    } catch (error) {
      console.error('[Auto-Sync] Init error:', error);
    }
  }
}
