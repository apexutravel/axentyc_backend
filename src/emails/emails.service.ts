import { Injectable, NotFoundException, BadRequestException, OnModuleInit, Inject, forwardRef } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { EmailMessage, EmailMessageDocument } from './entities/email-message.entity';
import { SendEmailDto } from './dto/send-email.dto';
import { EmailIntegrationsService } from '../integrations/email-integrations.service';
import { EventsGateway } from '../events/events.gateway';

@Injectable()
export class EmailsService implements OnModuleInit {
  private syncIntervals: Map<string, NodeJS.Timeout> = new Map();

  constructor(
    @InjectModel(EmailMessage.name)
    private emailModel: Model<EmailMessageDocument>,
    @Inject(forwardRef(() => EmailIntegrationsService))
    private emailIntegrationsService: EmailIntegrationsService,
    private eventsGateway: EventsGateway,
  ) {}

  async onModuleInit() {
    // Initialize auto-sync for all connected tenants on startup
    setTimeout(() => this.initAutoSyncForAllTenants(), 5000); // Wait 5s for app to fully start
  }

  async sendEmail(tenantId: string, dto: SendEmailDto) {
    const integration = await this.emailIntegrationsService['emailModel'].findOne({
      tenantId: new Types.ObjectId(tenantId),
      status: 'connected',
    });

    if (!integration) {
      throw new BadRequestException('Email integration not configured');
    }

    const smtpPass = this.emailIntegrationsService['decryptSecret'](integration.smtp.passEnc);

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
      const imapPass = this.emailIntegrationsService['decryptSecret'](integration.imap.passEnc);
      const client = this.createImapClient(integration, imapPass);
      client.on('error', () => {});
      await Promise.race([
        client.connect(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 15000)),
      ]);

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
      console.log(`[Email] ✅ Sent email appended to IMAP ${sentPath}`);
      try { if (client.usable) await client.logout(); } catch {}
    } catch (err: any) {
      console.error('[Email] ❌ Failed to append to IMAP Sent:', err?.message);
    }

    // Save locally with the correct Sent folder path
    const sentMessage = new this.emailModel({
      tenantId: new Types.ObjectId(tenantId),
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

    this.eventsGateway.emitToTenant(tenantId, 'email.sent', {});

    return { success: true, messageId: info.messageId };
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

  // Helper: get integration + decrypted IMAP password for a tenant
  private async getImapCredentials(tenantId: string) {
    const integration = await this.emailIntegrationsService['emailModel'].findOne({
      tenantId: new Types.ObjectId(tenantId),
      status: 'connected',
    });
    if (!integration) throw new BadRequestException('Email integration not configured');
    const imapPass = this.emailIntegrationsService['decryptSecret'](integration.imap.passEnc);
    return { integration, imapPass };
  }

  // Helper: open IMAP connection, run a callback, then disconnect
  private async withImap<T>(tenantId: string, folder: string, fn: (client: any, lock: any) => Promise<T>): Promise<T> {
    const { integration, imapPass } = await this.getImapCredentials(tenantId);
    const client = this.createImapClient(integration, imapPass);
    client.on('error', (err) => console.error('[IMAP] Error:', err));
    try {
      await Promise.race([
        client.connect(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Connection timeout')), 30000)),
      ]);
      const lock = await client.getMailboxLock(folder);
      try {
        return await fn(client, lock);
      } finally {
        lock.release();
      }
    } finally {
      try { if (client.usable) await client.logout(); } catch {}
    }
  }

  async syncFolder(tenantId: string, folder = 'INBOX', limit = 50) {
    const { integration } = await this.getImapCredentials(tenantId);
    console.log(`[IMAP Sync] Syncing ${folder} for ${integration.imap.user}`);

    return this.withImap(tenantId, folder, async (client) => {
      const status = await client.status(folder, { messages: true });
      const total = status.messages || 0;
      const syncLimit = Math.min(limit, 50);
      const fetchRange = total > syncLimit ? `${total - syncLimit + 1}:*` : '1:*';

      console.log(`[IMAP Sync] Mailbox has ${total} messages, checking last ${Math.min(total, syncLimit)}`);

      // PASS 1: Collect all server UIDs + flags, detect new vs existing
      const serverUids = new Set<string>();
      const newMsgMeta: any[] = [];
      const flagUpdates: { uid: string; isRead: boolean; isFlagged: boolean }[] = [];

      for await (const msg of client.fetch(fetchRange, {
        envelope: true,
        uid: true,
        flags: true,
        internalDate: true,
      }, { uid: true })) {
        const uid = String(msg.uid);
        serverUids.add(uid);

        const existing = await this.emailModel.findOne({
          tenantId: new Types.ObjectId(tenantId),
          messageId: uid,
          folder,
        });

        if (!existing) {
          newMsgMeta.push({
            uid: msg.uid,
            envelope: msg.envelope,
            flags: msg.flags,
            internalDate: msg.internalDate,
          });
        } else {
          // Sync flags from server → local
          const serverRead = msg.flags?.has('\\Seen') || false;
          const serverFlagged = msg.flags?.has('\\Flagged') || false;
          if (existing.isRead !== serverRead || existing.isFlagged !== serverFlagged) {
            flagUpdates.push({ uid, isRead: serverRead, isFlagged: serverFlagged });
          }
        }
      }

      // Update flags of existing emails
      for (const upd of flagUpdates) {
        await this.emailModel.updateOne(
          { tenantId: new Types.ObjectId(tenantId), messageId: upd.uid, folder },
          { isRead: upd.isRead, isFlagged: upd.isFlagged },
        );
      }
      if (flagUpdates.length > 0) {
        console.log(`[IMAP Sync] Updated flags for ${flagUpdates.length} existing messages`);
      }

      // Remove locally stored emails that no longer exist on server (only within fetched UID range)
      const minFetchedUid = serverUids.size > 0
        ? Math.min(...[...serverUids].map(Number).filter(n => !isNaN(n)))
        : 0;

      const localEmails = await this.emailModel.find({
        tenantId: new Types.ObjectId(tenantId),
        folder,
      }).select('messageId').lean();

      const toDelete = localEmails.filter(e => {
        if (e.messageId.startsWith('local_')) return false;
        const uidNum = Number(e.messageId);
        if (isNaN(uidNum) || uidNum < minFetchedUid) return false;
        return !serverUids.has(e.messageId);
      });
      if (toDelete.length > 0) {
        await this.emailModel.deleteMany({
          _id: { $in: toDelete.map(e => e._id) },
        });
        console.log(`[IMAP Sync] Removed ${toDelete.length} locally cached emails deleted on server`);
      }

      // Replace local_ entries if we now have the real IMAP version
      for (const meta of newMsgMeta) {
        const localDup = await this.emailModel.findOne({
          tenantId: new Types.ObjectId(tenantId),
          folder,
          messageId: { $regex: /^local_/ },
          subject: meta.envelope?.subject || '(No Subject)',
        });
        if (localDup) {
          await this.emailModel.deleteOne({ _id: localDup._id });
        }
      }

      console.log(`[IMAP Sync] Found ${newMsgMeta.length} new messages to download`);

      // PASS 2: Download full source for each new message
      const { simpleParser } = require('mailparser');
      const saved: EmailMessageDocument[] = [];

      for (const meta of newMsgMeta) {
        let textBody = '';
        let htmlBody = '';

        try {
          const dl = await client.download(String(meta.uid), undefined, { uid: true });
          const chunks: Buffer[] = [];
          for await (const chunk of dl.content) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          const raw = Buffer.concat(chunks);
          console.log(`[Email Parse] UID ${meta.uid}: downloaded ${raw.length} bytes`);

          const parsed = await simpleParser(raw);
          textBody = (parsed.text || '').trim();
          htmlBody = (parsed.html || '').toString().trim();

          console.log(`[Email Parse] UID ${meta.uid}: text=${textBody.length}, html=${htmlBody.length}`);
        } catch (err: any) {
          console.error(`[Email Parse] UID ${meta.uid} error:`, err?.message);
        }

        const doc = new this.emailModel({
          tenantId: new Types.ObjectId(tenantId),
          messageId: String(meta.uid),
          folder,
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

        await doc.save();
        saved.push(doc);
        this.eventsGateway.emitToTenant(tenantId, 'email.received', doc);
      }

      return { synced: saved.length, flagsUpdated: flagUpdates.length, removed: toDelete.length, folder };
    });
  }

  /**
   * Sync ALL IMAP folders in a single connection.
   * Lists real server mailboxes, then syncs each one sequentially.
   */
  async syncAllFolders(tenantId: string, limit = 50) {
    const { integration, imapPass } = await this.getImapCredentials(tenantId);
    const client = this.createImapClient(integration, imapPass);
    client.on('error', (err) => console.error('[IMAP] Error:', err));

    try {
      await Promise.race([
        client.connect(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Connection timeout')), 30000)),
      ]);

      // 1. List all real mailboxes from server
      const mailboxes = await client.list();
      const folderPaths = mailboxes
        .map((mb: any) => mb.path as string)
        .filter((p: string) => !!p);

      console.log(`[IMAP SyncAll] Found ${folderPaths.length} folders: ${folderPaths.join(', ')}`);

      // Clean up emails stored with wrong/old folder names that don't match real IMAP paths
      const pathSet = new Set(folderPaths);
      const orphaned = await this.emailModel.deleteMany({
        tenantId: new Types.ObjectId(tenantId),
        folder: { $nin: folderPaths },
      });
      if (orphaned.deletedCount > 0) {
        console.log(`[IMAP SyncAll] Cleaned up ${orphaned.deletedCount} emails with non-existent folder names`);
      }

      const { simpleParser } = require('mailparser');
      const results: { folder: string; synced: number; flagsUpdated: number; removed: number }[] = [];

      // 2. Sync each folder sequentially using the same connection
      for (const folderPath of folderPaths) {
        try {
          const lock = await client.getMailboxLock(folderPath);
          try {
            const status = await client.status(folderPath, { messages: true });
            const total = status.messages || 0;
            if (total === 0) {
              // Empty folder — clean up any local orphans
              const orphans = await this.emailModel.deleteMany({
                tenantId: new Types.ObjectId(tenantId),
                folder: folderPath,
              });
              if (orphans.deletedCount > 0) {
                console.log(`[IMAP SyncAll] ${folderPath}: empty on server, removed ${orphans.deletedCount} local orphans`);
              }
              results.push({ folder: folderPath, synced: 0, flagsUpdated: 0, removed: orphans.deletedCount });
              continue;
            }

            const syncLimit = Math.min(limit, 50);
            const fetchRange = total > syncLimit ? `${total - syncLimit + 1}:*` : '1:*';

            // PASS 1: envelopes + flags
            const serverUids = new Set<string>();
            const newMsgMeta: any[] = [];
            const flagUpdates: { uid: string; isRead: boolean; isFlagged: boolean }[] = [];

            for await (const msg of client.fetch(fetchRange, {
              envelope: true, uid: true, flags: true, internalDate: true,
            }, { uid: true })) {
              const uid = String(msg.uid);
              serverUids.add(uid);

              const existing = await this.emailModel.findOne({
                tenantId: new Types.ObjectId(tenantId),
                messageId: uid,
                folder: folderPath,
              });

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

            // Update flags
            for (const upd of flagUpdates) {
              await this.emailModel.updateOne(
                { tenantId: new Types.ObjectId(tenantId), messageId: upd.uid, folder: folderPath },
                { isRead: upd.isRead, isFlagged: upd.isFlagged },
              );
            }

            // Remove local emails deleted on server (only within the fetched UID range)
            // If we only fetched last N messages, we can only know about deletions in that range
            const minFetchedUid = serverUids.size > 0
              ? Math.min(...[...serverUids].map(Number).filter(n => !isNaN(n)))
              : 0;

            const localEmails = await this.emailModel.find({
              tenantId: new Types.ObjectId(tenantId),
              folder: folderPath,
            }).select('messageId').lean();

            const toDelete = localEmails.filter(e => {
              // Never delete locally-created emails (from sendEmail)
              if (e.messageId.startsWith('local_')) return false;
              const uidNum = Number(e.messageId);
              // Only delete if UID is within the range we actually checked
              if (isNaN(uidNum) || uidNum < minFetchedUid) return false;
              return !serverUids.has(e.messageId);
            });
            if (toDelete.length > 0) {
              await this.emailModel.deleteMany({ _id: { $in: toDelete.map(e => e._id) } });
            }

            // Replace local_ entries if we now have the real IMAP version
            // (match by subject + date within 60s)
            for (const meta of newMsgMeta) {
              const localDup = await this.emailModel.findOne({
                tenantId: new Types.ObjectId(tenantId),
                folder: folderPath,
                messageId: { $regex: /^local_/ },
                subject: meta.envelope?.subject || '(No Subject)',
              });
              if (localDup) {
                await this.emailModel.deleteOne({ _id: localDup._id });
              }
            }

            // PASS 2: Download new messages
            const saved: EmailMessageDocument[] = [];
            for (const meta of newMsgMeta) {
              let textBody = '';
              let htmlBody = '';
              try {
                const dl = await client.download(String(meta.uid), undefined, { uid: true });
                const chunks: Buffer[] = [];
                for await (const chunk of dl.content) {
                  chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                }
                const raw = Buffer.concat(chunks);
                const parsed = await simpleParser(raw);
                textBody = (parsed.text || '').trim();
                htmlBody = (parsed.html || '').toString().trim();
              } catch (err: any) {
                console.error(`[Email Parse] ${folderPath} UID ${meta.uid} error:`, err?.message);
              }

              const doc = new this.emailModel({
                tenantId: new Types.ObjectId(tenantId),
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

              await doc.save();
              saved.push(doc);
            }

            if (saved.length > 0 || flagUpdates.length > 0 || toDelete.length > 0) {
              console.log(`[IMAP SyncAll] ${folderPath}: +${saved.length} new, ${flagUpdates.length} flags, -${toDelete.length} removed`);
            }

            results.push({
              folder: folderPath,
              synced: saved.length,
              flagsUpdated: flagUpdates.length,
              removed: toDelete.length,
            });
          } finally {
            lock.release();
          }
        } catch (err: any) {
          console.error(`[IMAP SyncAll] Error syncing ${folderPath}:`, err?.message);
          results.push({ folder: folderPath, synced: 0, flagsUpdated: 0, removed: 0 });
        }
      }

      const totalSynced = results.reduce((s, r) => s + r.synced, 0);
      if (totalSynced > 0) {
        const unreadCount = await this.getUnreadCount(tenantId);
        this.eventsGateway.emitToTenant(tenantId, 'email.sync.complete', { newEmails: totalSynced, unreadCount });
      }

      return { folders: results, totalSynced };
    } catch (error: any) {
      console.error('[IMAP SyncAll] Error:', error.message);
      throw new Error(`Error de sincronización IMAP: ${error.message}`);
    } finally {
      try { if (client.usable) await client.logout(); } catch {}
    }
  }

  // Delete all synced emails for a tenant so re-sync fetches fresh content
  async purgeEmails(tenantId: string) {
    const result = await this.emailModel.deleteMany({ tenantId: new Types.ObjectId(tenantId) });
    console.log(`[Purge] Deleted ${result.deletedCount} emails for tenant ${tenantId}`);
    return { deleted: result.deletedCount };
  }

  async listEmails(tenantId: string, folder = 'INBOX', page = 1, limit = 50) {
    const skip = (page - 1) * limit;
    const docs = await this.emailModel
      .find({ tenantId: new Types.ObjectId(tenantId), folder })
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

    const total = await this.emailModel.countDocuments({
      tenantId: new Types.ObjectId(tenantId),
      folder,
    });

    return { emails, total, page, limit };
  }

  async getEmail(tenantId: string, id: string) {
    return this.emailModel.findOne({ _id: new Types.ObjectId(id), tenantId: new Types.ObjectId(tenantId) });
  }

  async markAsRead(tenantId: string, id: string, isRead = true) {
    const email = await this.emailModel.findOneAndUpdate(
      { _id: id, tenantId: new Types.ObjectId(tenantId) },
      { isRead },
      { returnDocument: 'after' },
    );

    if (!email) {
      throw new NotFoundException('Email not found');
    }

    // Propagate read/unread flag to IMAP server
    try {
      await this.withImap(tenantId, email.folder, async (client) => {
        if (isRead) {
          await client.messageFlagsAdd(email.messageId, ['\\Seen'], { uid: true });
        } else {
          await client.messageFlagsRemove(email.messageId, ['\\Seen'], { uid: true });
        }
        console.log(`[IMAP] UID ${email.messageId}: ${isRead ? 'marked read' : 'marked unread'} on server`);
      });
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

  async deleteEmail(tenantId: string, id: string) {
    const email = await this.emailModel.findOne({
      _id: id,
      tenantId: new Types.ObjectId(tenantId),
    });

    if (!email) {
      throw new NotFoundException('Email not found');
    }

    const { integration, imapPass } = await this.getImapCredentials(tenantId);
    const client = this.createImapClient(integration, imapPass);
    client.on('error', (err) => console.error('[IMAP] Error:', err));

    try {
      await Promise.race([
        client.connect(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Connection timeout')), 30000)),
      ]);

      const trashPath = await this.findTrashPath(client);

      const isAlreadyInTrash = trashPath && email.folder === trashPath;

      const lock = await client.getMailboxLock(email.folder);
      try {
        if (isAlreadyInTrash || !trashPath) {
          // Already in Trash or no Trash folder → permanently delete
          await client.messageFlagsAdd(email.messageId, ['\\Deleted'], { uid: true });
          await client.messageDelete(email.messageId, { uid: true });
          console.log(`[IMAP] UID ${email.messageId}: permanently deleted from ${email.folder}`);
          await this.emailModel.deleteOne({ _id: id });
          this.eventsGateway.emitToTenant(tenantId, 'email.deleted', { id });
        } else {
          // Move to Trash on IMAP server
          await client.messageMove(email.messageId, trashPath, { uid: true });
          console.log(`[IMAP] UID ${email.messageId}: moved from ${email.folder} to ${trashPath}`);
          
          // Update local document immediately to show in Trash folder
          email.folder = trashPath;
          await email.save();
          
          // Emit both deleted (from old folder) and updated (in new folder)
          this.eventsGateway.emitToTenant(tenantId, 'email.deleted', { id, oldFolder: email.folder });
          this.eventsGateway.emitToTenant(tenantId, 'email.moved', { 
            id, 
            email: email.toObject(), 
            fromFolder: email.folder, 
            toFolder: trashPath 
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

  async getFolders(tenantId: string) {
    // Try to get real IMAP folders from server
    try {
      const { integration, imapPass } = await this.getImapCredentials(tenantId);
      const client = this.createImapClient(integration, imapPass);
      client.on('error', () => {});

      await Promise.race([
        client.connect(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 15000)),
      ]);

      const mailboxes = await client.list();
      try { if (client.usable) await client.logout(); } catch {}

      // Standard folder name mapping
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

      // Get local counts for each folder
      const localCounts = await this.emailModel.aggregate([
        { $match: { tenantId: new Types.ObjectId(tenantId) } },
        {
          $group: {
            _id: '$folder',
            count: { $sum: 1 },
            unread: { $sum: { $cond: ['$isRead', 0, 1] } },
          },
        },
      ]);
      const countMap = new Map(localCounts.map(c => [c._id, { count: c.count, unread: c.unread }]));

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
      // Fallback: aggregate from local data
      const folders = await this.emailModel.aggregate([
        { $match: { tenantId: new Types.ObjectId(tenantId) } },
        {
          $group: {
            _id: '$folder',
            count: { $sum: 1 },
            unread: { $sum: { $cond: ['$isRead', 0, 1] } },
          },
        },
        { $sort: { _id: 1 } },
      ]);

      return folders.map((f) => ({
        name: f._id,
        path: f._id,
        specialUse: null,
        count: f.count,
        unread: f.unread,
      }));
    }
  }

  async bulkDelete(tenantId: string, ids: string[]) {
    if (!ids?.length) return { deleted: 0 };

    const emails = await this.emailModel.find({
      _id: { $in: ids.map(id => new Types.ObjectId(id)) },
      tenantId: new Types.ObjectId(tenantId),
    });

    if (!emails.length) return { deleted: 0 };

    // Group by folder
    const byFolder = new Map<string, string[]>();
    for (const email of emails) {
      const list = byFolder.get(email.folder) || [];
      list.push(email.messageId);
      byFolder.set(email.folder, list);
    }

    // Single IMAP connection for all operations
    const { integration, imapPass } = await this.getImapCredentials(tenantId);
    const client = this.createImapClient(integration, imapPass);
    client.on('error', (err) => console.error('[IMAP] Error:', err));

    let trashPath: string | null = null;
    const movedIds: string[] = [];
    const deletedIds: string[] = [];

    try {
      await Promise.race([
        client.connect(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Connection timeout')), 30000)),
      ]);

      trashPath = await this.findTrashPath(client);

      for (const [folder, uids] of byFolder.entries()) {
        const isTrash = trashPath && folder === trashPath;
        const folderEmails = emails.filter(e => e.folder === folder);
        
        try {
          const lock = await client.getMailboxLock(folder);
          try {
            for (const uid of uids) {
              try {
                if (isTrash || !trashPath) {
                  // Already in Trash → permanently delete
                  await client.messageFlagsAdd(uid, ['\\Deleted'], { uid: true });
                  await client.messageDelete(uid, { uid: true });
                  const email = folderEmails.find(e => e.messageId === uid);
                  if (email) deletedIds.push(email._id.toString());
                } else {
                  // Move to Trash
                  await client.messageMove(uid, trashPath, { uid: true });
                  const email = folderEmails.find(e => e.messageId === uid);
                  if (email) movedIds.push(email._id.toString());
                }
              } catch {}
            }
            console.log(`[IMAP] Bulk ${isTrash ? 'deleted' : 'moved to trash'} ${uids.length} messages from ${folder}`);
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

    // Update moved emails locally to appear in Trash immediately
    if (movedIds.length > 0 && trashPath) {
      await this.emailModel.updateMany(
        { _id: { $in: movedIds.map(id => new Types.ObjectId(id)) } },
        { $set: { folder: trashPath } }
      );
      for (const id of movedIds) {
        this.eventsGateway.emitToTenant(tenantId, 'email.deleted', { id });
        const movedEmail = emails.find(e => e._id.toString() === id);
        if (movedEmail) {
          movedEmail.folder = trashPath;
          this.eventsGateway.emitToTenant(tenantId, 'email.moved', { 
            id, 
            email: movedEmail.toObject(),
            toFolder: trashPath 
          });
        }
      }
    }

    // Permanently delete emails that were in Trash
    if (deletedIds.length > 0) {
      await this.emailModel.deleteMany({
        _id: { $in: deletedIds.map(id => new Types.ObjectId(id)) }
      });
      for (const id of deletedIds) {
        this.eventsGateway.emitToTenant(tenantId, 'email.deleted', { id });
      }
    }

    return { deleted: movedIds.length + deletedIds.length };
  }

  async getUnreadCount(tenantId: string) {
    return this.emailModel.countDocuments({
      tenantId: new Types.ObjectId(tenantId),
      folder: 'INBOX',
      isRead: false,
    });
  }

  // Auto-sync: Check for new emails every 30 seconds
  startAutoSync(tenantId: string) {
    // Clear existing interval if any
    this.stopAutoSync(tenantId);

    // Do initial sync after 5 seconds — sync ALL folders
    setTimeout(async () => {
      try {
        console.log(`[Auto-Sync] Initial sync (all folders) for tenant ${tenantId}`);
        const result = await this.syncAllFolders(tenantId);
        console.log(`[Auto-Sync] Initial sync complete: ${result.totalSynced} new emails across ${result.folders.length} folders`);
      } catch (error: any) {
        console.error('[Auto-Sync] Initial sync error:', error.message);
      }
    }, 5000);

    const interval = setInterval(async () => {
      try {
        console.log(`[Auto-Sync] Periodic sync (all folders) for tenant ${tenantId}`);
        const result = await this.syncAllFolders(tenantId);
        if (result.totalSynced > 0) {
          console.log(`[Auto-Sync] Synced ${result.totalSynced} new emails`);
        }
      } catch (error: any) {
        console.error('[Auto-Sync] Error:', error.message);
      }
    }, 30000); // 30 seconds

    this.syncIntervals.set(tenantId, interval);
    console.log(`[Auto-Sync] Started for tenant ${tenantId}`);
  }

  stopAutoSync(tenantId: string) {
    const interval = this.syncIntervals.get(tenantId);
    if (interval) {
      clearInterval(interval);
      this.syncIntervals.delete(tenantId);
      console.log(`[Auto-Sync] Stopped for tenant ${tenantId}`);
    }
  }

  // Initialize auto-sync for all connected tenants on startup
  async initAutoSyncForAllTenants() {
    try {
      const integrations = await this.emailIntegrationsService['emailModel'].find({
        status: 'connected',
      });
      
      for (const integration of integrations) {
        this.startAutoSync(integration.tenantId.toString());
      }
      
      console.log(`[Auto-Sync] Initialized for ${integrations.length} tenants`);
    } catch (error) {
      console.error('[Auto-Sync] Init error:', error);
    }
  }
}
