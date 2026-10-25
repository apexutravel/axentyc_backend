import { EventEmitter2 } from '@nestjs/event-emitter';
import { AUTOMATION_EVENT } from '../automations/automation-events';
import type { AutomationEventPayload } from '../automations/automation-events';
import { AutomationTrigger } from '../automations/entities/automation.entity';
import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  ConflictException,
  OnModuleInit,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import {
  SocialAccount,
  SocialAccountDocument,
  SocialPlatform,
  SocialAccountStatus,
  IntegrationProvider,
  ConnectedAssetType,
  IntegrationCapability,
} from '../integrations/entities/social-account.entity';
import {
  Conversation,
  ConversationDocument,
  ConversationChannel,
  ConversationStatus,
} from '../conversations/entities/conversation.entity';
import {
  Message,
  MessageDocument,
  MessageDirection,
  MessageType,
  MessageStatus,
} from '../conversations/entities/message.entity';
import { EventsGateway } from '../events/events.gateway';
import {
  Contact,
  ContactDocument,
  ContactSource,
} from '../crm/entities/contact.entity';
import {
  FacebookConfig,
  FacebookConfigDocument,
} from './entities/facebook-config.entity';
import { BillingService } from '../billing/billing.service';
import { createHmac, randomUUID, timingSafeEqual } from 'crypto';

@Injectable()
export class FacebookService implements OnModuleInit {
  private readonly logger = new Logger(FacebookService.name);
  private readonly pendingPageSelections = new Map<
    string,
    { tenantId: string; expiresAt: number; pages: any[] }
  >();
  private readonly recentWebhooks = new Map<string, number>(); // pageId -> timestamp

  constructor(
    @InjectModel(SocialAccount.name)
    private socialAccountModel: Model<SocialAccountDocument>,
    @InjectModel(Contact.name)
    private contactModel: Model<ContactDocument>,
    @InjectModel(Conversation.name)
    private conversationModel: Model<ConversationDocument>,
    @InjectModel(Message.name)
    private messageModel: Model<MessageDocument>,
    @InjectModel(FacebookConfig.name)
    private facebookConfigModel: Model<FacebookConfigDocument>,
    private configService: ConfigService,
    private eventsGateway: EventsGateway,
    private billingService: BillingService,
    private bus: EventEmitter2,
  ) {}

  // Get global Facebook app config from environment variables
  private getGlobalAppConfig(): {
    appId: string;
    appSecret: string;
    verifyToken: string;
  } | null {
    const appId = this.configService.get<string>('FACEBOOK_APP_ID');
    const appSecret = this.configService.get<string>('FACEBOOK_APP_SECRET');
    const verifyToken =
      this.configService.get<string>('FACEBOOK_VERIFY_TOKEN') || '';

    if (!appId || !appSecret) {
      this.logger.warn(
        'Facebook app credentials not configured in environment variables',
      );
      return null;
    }
    return { appId, appSecret, verifyToken };
  }

  // ─── Automatic Polling (Hybrid: Webhook + Polling Fallback) ───

  @Cron('*/3 * * * *') // Every 3 minutes
  async autoSyncComments() {
    // Safety net behind the webhook: on unless explicitly disabled
    const enabled =
      this.configService.get<string>('FACEBOOK_COMMENTS_POLLING_ENABLED') !==
      'false';
    if (!enabled) {
      return;
    }

    this.logger.log(
      '[Auto-Sync] Starting automatic comment sync for all tenants',
    );

    try {
      const accounts = await this.socialAccountModel.find({
        platform: SocialPlatform.FACEBOOK,
        status: SocialAccountStatus.CONNECTED,
      });

      const tenantMap = new Map<string, SocialAccountDocument[]>();
      for (const account of accounts) {
        const tenantId = account.tenantId.toString();
        if (!tenantMap.has(tenantId)) {
          tenantMap.set(tenantId, []);
        }
        tenantMap.get(tenantId)!.push(account);
      }

      let totalSynced = 0;
      for (const [tenantId, tenantAccounts] of tenantMap) {
        for (const account of tenantAccounts) {
          // Skip if webhook received in last 5 minutes
          const lastWebhook = this.recentWebhooks.get(account.pageId!);
          if (lastWebhook && Date.now() - lastWebhook < 5 * 60 * 1000) {
            this.logger.debug(
              `[Auto-Sync] Skipping ${account.accountName} - recent webhook received`,
            );
            continue;
          }

          try {
            const result = await this.syncCommentsForTenant(
              tenantId,
              account.pageId!,
            );
            const added = result.results[0]?.commentsAdded || 0;
            if (added > 0) {
              this.logger.log(
                `[Auto-Sync] Synced ${added} new comments for ${account.accountName}`,
              );
              totalSynced += added;
            }
          } catch (e: any) {
            this.logger.error(
              `[Auto-Sync] Error syncing ${account.accountName}: ${e.message}`,
            );
          }
        }
      }

      if (totalSynced > 0) {
        this.logger.log(
          `[Auto-Sync] Completed: ${totalSynced} new comments synced`,
        );
      }
    } catch (e: any) {
      this.logger.error(`[Auto-Sync] Fatal error: ${e.message}`);
    }
  }

  // ─── Instagram safety net: poll every minute so nothing depends on the webhook alone ───

  private igPolling = false;
  private readonly igLastPoll = new Map<string, number>(); // tenantId -> last successful poll start
  private readonly igWebhookMarked = new Map<string, number>(); // igAccountId -> last DB write

  /** Remember that Meta really delivered an Instagram event (shown in the UI as "tiempo real"). */
  private markInstagramWebhook(igAccountId: string) {
    const now = Date.now();
    if (now - (this.igWebhookMarked.get(igAccountId) || 0) < 30_000) return;
    this.igWebhookMarked.set(igAccountId, now);
    this.socialAccountModel
      .updateMany(
        { platform: SocialPlatform.INSTAGRAM, accountId: igAccountId },
        { $set: { 'metadata.lastWebhookAt': new Date(now) } },
      )
      .catch(() => undefined);
  }

  private igTick = 0;

  /**
   * Safety net behind the webhook. While Meta is not delivering Instagram events it runs every 20s;
   * once webhooks are flowing (an event in the last 10 min) it drops to once a minute.
   */
  @Cron('*/20 * * * * *')
  async autoSyncInstagram() {
    if (this.configService.get<string>('META_POLLING_ENABLED') === 'false') return;
    if (this.igPolling) return;
    this.igPolling = true;
    const tick = this.igTick++;
    try {
      const accounts = await this.socialAccountModel
        .find({
          platform: SocialPlatform.INSTAGRAM,
          status: SocialAccountStatus.CONNECTED,
        })
        .select('tenantId accountId')
        .lean();
      const byTenant = new Map<string, string[]>();
      for (const a of accounts) {
        const key = String(a.tenantId);
        byTenant.set(key, [...(byTenant.get(key) || []), String(a.accountId)]);
      }

      for (const [tenantId, igIds] of byTenant) {
        const webhookHealthy = igIds.some(
          (id) => Date.now() - (this.igWebhookMarked.get(id) || 0) < 10 * 60 * 1000,
        );
        if (webhookHealthy && tick % 3 !== 0) continue;
        const startedAt = Date.now();
        // First run after a restart looks back 24h; afterwards only what changed since the last pass
        const last = this.igLastPoll.get(tenantId) ?? Date.now() - 24 * 3600 * 1000;
        const since = new Date(last - 2 * 60 * 1000);
        try {
          const dms = await this.syncInstagramMessages(tenantId, { since });
          const comments = await this.syncInstagramComments(tenantId, { since });
          this.igLastPoll.set(tenantId, startedAt);
          if (dms.newMessages || comments.newComments) {
            this.logger.log(
              `[IG Auto-Sync] tenant ${tenantId}: ${dms.newMessages} DMs, ${comments.newComments} comments`,
            );
          }
        } catch (e: any) {
          this.logger.error(`[IG Auto-Sync] tenant ${tenantId}: ${e?.message || e}`);
        }
      }
    } catch (e: any) {
      this.logger.error(`[IG Auto-Sync] fatal: ${e?.message || e}`);
    } finally {
      this.igPolling = false;
    }
  }

  /**
   * Fetch recent Instagram comments and treat unseen ones exactly like a webhook delivery:
   * stored, unread counter, real-time events and automations. Dedupes by comment id.
   * Polling cannot see the commenter's IGSID, only the username, so contacts are matched by username.
   */
  async syncInstagramComments(
    tenantId: string,
    opts: { since?: Date } = {},
  ): Promise<{ newComments: number }> {
    const result = { newComments: 0 };
    const accounts = await this.socialAccountModel.find({
      tenantId: new Types.ObjectId(tenantId),
      platform: SocialPlatform.INSTAGRAM,
      status: SocialAccountStatus.CONNECTED,
    });

    for (const account of accounts) {
      if (!account.accountId || !account.accessToken) continue;
      try {
        const reply = 'id,text,username,timestamp';
        const data = await this.igGraph(account, `${account.accountId}/media`, 'GET', {
          fields: `id,timestamp,comments.limit(50){${reply},replies.limit(25){${reply}}}`,
          limit: '10',
        });
        const ownName = (account.accountName || '').toLowerCase();

        const flat: { mediaId: string; c: any }[] = [];
        for (const m of data?.data || []) {
          for (const c of m.comments?.data || []) {
            flat.push({ mediaId: m.id, c });
            for (const r of c.replies?.data || []) flat.push({ mediaId: m.id, c: r });
          }
        }
        // Oldest first so the conversation ends on the newest comment
        flat.sort((a, b) => new Date(a.c.timestamp).getTime() - new Date(b.c.timestamp).getTime());

        for (const { mediaId, c } of flat) {
          const username: string | undefined = c.username;
          if (!c.id || !username || !c.text) continue;
          if (username.toLowerCase() === ownName) continue;
          if (opts.since && new Date(c.timestamp).getTime() < opts.since.getTime()) continue;
          if (
            await this.messageModel.exists({
              tenantId: new Types.ObjectId(tenantId),
              'metadata.commentId': c.id,
            })
          ) {
            continue;
          }

          const contact = await this.getOrCreateInstagramContactByUsername(
            tenantId,
            username,
            account.workspaceId,
          );
          const conversation = await this.getOrCreateInstagramCommentConversation(
            tenantId,
            contact._id.toString(),
            contact.customFields?.instagramPsid || `@${username}`,
            mediaId,
            account.accountId,
            account.accountName,
          );

          const saved = await new this.messageModel({
            tenantId: new Types.ObjectId(tenantId),
            workspaceId: (conversation as any).workspaceId,
            conversationId: conversation._id,
            direction: MessageDirection.INBOUND,
            type: MessageType.TEXT,
            content: c.text,
            senderName: contact.name,
            status: MessageStatus.SENT,
            metadata: {
              commentId: c.id,
              mediaId,
              platform: 'instagram',
              isComment: true,
              polled: true,
              commentCreatedAt: c.timestamp,
            },
          }).save();

          const viewed = this.eventsGateway.isConversationBeingViewed(
            conversation._id.toString(),
          );
          const updated = await this.conversationModel
            .findByIdAndUpdate(
              conversation._id,
              {
                lastMessage: c.text,
                lastMessageAt: new Date(),
                status: ConversationStatus.OPEN,
                $inc: { unreadCount: viewed ? 0 : 1 },
              },
              { new: true },
            )
            .populate('contactId')
            .lean();
          if (updated) this.eventsGateway.emitConversationUpdated(tenantId, updated);
          this.eventsGateway.emitMessageReceived(
            tenantId,
            conversation._id.toString(),
            saved,
            contact,
          );
          this.eventsGateway.emitToTenant(tenantId, 'ig.comment.new', {
            workspaceId: account.workspaceId?.toString(),
            mediaId,
            accountId: account.accountId,
            comment: {
              id: c.id,
              from: { id: username, username },
              text: c.text,
              created_time: c.timestamp,
            },
          });
          this.bus.emit(AUTOMATION_EVENT, {
            trigger: AutomationTrigger.MESSAGE_RECEIVED,
            tenantId,
            workspaceId: account.workspaceId ? String(account.workspaceId) : undefined,
            conversationId: String(conversation._id),
            contactId: String(contact._id),
            channel: 'instagram',
            text: c.text,
          } as AutomationEventPayload);
          result.newComments++;
        }
      } catch (e: any) {
        this.logger.warn(
          `[IG Comments Sync] @${account.accountName}: ${e?.message || e}`,
        );
      }
    }
    return result;
  }

  private async getOrCreateInstagramContactByUsername(
    tenantId: string,
    username: string,
    workspaceId?: Types.ObjectId | string,
  ): Promise<ContactDocument> {
    const scope: any = { tenantId: new Types.ObjectId(tenantId) };
    if (workspaceId) scope.workspaceId = new Types.ObjectId(workspaceId.toString());
    const handle = username.toLowerCase();
    const existing = await this.contactModel.findOne({
      ...scope,
      $or: [
        { 'socialProfiles.instagram.username': username },
        { 'customFields.instagramUsername': handle },
      ],
    });
    if (existing) return existing;

    const contact = await new this.contactModel({
      ...scope,
      name: `@${username}`,
      source: ContactSource.INSTAGRAM,
      tags: ['instagram'],
      customFields: { instagramUsername: handle },
      socialProfiles: { instagram: { id: username, username } },
    }).save();
    this.bus.emit(AUTOMATION_EVENT, {
      trigger: AutomationTrigger.CONTACT_CREATED,
      tenantId,
      workspaceId: contact.workspaceId ? String(contact.workspaceId) : undefined,
      contactId: String(contact._id),
      channel: 'instagram',
    } as AutomationEventPayload);
    return contact;
  }

  private markWebhookReceived(pageId: string) {
    this.recentWebhooks.set(pageId, Date.now());
    // Clean old entries (older than 10 minutes)
    for (const [pid, timestamp] of this.recentWebhooks.entries()) {
      if (Date.now() - timestamp > 10 * 60 * 1000) {
        this.recentWebhooks.delete(pid);
      }
    }
  }

  // ─── Reply to / Moderate Comments ───

  async replyToComment(
    tenantId: string,
    commentId: string,
    message: string,
    opts?: { pageId?: string; postId?: string },
  ): Promise<{ success: boolean; commentId?: string }> {
    try {
      // Try to locate conversation/message first to infer page/post
      let existingMessage = await this.messageModel.findOne({
        tenantId: new Types.ObjectId(tenantId),
        'metadata.commentId': commentId,
      });

      // Prefer request-provided identifiers
      let postId = opts?.postId || existingMessage?.metadata?.postId;
      let pageId = opts?.pageId || (postId ? postId.split('_')[0] : undefined);

      if (!pageId) {
        throw new BadRequestException(
          'pageId is required to reply to a comment',
        );
      }

      // Find the social account
      const account = await this.socialAccountModel.findOne({
        tenantId: new Types.ObjectId(tenantId),
        pageId,
        platform: SocialPlatform.FACEBOOK,
        status: SocialAccountStatus.CONNECTED,
      });

      if (!account?.accessToken) {
        throw new BadRequestException(
          'Facebook page not connected or missing access token',
        );
      }

      // Reply to comment via Graph API
      const replyUrl = `${this.graphApiUrl}/${commentId}/comments`;
      const replyParams = new URLSearchParams();
      replyParams.append('message', message);
      replyParams.append('access_token', account.accessToken);
      const response = await fetch(replyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: replyParams.toString(),
      });

      const data = (await response.json()) as any;
      if (data.error) {
        this.logger.error('Failed to reply to comment:', data.error);
        throw new BadRequestException(
          data.error.message || 'Failed to reply to comment',
        );
      }

      this.logger.log(`Replied to comment ${commentId}: ${data.id}`);

      // Save the reply as an outbound message (if we can associate it)
      // Try to resolve conversation from existing message or by postId
      let conversation = existingMessage
        ? await this.conversationModel.findById(existingMessage.conversationId)
        : null;
      if (!conversation && postId) {
        conversation = (await this.conversationModel.findOne({
          tenantId: new Types.ObjectId(tenantId),
          'metadata.postId': postId,
        })) as any;
      }
      if (conversation) {
        const replyMessage = new this.messageModel({
          tenantId: new Types.ObjectId(tenantId),
          workspaceId: (conversation as any).workspaceId,
          conversationId: conversation._id,
          direction: MessageDirection.OUTBOUND,
          type: MessageType.TEXT,
          content: message,
          senderName: account.accountName,
          status: MessageStatus.SENT,
          metadata: {
            commentId: data.id,
            postId,
            platform: 'facebook',
            isComment: true,
            parentCommentId: commentId,
          },
        });

        await replyMessage.save();

        // Update conversation
        await this.conversationModel.findByIdAndUpdate(conversation._id, {
          lastMessage: message,
          lastMessageAt: new Date(),
        });

        // Emit real-time event
        this.eventsGateway.emitToConversation(
          conversation._id.toString(),
          'message.new',
          replyMessage,
        );

        // Emit dedicated FB comment reply event for real-time UI updates
        this.eventsGateway.emitToTenant(tenantId, 'fb.comment.reply', {
          postId,
          pageId,
          parentCommentId: commentId,
          reply: {
            id: data.id,
            from: { id: pageId, name: account.accountName },
            message,
            created_time: new Date().toISOString(),
            like_count: 0,
            user_likes: false,
            parent: { id: commentId },
          },
        });
      }

      return { success: true, commentId: data.id };
    } catch (error: any) {
      this.logger.error('Error replying to comment:', error);
      throw error;
    }
  }

  async reactToObject(
    tenantId: string,
    pageId: string,
    objectId: string,
    reactionType: string,
  ): Promise<{ success: boolean }> {
    const account = await this.socialAccountModel.findOne({
      tenantId: new Types.ObjectId(tenantId),
      pageId,
      platform: SocialPlatform.FACEBOOK,
      status: SocialAccountStatus.CONNECTED,
    });
    if (!account?.accessToken) {
      throw new BadRequestException(
        'Facebook page not connected or missing access token',
      );
    }

    const normalizedType = (reactionType || 'LIKE').toUpperCase();
    const edge = normalizedType === 'LIKE' ? 'likes' : 'reactions';
    const url = `${this.graphApiUrl}/${objectId}/${edge}`;

    this.logger.log(
      `[reactToObject] POST ${url} type=${normalizedType} objectId=${objectId}`,
    );

    // Facebook Graph API expects form-urlencoded, not JSON
    const params = new URLSearchParams();
    params.append('access_token', account.accessToken);
    if (normalizedType !== 'LIKE') {
      params.append('type', normalizedType);
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    const data = (await response.json()) as any;
    if (data.error) {
      this.logger.error(
        'Failed to react to Facebook object:',
        JSON.stringify(data.error),
      );

      // If error #3 (capability), diagnose token permissions to give a better message
      if (data.error?.code === 3) {
        let missingPermissions: string[] = [];
        let grantedPermissions: string[] = [];
        try {
          const debugUrl = `${this.graphApiUrl}/me/permissions?access_token=${account.accessToken}`;
          const debugResp = await fetch(debugUrl);
          const debugData = (await debugResp.json()) as any;
          if (Array.isArray(debugData?.data)) {
            grantedPermissions = debugData.data
              .filter((p: any) => p.status === 'granted')
              .map((p: any) => p.permission);
            const granted = new Set(grantedPermissions);
            const required = [
              'pages_manage_engagement',
              'pages_read_engagement',
            ];
            missingPermissions = required.filter((p) => !granted.has(p));
            this.logger.log(
              `[reactToObject] Token permissions: granted=${grantedPermissions.join(',')}, missing=${missingPermissions.join(',')}`,
            );
          }
        } catch (e) {
          this.logger.warn(
            '[reactToObject] Could not fetch token permissions:',
            e,
          );
        }

        // Check if it's a feature/capability issue vs permission issue
        const errorMsg = data.error?.message || '';
        const isCapabilityError =
          errorMsg.toLowerCase().includes('capability') ||
          errorMsg.toLowerCase().includes('permission');

        let message: string;
        if (missingPermissions.length > 0) {
          message = `El token de la página no tiene los permisos necesarios (${missingPermissions.join(', ')}). Desconecta y vuelve a conectar la página de Facebook para solicitar los permisos actualizados.`;
        } else if (grantedPermissions.includes('pages_manage_engagement')) {
          // Token has the permission but Facebook still rejects - this is an App Review / feature issue
          message = `El token tiene el permiso pages_manage_engagement, pero Facebook rechaza la operación. Esto significa que la app necesita acceso avanzado (Advanced Access) para este permiso.\n\nPasos para solucionar:\n1. Ve a developers.facebook.com → tu app → App Review → Permissions and Features\n2. Busca "pages_manage_engagement"\n3. Si está en "Standard Access", solicita "Advanced Access" (requiere App Review)\n4. Si la app está en modo desarrollo, solo funciona para páginas donde eres admin/desarrollador\n5. Después de aprobarse, desconecta y reconecta la página en AXENTYC\n\nError original de Facebook: ${errorMsg}`;
        } else {
          message = `Facebook rechazó la reacción. Error: ${errorMsg}`;
        }
        throw new BadRequestException(message);
      }

      throw new BadRequestException(
        data.error.message || 'Failed to react to Facebook object',
      );
    }

    return { success: true };
  }

  async diagnoseTokenPermissions(
    tenantId: string,
    pageId: string,
  ): Promise<{
    permissions: any[];
    hasEngagementPermissions: boolean;
    tokenValid: boolean;
    reactionTestError?: string;
  }> {
    const account = await this.socialAccountModel.findOne({
      tenantId: new Types.ObjectId(tenantId),
      pageId,
      platform: SocialPlatform.FACEBOOK,
      status: SocialAccountStatus.CONNECTED,
    });
    if (!account?.accessToken) {
      return {
        permissions: [],
        hasEngagementPermissions: false,
        tokenValid: false,
      };
    }

    try {
      const debugUrl = `${this.graphApiUrl}/me/permissions?access_token=${account.accessToken}`;
      const resp = await fetch(debugUrl);
      const data = (await resp.json()) as any;
      if (data.error) {
        this.logger.error('[diagnoseTokenPermissions] Error:', data.error);
        return {
          permissions: [],
          hasEngagementPermissions: false,
          tokenValid: false,
        };
      }
      const permissions = Array.isArray(data?.data) ? data.data : [];
      const granted = new Set(
        permissions
          .filter((p: any) => p.status === 'granted')
          .map((p: any) => p.permission),
      );
      const hasEngagement =
        granted.has('pages_manage_engagement') &&
        granted.has('pages_read_engagement');

      // Also get the app's access level for pages_manage_engagement
      let appReviewInfo: string | undefined;
      try {
        // Try to get debug token info to see app features
        const appTokenUrl = `${this.graphApiUrl}/debug_token?input_token=${account.accessToken}&access_token=${account.accessToken}`;
        const appResp = await fetch(appTokenUrl);
        const appData = (await appResp.json()) as any;
        if (appData?.data) {
          this.logger.log(
            `[diagnoseTokenPermissions] Token debug info: ${JSON.stringify(appData.data)}`,
          );
          appReviewInfo = appData.data?.scopes?.join(', ') || undefined;
        }
      } catch (e) {
        this.logger.warn(
          '[diagnoseTokenPermissions] Could not fetch debug token info:',
          e,
        );
      }

      return { 
        permissions, 
        hasEngagementPermissions: hasEngagement, 
        tokenValid: true,
        reactionTestError: appReviewInfo,
      };
    } catch (e) {
      this.logger.error('[diagnoseTokenPermissions] Exception:', e);
      return {
        permissions: [],
        hasEngagementPermissions: false,
        tokenValid: false,
      };
    }
  }

  async hideComment(
    tenantId: string,
    pageId: string,
    commentId: string,
    hide: boolean,
  ): Promise<{ success: boolean }> {
    const account = await this.socialAccountModel.findOne({
      tenantId: new Types.ObjectId(tenantId),
      pageId,
      platform: SocialPlatform.FACEBOOK,
      status: SocialAccountStatus.CONNECTED,
    });
    if (!account?.accessToken) {
      throw new BadRequestException(
        'Facebook page not connected or missing access token',
      );
    }

    const url = `${this.graphApiUrl}/${commentId}`;
    const hideParams = new URLSearchParams();
    hideParams.append('is_hidden', String(hide));
    hideParams.append('access_token', account.accessToken);
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: hideParams.toString(),
    });
    const data = (await resp.json()) as any;
    if (data.error) {
      this.logger.error('Failed to hide/unhide comment:', data.error);
      throw new BadRequestException(
        data.error.message || 'Failed to hide/unhide comment',
      );
    }
    return { success: true };
  }

  async deleteComment(
    tenantId: string,
    pageId: string,
    commentId: string,
  ): Promise<{ success: boolean }> {
    const account = await this.socialAccountModel.findOne({
      tenantId: new Types.ObjectId(tenantId),
      pageId,
      platform: SocialPlatform.FACEBOOK,
      status: SocialAccountStatus.CONNECTED,
    });
    if (!account?.accessToken) {
      throw new BadRequestException(
        'Facebook page not connected or missing access token',
      );
    }

    const url = `${this.graphApiUrl}/${commentId}?access_token=${account.accessToken}`;
    const resp = await fetch(url, { method: 'DELETE' });
    if (!resp.ok) {
      try {
        const data = (await resp.json()) as any;
        if (data?.error) {
          this.logger.error('Failed to delete comment:', data.error);
          throw new BadRequestException(
            data.error.message || 'Failed to delete comment',
          );
        }
      } catch (e) {
        // ignore json parse error
      }
      throw new BadRequestException('Failed to delete comment');
    }
    return { success: true };
  }

  // ─── Manual Sync (Fallback when webhooks are not delivering) ───

  async syncCommentsForTenant(
    tenantId: string,
    pageId?: string,
  ): Promise<{ success: boolean; results: any[] }> {
    const pageFilter: any = {
      tenantId: new Types.ObjectId(tenantId),
      platform: SocialPlatform.FACEBOOK,
      status: SocialAccountStatus.CONNECTED,
    };
    if (pageId) pageFilter.pageId = pageId;

    const accounts = await this.socialAccountModel.find(pageFilter);
    const results: any[] = [];

    for (const account of accounts) {
      if (!account.pageId || !account.accessToken) {
        results.push({
          pageId: account.pageId,
          status: 'skipped',
          reason: 'missing_token_or_page',
        });
        continue;
      }

      try {
        const fields = [
          'id',
          'permalink_url',
          'created_time',
          'from{id,name,picture}',
          'message',
          'full_picture',
          'reactions.limit(0).summary(true)',
          'likes.limit(0).summary(true)',
          'comments.limit(100){id,from{id,name,picture},message,created_time,parent{id},like_count,user_likes}',
        ].join(',');
        const url = `${this.graphApiUrl}/${account.pageId}/feed?fields=${encodeURIComponent(fields)}&limit=10&access_token=${account.accessToken}`;
        this.logger.log(`[Sync] Fetching posts for page ${account.pageId}`);
        const resp = await fetch(url);
        const data = (await resp.json()) as any;
        if (data?.error) {
          // Invalid / revoked token: flag the account so the UI can ask to reconnect
          if (data.error.code === 190) {
            await this.socialAccountModel.updateOne(
              { _id: account._id },
              { $set: { status: SocialAccountStatus.ERROR } },
            );
          }
          results.push({
            pageId: account.pageId,
            status: 'error',
            error: data.error.message || 'Graph API error',
          });
          continue;
        }
        const posts: any[] = Array.isArray(data?.data) ? data.data : [];

        let created = 0;
        for (const post of posts) {
          const postId: string = post.id; // format: {pageId}_{postNumericId}
          const comments: any[] = post.comments?.data || [];
          for (const c of comments) {
            const saved = await this.upsertFbCommentFromFetch(
              account.tenantId.toString(),
              account,
              postId,
              c,
            );
            if (saved) created += 1;
          }
        }

        results.push({
          pageId: account.pageId,
          status: 'ok',
          posts: posts.length,
          commentsAdded: created,
        });
      } catch (e: any) {
        this.logger.error(
          `[Sync] Error syncing page ${account.pageId}: ${e?.message || e}`,
        );
        results.push({
          pageId: account.pageId,
          status: 'error',
          error: e?.message || String(e),
        });
      }
    }

    return { success: true, results };
  }

  private async upsertFbCommentFromFetch(
    tenantId: string,
    account: SocialAccountDocument,
    postId: string,
    c: any,
  ): Promise<boolean> {
    const commenterId: string | undefined = c?.from?.id;
    const commenterName: string | undefined = c?.from?.name;
    const commentText: string = typeof c?.message === 'string' ? c.message : '';
    const commentId: string | undefined = c?.id;
    const createdTimeIso: string | undefined = c?.created_time;

    if (!commentId || !commenterId) return false;
    // Skip comments written by the page itself
    if (commenterId === account.pageId) return false;

    const exists = await this.messageModel.findOne({
      tenantId: new Types.ObjectId(tenantId),
      'metadata.commentId': commentId,
    });
    if (exists) return false;

    // Ensure contact exists
    const contact = await this.getOrCreateContact(
      tenantId,
      commenterId,
      account.accessToken,
      'facebook',
      account.workspaceId,
    );

    // Ensure conversation for this post
    const conversation = await this.getOrCreateCommentConversation(
      tenantId,
      contact._id.toString(),
      commenterId,
      postId,
      account.pageId!,
      account.accountName,
    );

    // Save message
    const newMessage = new this.messageModel({
      tenantId: new Types.ObjectId(tenantId),
      workspaceId: (conversation as any).workspaceId,
      conversationId: conversation._id,
      direction: MessageDirection.INBOUND,
      type: MessageType.TEXT,
      content: commentText || '(comentario sin texto)',
      senderName: contact.name || commenterName,
      status: MessageStatus.SENT,
      metadata: {
        commentId: commentId,
        postId: postId,
        platform: 'facebook',
        isComment: true,
        commentCreatedAt: createdTimeIso,
      },
    });

    const savedMessage = await newMessage.save();

    // Update conversation
    const isBeingViewed = this.eventsGateway.isConversationBeingViewed(
      conversation._id.toString(),
    );
    await this.conversationModel.findByIdAndUpdate(conversation._id, {
      lastMessage: newMessage.content,
      lastMessageAt: new Date(),
      status: ConversationStatus.OPEN,
      $inc: { unreadCount: isBeingViewed ? 0 : 1 },
    });

    this.eventsGateway.emitMessageReceived(
      tenantId,
      conversation._id.toString(),
      savedMessage,
      contact,
    );

    // Polling is only a fallback transport. New comments must behave exactly
    // like comments delivered by Meta's webhook.
    this.bus.emit(AUTOMATION_EVENT, {
      trigger: AutomationTrigger.MESSAGE_RECEIVED,
      tenantId,
      workspaceId: account.workspaceId
        ? String(account.workspaceId)
        : undefined,
      conversationId: String(conversation._id),
      contactId: String(contact._id),
      channel: 'facebook',
      text: commentText,
    } as AutomationEventPayload);

    return true;
  }

  async getPageFeed(
    tenantId: string,
    pageId: string,
    limit = 10,
  ): Promise<{ pageId: string; posts: any[] }> {
    const account = await this.socialAccountModel.findOne({
      tenantId: new Types.ObjectId(tenantId),
      platform: SocialPlatform.FACEBOOK,
      pageId,
      status: SocialAccountStatus.CONNECTED,
    });

    if (!account?.accessToken) {
      throw new BadRequestException(
        'Facebook page not connected or missing access token',
      );
    }

    const fields = [
      'id',
      'permalink_url',
      'created_time',
      'from{id,name,picture}',
      'admin_creator{id,name}',
      'message',
      'story',
      'status_type',
      'full_picture',
      'reactions.limit(0).summary(true)',
      'likes.limit(0).summary(true)',
      'comments.limit(100){id,from{id,name,picture},message,created_time,parent{id},like_count,user_likes,comments{id,from{id,name,picture},message,created_time,parent{id},like_count,user_likes}}',
    ].join(',');
    const url = `${this.graphApiUrl}/${pageId}/feed?fields=${encodeURIComponent(fields)}&limit=${limit}&access_token=${account.accessToken}`;
    const resp = await fetch(url);
    const data = (await resp.json()) as any;
    if (data.error) {
      throw new BadRequestException(
        data.error?.message || 'Failed to fetch page feed',
      );
    }
    const posts = Array.isArray(data?.data) ? data.data : [];
    await this.enrichFeedAvatars(posts, account.accessToken);
    return { pageId, posts };
  }

  private async enrichFeedAvatars(
    posts: any[],
    pageAccessToken: string,
  ): Promise<void> {
    const profileCache = new Map<string, string | null>();

    const enrichProfile = async (profile: any) => {
      const profileId = profile?.id;
      if (!profileId || profile?.picture?.data?.url) return;
      if (!profileCache.has(profileId)) {
        // Never embed access tokens in URLs sent to the client; unavailable avatars stay null.
        let picUrl: string | null = null;
        try {
          const fields = 'picture.type(large)';
          const url = `${this.graphApiUrl}/${profileId}?fields=${encodeURIComponent(fields)}&access_token=${pageAccessToken}`;
          const resp = await fetch(url);
          const data = (await resp.json()) as any;
          // Errors (e.g. non-user profiles such as applications) are ignored on purpose
          if (!data?.error) {
            picUrl = data?.picture?.data?.url || null;
          }
        } catch {
          picUrl = null;
        }
        profileCache.set(profileId, picUrl);
      }
      const url = profileCache.get(profileId);
      if (url) {
        profile.picture = { data: { url } };
      }
    };

    for (const post of posts) {
      await enrichProfile(post?.from);
      const comments = post?.comments?.data || [];
      for (const comment of comments) {
        await enrichProfile(comment?.from);
        const replies = comment?.comments?.data || [];
        for (const reply of replies) {
          await enrichProfile(reply?.from);
        }
      }
    }
  }

  // ─── Meta app webhooks (object "instagram") ───

  /**
   * Meta delivers Page events (Messenger) and Instagram events through two separate webhook objects of the
   * app. Connecting a page only subscribes the account; without an "instagram" webhook on the app Meta has
   * nowhere to send Instagram messages, read receipts or comments, and only the polling safety net works.
   */
  /** Events each connected Instagram account is subscribed to (Send API / webhooks of the account). */
  static readonly INSTAGRAM_ACCOUNT_FIELDS = [
    'messages',
    'messaging_postbacks',
    'messaging_seen',
    'comments',
    'mentions',
    'message_reactions',
    'message_edit',
  ];

  static readonly INSTAGRAM_APP_FIELDS = [
    'messages',
    'messaging_seen',
    'messaging_postbacks',
    'message_reactions',
    'comments',
  ];

  private async readAppSubscriptions(): Promise<{
    appId: string;
    appToken: string;
    verifyToken: string;
    subscriptions: any[];
  }> {
    const cfg = this.getGlobalAppConfig();
    if (!cfg) throw new Error('FACEBOOK_APP_ID / FACEBOOK_APP_SECRET no están configurados');
    const appToken = `${cfg.appId}|${cfg.appSecret}`;
    const resp = await fetch(
      `${this.graphApiUrl}/${cfg.appId}/subscriptions?access_token=${encodeURIComponent(appToken)}`,
    );
    const data = (await resp.json().catch(() => ({}))) as any;
    if (data?.error) throw new Error(data.error.message || 'Meta rechazó la consulta de webhooks');
    return {
      appId: cfg.appId,
      appToken,
      verifyToken: cfg.verifyToken,
      subscriptions: Array.isArray(data?.data) ? data.data : [],
    };
  }

  /** Read-only: what the Meta app is set to receive for Instagram. */
  async getInstagramAppWebhookStatus(): Promise<{
    configured: boolean;
    fields: string[];
    missing: string[];
    callbackUrl?: string;
    error?: string;
  }> {
    const required = FacebookService.INSTAGRAM_APP_FIELDS;
    try {
      const { subscriptions } = await this.readAppSubscriptions();
      const ig = subscriptions.find((x) => x.object === 'instagram');
      const fields: string[] = (ig?.fields || []).map((f: any) => f.name);
      const missing = required.filter((f) => !fields.includes(f));
      return {
        configured: !!ig && ig.active !== false && missing.length === 0,
        fields,
        missing,
        callbackUrl: ig?.callback_url,
      };
    } catch (e: any) {
      return { configured: false, fields: [], missing: required, error: e?.message || String(e) };
    }
  }

  /**
   * Makes sure the app has an active "instagram" webhook with the fields we need. Additive and idempotent:
   * existing fields are kept, nothing is removed, and it does nothing when everything is already set.
   */
  async ensureInstagramAppWebhook(): Promise<{
    status: 'ok' | 'created' | 'updated' | 'error';
    message: string;
    fields?: string[];
  }> {
    const required = FacebookService.INSTAGRAM_APP_FIELDS;
    try {
      const { appId, appToken, verifyToken, subscriptions } = await this.readAppSubscriptions();
      if (!verifyToken) {
        return { status: 'error', message: 'FACEBOOK_VERIFY_TOKEN no está configurado en el servidor' };
      }
      const ig = subscriptions.find((x) => x.object === 'instagram');
      const page = subscriptions.find((x) => x.object === 'page');
      const current: string[] = (ig?.fields || []).map((f: any) => f.name);
      const missing = required.filter((f) => !current.includes(f));
      if (ig && ig.active !== false && missing.length === 0) {
        return { status: 'ok', message: 'El webhook de Instagram ya estaba configurado', fields: current };
      }

      const prefix = this.configService.get<string>('API_PREFIX') || 'api/v1';
      const base = (
        this.configService.get<string>('BACKEND_URL') ||
        this.configService.get<string>('API_URL') ||
        ''
      ).replace(/\/+$/, '');
      // Reuse the URL that already works for Messenger so both objects point to the same endpoint
      const callbackUrl = ig?.callback_url || page?.callback_url || (base ? `${base}/${prefix}/webhook/facebook` : '');
      if (!callbackUrl) {
        return { status: 'error', message: 'No se pudo determinar la URL pública del webhook (BACKEND_URL)' };
      }

      const fields = [...new Set([...current, ...required])];
      const resp = await fetch(`${this.graphApiUrl}/${appId}/subscriptions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          object: 'instagram',
          callback_url: callbackUrl,
          fields: fields.join(','),
          verify_token: verifyToken,
          access_token: appToken,
        }).toString(),
      });
      const data = (await resp.json().catch(() => ({}))) as any;
      if (data?.error || data?.success === false) {
        const reason = data?.error?.message || 'Meta rechazó la configuración';
        this.logger.warn(`[Meta] Could not configure the Instagram webhook: ${reason}`);
        return { status: 'error', message: reason };
      }
      this.logger.log(`[Meta] Instagram webhook ${ig ? 'updated' : 'created'}: ${fields.join(', ')}`);
      return {
        status: ig ? 'updated' : 'created',
        message: ig ? 'Webhook de Instagram actualizado' : 'Webhook de Instagram creado',
        fields,
      };
    } catch (e: any) {
      return { status: 'error', message: e?.message || String(e) };
    }
  }

  /** What the UI needs to tell the user whether Instagram will really receive events. */
  async getInstagramLinkStatus(
    tenantId: string,
    instagramAccountId?: string,
  ): Promise<{
    linked: boolean;
    webhookSubscribed?: boolean;
    webhookError?: string | null;
    appWebhook?: { status: string; message: string } | null;
  }> {
    if (!instagramAccountId) return { linked: false };
    const ig = await this.socialAccountModel
      .findOne({
        tenantId: new Types.ObjectId(tenantId),
        platform: SocialPlatform.INSTAGRAM,
        accountId: instagramAccountId,
        status: SocialAccountStatus.CONNECTED,
      })
      .select('metadata')
      .lean();
    if (!ig) return { linked: false };
    return {
      linked: true,
      webhookSubscribed: ig.metadata?.webhookSubscribed !== false,
      webhookError: ig.metadata?.webhookError ?? null,
      appWebhook: ig.metadata?.appWebhook ?? null,
    };
  }

  private realtimeChecking = false;

  onModuleInit() {
    if (this.configService.get<string>('META_AUTOHEAL_ENABLED') === 'false') return;
    // Do not block start-up: give the server a moment, then make sure Instagram is wired to push events
    setTimeout(() => {
      this.ensureInstagramRealtime().catch((e) =>
        this.logger.warn(`[Meta Auto-Heal] ${e?.message || e}`),
      );
    }, 15_000);
  }

  /** Real time must not depend on anyone pressing a button: re-verify it every hour. */
  @Cron('0 * * * *')
  async autoHealInstagramRealtime() {
    if (this.configService.get<string>('META_AUTOHEAL_ENABLED') === 'false') return;
    await this.ensureInstagramRealtime().catch((e) =>
      this.logger.warn(`[Meta Auto-Heal] ${e?.message || e}`),
    );
  }

  /**
   * Makes Instagram push events to us: the app-level webhook, plus each account's own subscription
   * (only re-subscribes what is missing). Idempotent and additive. The outcome is stored on each account so
   * the UI only warns when something is genuinely wrong.
   */
  async ensureInstagramRealtime(): Promise<{
    checked: number;
    fixed: number;
    failed: number;
    appWebhook?: { status: string; message: string };
  }> {
    if (this.realtimeChecking) return { checked: 0, fixed: 0, failed: 0 };
    this.realtimeChecking = true;
    try {
      const igAccounts = await this.socialAccountModel.find({
        platform: SocialPlatform.INSTAGRAM,
        status: SocialAccountStatus.CONNECTED,
      });
      if (igAccounts.length === 0) return { checked: 0, fixed: 0, failed: 0 };

      const app = await this.ensureInstagramAppWebhook();
      const appError = app.status === 'error' ? app.message : null;
      let fixed = app.status === 'created' || app.status === 'updated' ? 1 : 0;
      let failed = 0;

      for (const ig of igAccounts) {
        let accountError: string | null = null;
        try {
          const fb = await this.socialAccountModel.findOne({
            tenantId: ig.tenantId,
            platform: SocialPlatform.FACEBOOK,
            pageId: ig.pageId,
            status: SocialAccountStatus.CONNECTED,
          });
          const token = fb?.accessToken || ig.accessToken;
          if (!ig.accountId || !token) throw new Error('Falta el token de la página vinculada');

          const resp = await fetch(
            `${this.graphApiUrl}/${ig.accountId}/subscribed_apps?access_token=${encodeURIComponent(token)}`,
          );
          const data = (await resp.json().catch(() => ({}))) as any;
          if (data?.error) throw new Error(data.error.message || 'Meta rechazó la consulta');
          const have: string[] = (data?.data || []).flatMap((a: any) => a.subscribed_fields || []);
          const missing = FacebookService.INSTAGRAM_ACCOUNT_FIELDS.filter((f) => !have.includes(f));
          if (missing.length > 0) {
            await this.subscribeInstagramToWebhook(ig.accountId, token);
            fixed++;
            this.logger.log(`[Meta Auto-Heal] @${ig.accountName} re-subscribed (missing: ${missing.join(', ')})`);
          }
        } catch (e: any) {
          accountError = e?.message || String(e);
          failed++;
          this.logger.warn(`[Meta Auto-Heal] @${ig.accountName}: ${accountError}`);
        }

        const error = accountError || appError;
        await this.socialAccountModel
          .updateOne(
            { _id: ig._id },
            {
              $set: {
                'metadata.realtime': { ok: !error, error, checkedAt: new Date() },
                'metadata.webhookSubscribed': !accountError,
                'metadata.webhookError': accountError,
              },
            },
          )
          .catch(() => undefined);
      }
      return { checked: igAccounts.length, fixed, failed, appWebhook: { status: app.status, message: app.message } };
    } finally {
      this.realtimeChecking = false;
    }
  }

  /** Manual fallback for the rare case where Meta keeps refusing (shown only when something is wrong). */
  async repairInstagramRealtime(tenantId: string) {
    const result = await this.ensureInstagramRealtime();
    return {
      appWebhook: result.appWebhook ?? { status: 'ok', message: 'Sin cuentas de Instagram conectadas' },
      accounts: { checked: result.checked, fixed: result.fixed, failed: result.failed },
    };
  }

  // ─── Instagram comments (live from the Graph API) ───

  private async getConnectedInstagram(
    tenantId: string,
    accountId: string,
  ): Promise<SocialAccountDocument> {
    const account = await this.socialAccountModel.findOne({
      tenantId: new Types.ObjectId(tenantId),
      platform: SocialPlatform.INSTAGRAM,
      accountId,
      status: SocialAccountStatus.CONNECTED,
    });
    if (!account?.accessToken) {
      throw new BadRequestException(
        'Instagram account not connected or missing access token',
      );
    }
    return account;
  }

  private async igGraph(
    account: SocialAccountDocument,
    path: string,
    method: 'GET' | 'POST' | 'DELETE' = 'GET',
    params: Record<string, string> = {},
  ): Promise<any> {
    const body = new URLSearchParams({
      ...params,
      access_token: account.accessToken!,
    });
    const url = `${this.graphApiUrl}/${path}`;
    const resp =
      method === 'GET'
        ? await fetch(`${url}?${body.toString()}`)
        : await fetch(method === 'DELETE' ? `${url}?${body}` : url, {
            method,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: method === 'POST' ? body.toString() : undefined,
          });
    const data = (await resp.json().catch(() => ({}))) as any;
    if (data?.error) {
      if (data.error.code === 190) {
        await this.socialAccountModel.updateOne(
          { _id: account._id },
          { $set: { status: SocialAccountStatus.ERROR } },
        );
      }
      throw new BadRequestException(
        data.error.message || 'Instagram request failed',
      );
    }
    return data;
  }

  /** Recent Instagram posts with their comments, shaped like the Facebook feed so the UI can share its layout. */
  async getInstagramFeed(
    tenantId: string,
    accountId: string,
    limit = 20,
  ): Promise<{ accountId: string; posts: any[] }> {
    const account = await this.getConnectedInstagram(tenantId, accountId);
    const reply = 'id,text,username,timestamp,like_count,hidden';
    const fields = [
      'id',
      'caption',
      'media_type',
      'media_url',
      'thumbnail_url',
      'permalink',
      'timestamp',
      'like_count',
      'comments_count',
      `comments.limit(50){${reply},replies.limit(50){${reply}}}`,
    ].join(',');
    const data = await this.igGraph(account, `${accountId}/media`, 'GET', {
      fields,
      limit: String(Math.min(Math.max(limit, 1), 50)),
    });

    const ownName = (account.accountName || '').toLowerCase();
    const toComment = (c: any, parentId?: string) => ({
      id: c.id,
      from: {
        id: c.username || 'instagram',
        name: c.username ? `@${c.username}` : 'Instagram',
        isOwn: !!c.username && c.username.toLowerCase() === ownName,
      },
      message: c.text || '',
      created_time: c.timestamp,
      like_count: c.like_count || 0,
      hidden: !!c.hidden,
      ...(parentId ? { parent: { id: parentId } } : {}),
    });

    const posts = (Array.isArray(data?.data) ? data.data : []).map(
      (m: any) => {
        const flat: any[] = [];
        for (const c of m.comments?.data || []) {
          flat.push(toComment(c));
          for (const r of c.replies?.data || []) flat.push(toComment(r, c.id));
        }
        return {
          id: m.id,
          message: m.caption || '',
          full_picture: m.media_type === 'VIDEO' ? m.thumbnail_url : m.media_url,
          permalink_url: m.permalink,
          created_time: m.timestamp,
          media_type: m.media_type,
          like_count: m.like_count || 0,
          comments_count: m.comments_count ?? flat.length,
          comments: { data: flat },
        };
      },
    );
    return { accountId, posts };
  }

  /** Reply to a comment (commentId) or add a new top-level comment on a post (mediaId). */
  async replyToInstagramComment(
    tenantId: string,
    accountId: string,
    message: string,
    target: { commentId?: string; mediaId?: string },
  ): Promise<{ success: boolean; commentId?: string }> {
    const text = (message || '').trim();
    if (!text) throw new BadRequestException('message is required');
    if (!target.commentId && !target.mediaId) {
      throw new BadRequestException('commentId or mediaId is required');
    }
    const account = await this.getConnectedInstagram(tenantId, accountId);
    const path = target.commentId
      ? `${target.commentId}/replies`
      : `${target.mediaId}/comments`;
    const data = await this.igGraph(account, path, 'POST', { message: text });
    return { success: true, commentId: data?.id };
  }

  async hideInstagramComment(
    tenantId: string,
    accountId: string,
    commentId: string,
    hide: boolean,
  ): Promise<{ success: boolean }> {
    const account = await this.getConnectedInstagram(tenantId, accountId);
    await this.igGraph(account, commentId, 'POST', { hide: String(hide) });
    return { success: true };
  }

  async deleteInstagramComment(
    tenantId: string,
    accountId: string,
    commentId: string,
  ): Promise<{ success: boolean }> {
    const account = await this.getConnectedInstagram(tenantId, accountId);
    await this.igGraph(account, commentId, 'DELETE');
    return { success: true };
  }

  // Get tenant-specific Facebook config from database (DEPRECATED - kept for migration)
  private async getTenantConfig(
    tenantId: string,
  ): Promise<FacebookConfigDocument | null> {
    return this.facebookConfigModel.findOne({
      tenantId: new Types.ObjectId(tenantId),
      isActive: true,
    });
  }

  get graphApiVersion(): string {
    const v =
      this.configService.get<string>('FACEBOOK_GRAPH_VERSION') || 'v23.0';
    return v.startsWith('v') ? v : `v${v}`;
  }

  get graphApiUrl(): string {
    return `https://graph.facebook.com/${this.graphApiVersion}`;
  }

  // ─── Config Management ───

  async saveFacebookConfig(
    tenantId: string,
    appId: string,
    appSecret?: string,
    verifyToken?: string,
  ): Promise<FacebookConfig> {
    const updateData: any = {
      tenantId: new Types.ObjectId(tenantId),
      appId,
      verifyToken: verifyToken || 'axentyc_fb_verify',
      isActive: true,
    };

    // Only update appSecret if a real value is provided
    if (appSecret && !appSecret.includes('•')) {
      updateData.appSecret = appSecret;
    }

    const config = await this.facebookConfigModel.findOneAndUpdate(
      { tenantId: new Types.ObjectId(tenantId) },
      updateData,
      { upsert: true, new: true },
    );

    this.logger.log(
      `Facebook config saved for tenant ${tenantId} (secret ${appSecret && !appSecret.includes('•') ? 'updated' : 'preserved'})`,
    );
    return config;
  }

  async getFacebookConfig(tenantId: string): Promise<FacebookConfig | null> {
    return this.facebookConfigModel.findOne({
      tenantId: new Types.ObjectId(tenantId),
    });
  }

  async deleteFacebookConfig(tenantId: string): Promise<void> {
    await this.facebookConfigModel.deleteOne({
      tenantId: new Types.ObjectId(tenantId),
    });
    this.logger.log(`Facebook config deleted for tenant ${tenantId}`);
  }

  // ─── OAuth Flow ───

  // Signed, expiring OAuth `state` bound to tenant + user (CSRF protection)
  private signOAuthState(tenantId: string, userId: string): string {
    const secret = this.configService.get<string>('FACEBOOK_APP_SECRET') || '';
    const payload = Buffer.from(
      JSON.stringify({
        t: tenantId,
        u: userId,
        ts: Date.now(),
        n: randomUUID(),
      }),
    ).toString('base64url');
    const sig = createHmac('sha256', secret)
      .update(`fb-oauth-state:${payload}`)
      .digest('base64url');
    return `${payload}.${sig}`;
  }

  verifyOAuthState(
    state: string | undefined,
    tenantId: string,
    userId: string,
  ): void {
    const secret = this.configService.get<string>('FACEBOOK_APP_SECRET') || '';
    const invalid = () =>
      new BadRequestException(
        'Invalid or expired OAuth state. Please restart the Facebook connection.',
      );
    if (!state || typeof state !== 'string' || !secret) throw invalid();
    const [payload, sig] = state.split('.');
    if (!payload || !sig) throw invalid();
    const expected = createHmac('sha256', secret)
      .update(`fb-oauth-state:${payload}`)
      .digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw invalid();
    let data: any;
    try {
      data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      throw invalid();
    }
    const maxAgeMs = 30 * 60 * 1000;
    if (
      data?.t !== tenantId ||
      data?.u !== userId ||
      !data?.ts ||
      Date.now() - data.ts > maxAgeMs
    ) {
      throw invalid();
    }
  }

  async getOAuthUrl(
    tenantId: string,
    userId: string,
    redirectUri: string,
  ): Promise<string | null> {
    const config = this.getGlobalAppConfig();
    if (!config) {
      this.logger.warn('Facebook app not configured');
      return null;
    }

    const scopes = [
      'pages_messaging',
      'pages_manage_metadata',
      'pages_read_engagement',
      'pages_manage_engagement',
      'pages_show_list',
      'instagram_basic',
      'instagram_manage_messages',
      'instagram_manage_comments',
      'pages_read_user_content',
      'business_management',
    ].join(',');

    const params = new URLSearchParams({
      client_id: config.appId,
      redirect_uri: redirectUri,
      scope: scopes,
      response_type: 'code',
      state: this.signOAuthState(tenantId, userId),
      auth_type: 'rerequest',
    });

    return `https://www.facebook.com/${this.graphApiVersion}/dialog/oauth?${params.toString()}`;
  }

  async exchangeCodeForToken(
    tenantId: string,
    code: string,
    redirectUri: string,
  ): Promise<{
    accessToken: string;
    expiresIn: number;
  }> {
    const config = this.getGlobalAppConfig();
    if (!config) {
      throw new BadRequestException('Facebook app not configured');
    }

    this.logger.log(
      `[exchangeCodeForToken] Starting - appId: ${config.appId}, redirectUri: ${redirectUri}`,
    );

    const url = `${this.graphApiUrl}/oauth/access_token?client_id=${config.appId}&client_secret=${config.appSecret}&redirect_uri=${encodeURIComponent(redirectUri)}&code=${code}`;

    const response = await fetch(url);
    const data = (await response.json()) as any;

    this.logger.log(
      `[exchangeCodeForToken] Facebook response: ${JSON.stringify({ hasToken: !!data.access_token, expiresIn: data.expires_in, error: data.error || null })}`,
    );

    if (data.error) {
      this.logger.error(
        `[exchangeCodeForToken] Facebook OAuth error: ${JSON.stringify(data.error)}`,
      );
      throw new BadRequestException(
        data.error.message || 'Failed to exchange code',
      );
    }

    return {
      accessToken: data.access_token,
      expiresIn: data.expires_in,
    };
  }

  async getLongLivedToken(
    tenantId: string,
    shortLivedToken: string,
  ): Promise<{
    accessToken: string;
    expiresIn: number;
  }> {
    const config = this.getGlobalAppConfig();
    if (!config) {
      throw new BadRequestException('Facebook app not configured');
    }

    const url = `${this.graphApiUrl}/oauth/access_token?grant_type=fb_exchange_token&client_id=${config.appId}&client_secret=${config.appSecret}&fb_exchange_token=${shortLivedToken}`;

    const response = await fetch(url);
    const data = (await response.json()) as any;

    if (data.error) {
      this.logger.warn(
        `Long-lived token error: ${JSON.stringify(data.error)} — falling back to short-lived token`,
      );
      return { accessToken: shortLivedToken, expiresIn: 3600 };
    }

    this.logger.log(
      `Long-lived token obtained, expires in ${data.expires_in}s`,
    );

    return {
      accessToken: data.access_token,
      expiresIn: data.expires_in || 5184000, // ~60 days
    };
  }

  async getUserPages(userAccessToken: string): Promise<any[]> {
    // First, verify the user info
    try {
      const meUrl = `${this.graphApiUrl}/me?access_token=${userAccessToken}&fields=id,name`;
      const meResponse = await fetch(meUrl);
      const meData = (await meResponse.json()) as any;
      this.logger.log(`[getUserPages] User info: ${JSON.stringify(meData)}`);
    } catch (err) {
      this.logger.warn(
        `[getUserPages] Could not fetch user info: ${err.message}`,
      );
    }

    let fbUserId: string | undefined;
    try {
      const meResp = await fetch(
        `${this.graphApiUrl}/me?access_token=${userAccessToken}&fields=id`,
      );
      fbUserId = ((await meResp.json()) as any)?.id;
    } catch {
      fbUserId = undefined;
    }

    // Check token permissions
    const debugUrl = `${this.graphApiUrl}/me/permissions?access_token=${userAccessToken}`;
    try {
      const debugResponse = await fetch(debugUrl);
      const debugData = (await debugResponse.json()) as any;
      this.logger.log(
        `[getUserPages] Token permissions checked: ${Array.isArray(debugData?.data) ? debugData.data.map((item: any) => `${item.permission}:${item.status}`).join(',') : 'unavailable'}`,
      );
    } catch (err) {
      this.logger.warn(
        `[getUserPages] Could not fetch token permissions: ${err.message}`,
      );
    }

    const url = `${this.graphApiUrl}/me/accounts?access_token=${userAccessToken}&fields=id,name,access_token,picture,category,fan_count,instagram_business_account`;

    this.logger.log('[getUserPages] Fetching pages from Facebook');

    const response = await fetch(url);
    const data = (await response.json()) as any;

    this.logger.log(
      `[getUserPages] Facebook returned ${Array.isArray(data.data) ? data.data.length : 0} page(s)`,
    );

    if (data.error) {
      this.logger.error(
        `[getUserPages] Facebook API error: ${JSON.stringify(data.error)}`,
      );
      throw new BadRequestException(
        data.error.message || 'Failed to get pages',
      );
    }

    if (!data.data || data.data.length === 0) {
      this.logger.warn(
        `[getUserPages] No pages found for user. User may not be admin of any page or didn't select pages during OAuth.`,
      );
      this.logger.warn(
        `[getUserPages] IMPORTANT: Check if the user selected pages during OAuth flow, or if the app has 'pages_show_list' permission approved.`,
      );
    }

    const pages = await Promise.all(
      (data.data || []).map(async (page: any) => {
      let instagramAccount = null;
      let instagramLinked = false;
      let instagramError = null;
      
      // Check if page has Instagram Business Account linked
      if (page.instagram_business_account?.id) {
        try {
          const igData = await this.getInstagramAccountInfo(
            page.instagram_business_account.id,
              page.access_token,
          );
          instagramAccount = igData;
          instagramLinked = true;
        } catch (err: any) {
          instagramError = err.message;
            this.logger.warn(
              `Failed to get Instagram info for page ${page.id}: ${err.message}`,
            );
        }
      }

      return {
          fbUserId,
        id: page.id,
        name: page.name,
        accessToken: page.access_token,
        picture: page.picture?.data?.url,
        category: page.category,
        fanCount: page.fan_count,
        instagramAccount,
        instagramLinked,
        instagramError,
        hasInstagramBusinessAccount: !!page.instagram_business_account?.id,
      };
      }),
    );

    this.logger.log(
      `[getUserPages] Mapped ${pages.length} pages: ${JSON.stringify(pages.map((p: any) => ({ id: p.id, name: p.name, hasInstagram: p.instagramLinked, igError: p.instagramError })))}`,
    );
    return pages;
  }

  private async getInstagramAccountInfo(
    igAccountId: string,
    pageAccessToken: string,
  ): Promise<any> {
    const url = `${this.graphApiUrl}/${igAccountId}?fields=id,username,name,profile_picture_url,followers_count&access_token=${pageAccessToken}`;
    
    const response = await fetch(url);
    const data = (await response.json()) as any;

    if (data.error) {
      throw new Error(data.error.message);
    }

    return {
      id: data.id,
      username: data.username,
      name: data.name,
      profilePicture: data.profile_picture_url,
      followersCount: data.followers_count,
    };
  }

  createPendingPageSelection(
    tenantId: string,
    pages: any[],
  ): { selectionToken: string; pages: any[] } {
    const selectionToken = randomUUID();
    const expiresAt = Date.now() + 10 * 60 * 1000;

    this.pendingPageSelections.set(selectionToken, {
      tenantId,
      expiresAt,
      pages,
    });

    return {
      selectionToken,
      pages: pages.map((page) => ({
        id: page.id,
        name: page.name,
        picture: page.picture,
        category: page.category,
        fanCount: page.fanCount,
        instagramAccount: page.instagramAccount,
        instagramLinked: page.instagramLinked,
        instagramError: page.instagramError,
        hasInstagramBusinessAccount: page.hasInstagramBusinessAccount,
      })),
    };
  }

  consumePendingPageSelection(
    tenantId: string,
    selectionToken: string,
    pageId: string,
  ): any {
    const selection = this.pendingPageSelections.get(selectionToken);

    if (
      !selection ||
      selection.tenantId !== tenantId ||
      selection.expiresAt < Date.now()
    ) {
      this.pendingPageSelections.delete(selectionToken);
      throw new BadRequestException(
        'Facebook page selection expired. Please reconnect Facebook.',
      );
    }

    const page = selection.pages.find((item) => item.id === pageId);
    if (!page?.accessToken) {
      throw new BadRequestException(
        'Selected Facebook page is not available. Please reconnect Facebook.',
      );
    }

    return page;
  }

  discardPendingPageSelection(selectionToken: string) {
    this.pendingPageSelections.delete(selectionToken);
  }

  // ─── Connect / Disconnect ───

  async connectPage(
    tenantId: string,
    pageId: string,
    pageName: string,
    pageAccessToken: string,
    metadata?: Record<string, any>,
    workspaceId?: string,
  ): Promise<SocialAccount> {
    const instagramAccount = metadata?.instagramAccount;
    const workspaceObjectId = workspaceId
      ? new Types.ObjectId(workspaceId)
      : undefined;
    const existingAccounts = await this.socialAccountModel.find({
      tenantId: new Types.ObjectId(tenantId),
      isActive: true,
      $or: [
        { platform: SocialPlatform.FACEBOOK, pageId },
        ...(instagramAccount?.id
          ? [
              {
                platform: SocialPlatform.INSTAGRAM,
                accountId: instagramAccount.id,
              },
            ]
          : []),
      ],
    });
    // A page / Instagram account lives in exactly one workspace
    const elsewhere = existingAccounts.find(
      (a) =>
        a.status === SocialAccountStatus.CONNECTED &&
        a.workspaceId &&
        workspaceObjectId &&
        !a.workspaceId.equals(workspaceObjectId),
    );
    if (elsewhere) {
      throw new ConflictException(
        `"${elsewhere.accountName}" ya está conectada en otro workspace de esta cuenta. Desconéctala allí primero.`,
      );
    }

    const existingKeys = new Set(
      existingAccounts.map(
        (account) =>
          `${account.platform}:${account.platform === SocialPlatform.INSTAGRAM ? account.accountId : account.pageId}`,
      ),
    );
    const newAssets = [
      !existingKeys.has(`${SocialPlatform.FACEBOOK}:${pageId}`),
      !!instagramAccount?.id &&
        !existingKeys.has(`${SocialPlatform.INSTAGRAM}:${instagramAccount.id}`),
    ].filter(Boolean).length;

    if (newAssets > 0) {
      await this.billingService.assertCanAddConnectedAssets(
        tenantId,
        newAssets,
      );
    }

    // Subscribe page to webhook (includes Instagram if linked)
    await this.subscribePageToWebhook(pageId, pageAccessToken);

    // Check if page has Instagram linked
    let igWebhookError: string | undefined;
    let igAppWebhook: { status: string; message: string } | undefined;
    if (instagramAccount?.id) {
      this.logger.log(
        `Instagram account @${instagramAccount.username} detected for page ${pageId}`,
      );
      // Subscribe Instagram to webhook (non-blocking: don't fail FB connection if IG fails)
      try {
        await this.subscribeInstagramToWebhook(
          instagramAccount.id,
          pageAccessToken,
        );
      } catch (err) {
        igWebhookError = err.message || 'Instagram webhook subscription failed';
        this.logger.warn(
          `Instagram webhook subscription failed for @${instagramAccount.username}: ${igWebhookError}. Facebook page will still be connected.`,
        );
      }
      // The account subscription alone delivers nothing: the app needs an "instagram" webhook object too
      const ensured = await this.ensureInstagramAppWebhook();
      igAppWebhook = { status: ensured.status, message: ensured.message };
    }

    // Upsert Facebook page account
    const account = await this.socialAccountModel.findOneAndUpdate(
      {
        tenantId: new Types.ObjectId(tenantId),
        platform: SocialPlatform.FACEBOOK,
        pageId,
      },
      {
        tenantId: new Types.ObjectId(tenantId),
        workspaceId: workspaceObjectId,
        platform: SocialPlatform.FACEBOOK,
        provider: IntegrationProvider.META,
        assetType: ConnectedAssetType.FACEBOOK_PAGE,
        capabilities: [
          IntegrationCapability.MESSENGER,
          IntegrationCapability.FACEBOOK_COMMENTS,
        ],
        accountName: pageName,
        pageId,
        accessToken: pageAccessToken,
        status: SocialAccountStatus.CONNECTED,
        tokenExpiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000), // ~60 days
        metadata: metadata || {},
        isActive: true,
      },
      { upsert: true, new: true },
    );

    // If Instagram is linked, create separate Instagram account entry
    if (instagramAccount?.id) {
      await this.socialAccountModel.findOneAndUpdate(
        {
          tenantId: new Types.ObjectId(tenantId),
          platform: SocialPlatform.INSTAGRAM,
          accountId: instagramAccount.id,
        },
        {
          tenantId: new Types.ObjectId(tenantId),
          workspaceId: workspaceObjectId,
          platform: SocialPlatform.INSTAGRAM,
          provider: IntegrationProvider.META,
          assetType: ConnectedAssetType.INSTAGRAM_ACCOUNT,
          capabilities: [
            IntegrationCapability.INSTAGRAM_DM,
            IntegrationCapability.INSTAGRAM_COMMENTS,
          ],
          accountName: instagramAccount.username,
          accountId: instagramAccount.id,
          pageId, // Link back to Facebook page
          accessToken: pageAccessToken, // Same token as page
          status: SocialAccountStatus.CONNECTED,
          tokenExpiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
          metadata: {
            name: instagramAccount.name,
            profilePicture: instagramAccount.profilePicture,
            followersCount: instagramAccount.followersCount,
            linkedPageId: pageId,
            fbUserId: metadata?.fbUserId,
            // Surfaced in the UI: a "connected" account with no webhook never receives events
            webhookSubscribed: !igWebhookError,
            webhookError: igWebhookError || null,
            appWebhook: igAppWebhook ? { ...igAppWebhook, checkedAt: new Date() } : undefined,
          },
          isActive: true,
        },
        { upsert: true, new: true },
      );
      this.logger.log(
        `Instagram account @${instagramAccount.username} connected for tenant ${tenantId}`,
      );
      // Record whether real time is really wired (the UI only warns when this says otherwise)
      void this.ensureInstagramRealtime().catch(() => undefined);
    }

    this.logger.log(
      `Facebook page "${pageName}" (${pageId}) connected for tenant ${tenantId}`,
    );
    return account;
  }

  async disconnect(tenantId: string, accountId: string): Promise<void> {
    const account = await this.socialAccountModel.findOne({
      _id: accountId,
      tenantId: new Types.ObjectId(tenantId),
    });

    if (!account) {
      throw new NotFoundException('Social account not found');
    }

    // Unsubscribe from webhook
    if (account.pageId && account.accessToken) {
      try {
        if (
          account.platform === SocialPlatform.INSTAGRAM &&
          account.accountId
        ) {
          // Unsubscribe Instagram webhook
          const url = `${this.graphApiUrl}/${account.accountId}/subscribed_apps?access_token=${account.accessToken}`;
          await fetch(url, { method: 'DELETE' });
          this.logger.log(
            `Instagram account ${account.accountId} unsubscribed from webhook events`,
          );
        } else {
          await this.unsubscribePageFromWebhook(
            account.pageId,
            account.accessToken,
          );
        }
      } catch (e) {
        this.logger.warn(
          `Failed to unsubscribe ${account.platform} account from webhook: ${e}`,
        );
      }
    }

    account.status = SocialAccountStatus.DISCONNECTED;
    account.accessToken = undefined;
    account.isActive = false;
    await account.save();

    // If disconnecting a Facebook page, also disconnect its linked Instagram account
    if (account.platform === SocialPlatform.FACEBOOK && account.pageId) {
      const igAccount = await this.socialAccountModel.findOne({
        tenantId: new Types.ObjectId(tenantId),
        platform: SocialPlatform.INSTAGRAM,
        pageId: account.pageId,
        status: SocialAccountStatus.CONNECTED,
      });
      if (igAccount) {
        igAccount.status = SocialAccountStatus.DISCONNECTED;
        igAccount.accessToken = undefined;
        igAccount.isActive = false;
        await igAccount.save();
        this.logger.log(
          `Linked Instagram account ${igAccount.accountId} also disconnected`,
        );
      }
    }

    this.logger.log(
      `${account.platform} account "${account.accountName}" disconnected for tenant ${tenantId}`,
    );
  }

  async getStatus(
    tenantId: string,
    workspaceId?: string,
  ): Promise<{
    connected: boolean;
    accounts: SocialAccount[];
  }> {
    const accounts = await this.socialAccountModel
      .find({
        tenantId: new Types.ObjectId(tenantId),
        ...(workspaceId
          ? { workspaceId: new Types.ObjectId(workspaceId) }
          : {}),
        platform: { $in: [SocialPlatform.FACEBOOK, SocialPlatform.INSTAGRAM] },
      })
      .select('-accessToken -refreshToken -webhookSecret')
      .exec();

    return {
      connected: accounts.some(
        (a) => a.status === SocialAccountStatus.CONNECTED,
      ),
      accounts,
    };
  }

  // ─── Webhook Subscription ───

  async diagnoseInstagram(tenantId: string): Promise<any> {
    const igAccounts = await this.socialAccountModel
      .find({
        tenantId: new Types.ObjectId(tenantId),
        platform: SocialPlatform.INSTAGRAM,
      })
      .exec();

    const fbAccounts = await this.socialAccountModel
      .find({
        tenantId: new Types.ObjectId(tenantId),
        platform: SocialPlatform.FACEBOOK,
        status: SocialAccountStatus.CONNECTED,
      })
      .exec();

    // Check if any FB page has instagram_business_account
    const fbPagesWithIg = fbAccounts.filter(
      (a) => a.metadata?.instagramAccount?.id,
    );

    // Check for existing Instagram conversations
    const igConversations = await this.conversationModel
      .find({
        tenantId: new Types.ObjectId(tenantId),
        channel: ConversationChannel.INSTAGRAM,
      })
      .countDocuments();

    // Check webhook subscription status and token validity for each IG account
    const accountsStatus: any[] = [];
    for (const ig of igAccounts) {
      let webhookSubscribed = false;
      let webhookFields: string[] = [];
      let tokenValid = false;
      let tokenError: string | null = null;
      let profileInfo: any = null;

      if (ig.accountId && ig.accessToken) {
        // Test token validity by fetching IG profile
        try {
          const profileUrl = `${this.graphApiUrl}/${ig.accountId}?fields=id,username,name,profile_picture_url&access_token=${ig.accessToken}`;
          const profileResp = await fetch(profileUrl);
          const profileData = (await profileResp.json()) as any;
          if (profileData.error) {
            tokenError = profileData.error.message;
            this.logger.warn(
              `[diagnoseInstagram] Token error for ${ig.accountId}: ${profileData.error.message}`,
            );
          } else {
            tokenValid = true;
            profileInfo = profileData;
          }
        } catch (e: any) {
          tokenError = e.message;
        }

        // Check webhook subscription
        try {
          const url = `${this.graphApiUrl}/${ig.accountId}/subscribed_apps?access_token=${ig.accessToken}`;
          const resp = await fetch(url);
          const data = (await resp.json()) as any;
          if (Array.isArray(data?.data)) {
            webhookSubscribed = data.data.length > 0;
            webhookFields =
              data.data?.flatMap((app: any) => app.subscribed_fields || []) ||
              [];
          }
        } catch (e) {
          this.logger.warn(
            `[diagnoseInstagram] Could not check webhook subscription for ${ig.accountId}`,
          );
        }
      }

      accountsStatus.push({
        accountId: ig.accountId,
        accountName: ig.accountName,
        status: ig.status,
        hasToken: !!ig.accessToken,
        tokenValid,
        tokenError,
        profileInfo,
        pageId: ig.pageId,
        webhookSubscribed,
        webhookFields,
        metadata: ig.metadata,
      });
    }

    const appWebhook = await this.getInstagramAppWebhookStatus();
    return {
      appWebhook,
      instagramConnected: igAccounts.some(
        (a) => a.status === SocialAccountStatus.CONNECTED,
      ),
      instagramAccounts: accountsStatus,
      fbPagesWithInstagram: fbPagesWithIg.map((a) => ({
        pageId: a.pageId,
        accountName: a.accountName,
        instagramAccount: a.metadata?.instagramAccount,
      })),
      instagramConversations: igConversations,
      recommendations: this.getInstagramRecommendations(
        igAccounts,
        fbPagesWithIg,
        igConversations,
      ),
    };
  }

  private getInstagramRecommendations(
    igAccounts: any[],
    fbPagesWithIg: any[],
    igConversations: number,
  ): string[] {
    const recs: string[] = [];
    if (igAccounts.length === 0) {
      if (fbPagesWithIg.length === 0) {
        recs.push(
          'No hay cuentas de Instagram conectadas. Tu página de Facebook no tiene una cuenta de Instagram Business vinculada.',
        );
        recs.push(
          'Para conectar Instagram: ve a Facebook → Configuración de la Página → Instagram → vincula tu cuenta de Instagram Business.',
        );
        recs.push(
          'Después de vincular, desconecta y reconecta la página en AXENTYC.',
        );
      } else {
        recs.push(
          'Tu página de Facebook tiene Instagram vinculado pero no se creó la cuenta de Instagram en AXENTYC.',
        );
        recs.push(
          'Desconecta y reconecta la página de Facebook en AXENTYC para que se cree la cuenta de Instagram.',
        );
      }
    } else {
      const connected = igAccounts.find(
        (a) => a.status === SocialAccountStatus.CONNECTED,
      );
      if (!connected) {
        recs.push(
          'La cuenta de Instagram existe pero no está conectada. Reconecta la página de Facebook.',
        );
      }
      // Check for token errors
      const tokenErrors = igAccounts.filter((a) => a.tokenError);
      if (tokenErrors.length > 0) {
        recs.push(
          '⚠️ El token de acceso de Instagram es inválido: ' +
            tokenErrors[0].tokenError,
        );
        recs.push(
          'Desconecta y reconecta la página de Facebook en AXENTYC para obtener un token nuevo.',
        );
      }
      // Check webhook subscription
      const notSubscribed = igAccounts.filter((a) => !a.webhookSubscribed);
      if (notSubscribed.length > 0) {
        recs.push('⚠️ La cuenta de Instagram no está suscrita a webhooks.');
        recs.push(
          'En Meta Developers → Webhooks → Instagram, verifica que el callback URL esté configurado.',
        );
        recs.push(
          'Luego desconecta y reconecta la página en AXENTYC para re-suscribir.',
        );
      }
    }
    if (igConversations === 0) {
      recs.push('No hay conversaciones de Instagram. Verifica:');
      recs.push(
        '1. Meta Developers → Webhooks → Instagram: callback URL verificado y campos suscritos (messages, comments)',
      );
      recs.push(
        '2. La cuenta de Instagram debe ser Business o Creator (no personal)',
      );
      recs.push(
        '3. En Meta Developers → Roles → Instagram Testers: agrega tu cuenta como tester si la app está en desarrollo',
      );
      recs.push(
        '4. Envía un DM desde otra cuenta de Instagram a la tuya para probar',
      );
    }
    return recs;
  }

  async resubscribeAllPages(tenantId: string): Promise<any> {
    const accounts = await this.socialAccountModel.find({
      tenantId: new Types.ObjectId(tenantId),
      platform: SocialPlatform.FACEBOOK,
      status: SocialAccountStatus.CONNECTED,
    });

    if (accounts.length === 0) {
      return { success: false, message: 'No connected Facebook pages found' };
    }

    const results: any[] = [];
    for (const account of accounts) {
      try {
        await this.subscribePageToWebhook(
          account.pageId!,
          account.accessToken!,
        );
        results.push({
          pageId: account.pageId,
          name: account.accountName,
          status: 'subscribed',
        });
        this.logger.log(
          `Re-subscribed page ${account.accountName} (${account.pageId}) with feed`,
        );
      } catch (err: any) {
        results.push({
          pageId: account.pageId,
          name: account.accountName,
          status: 'error',
          error: err.message,
        });
        this.logger.error(
          `Failed to re-subscribe page ${account.pageId}:`,
          err,
        );
      }
    }

    return { success: true, results };
  }

  async resubscribeInstagramWebhook(tenantId: string): Promise<any> {
    const igAccounts = await this.socialAccountModel.find({
      tenantId: new Types.ObjectId(tenantId),
      platform: SocialPlatform.INSTAGRAM,
      status: SocialAccountStatus.CONNECTED,
    });

    if (igAccounts.length === 0) {
      return {
        success: false,
        message: 'No connected Instagram accounts found',
      };
    }

    const results: any[] = [];
    for (const ig of igAccounts) {
      try {
        // Get the linked Facebook page's access token
        const fbAccount = await this.socialAccountModel.findOne({
          tenantId: new Types.ObjectId(tenantId),
          platform: SocialPlatform.FACEBOOK,
          pageId: ig.pageId,
          status: SocialAccountStatus.CONNECTED,
        });

        if (!fbAccount?.accessToken) {
          results.push({
            igId: ig.accountId,
            name: ig.accountName,
            status: 'error',
            error: 'No Facebook page token found',
          });
          continue;
        }

        await this.subscribeInstagramToWebhook(
          ig.accountId!,
          fbAccount.accessToken,
        );
        results.push({
          igId: ig.accountId,
          name: ig.accountName,
          status: 'subscribed',
        });
        this.logger.log(
          `Re-subscribed Instagram account ${ig.accountName} (${ig.accountId}) to webhooks`,
        );
      } catch (err: any) {
        results.push({
          igId: ig.accountId,
          name: ig.accountName,
          status: 'error',
          error: err.message,
        });
        this.logger.error(
          `Failed to re-subscribe Instagram ${ig.accountId}:`,
          err,
        );
      }
    }

    return { success: true, results };
  }

  private async subscribePageToWebhook(
    pageId: string,
    pageAccessToken: string,
  ): Promise<void> {
    const url = `${this.graphApiUrl}/${pageId}/subscribed_apps`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        access_token: pageAccessToken,
        subscribed_fields: [
          'messages',
          'message_echoes',
          'messaging_postbacks',
          'message_reads',
          'message_deliveries',
          'feed',
        ],
      }),
    });

    const data = (await response.json()) as any;
    if (data.error) {
      this.logger.error('Failed to subscribe page to webhook:', data.error);
      throw new BadRequestException(
        data.error.message || 'Failed to subscribe page',
      );
    }

    this.logger.log(`Page ${pageId} subscribed to webhook events`);
  }

  private async unsubscribePageFromWebhook(
    pageId: string,
    pageAccessToken: string,
  ): Promise<void> {
    const url = `${this.graphApiUrl}/${pageId}/subscribed_apps?access_token=${pageAccessToken}`;
    await fetch(url, { method: 'DELETE' });
    this.logger.log(`Page ${pageId} unsubscribed from webhook events`);
  }

  private async subscribeInstagramToWebhook(
    igAccountId: string,
    pageAccessToken: string,
  ): Promise<void> {
    const url = `${this.graphApiUrl}/${igAccountId}/subscribed_apps`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        access_token: pageAccessToken,
        subscribed_fields: FacebookService.INSTAGRAM_ACCOUNT_FIELDS,
      }),
    });

    const data = (await response.json()) as any;
    if (data.error) {
      this.logger.error(
        'Failed to subscribe Instagram to webhook:',
        data.error,
      );
      throw new BadRequestException(
        data.error.message || 'Failed to subscribe Instagram',
      );
    }

    this.logger.log(
      `Instagram account ${igAccountId} subscribed to webhook events`,
    );
  }

  // ─── Webhook Handler ───

  async verifyWebhook(
    mode: string,
    token: string,
    challenge: string,
  ): Promise<string> {
    if (mode !== 'subscribe') {
      throw new BadRequestException('Invalid mode');
    }

    // Check global verify token from env
    const globalConfig = this.getGlobalAppConfig();
    if (
      globalConfig &&
      globalConfig.verifyToken &&
      token === globalConfig.verifyToken
    ) {
      this.logger.log('Facebook webhook verified with global token');
      return challenge;
    }

    this.logger.warn('Webhook verification failed - verify token mismatch');
    throw new BadRequestException('Webhook verification failed');
  }

  async handleWebhook(body: any): Promise<void> {
    // Handle both Facebook Page and Instagram webhooks
    this.logger.log(
      `[Webhook] Processing ${body.object} webhook with ${body.entry?.length || 0} entries`,
    );
    
    if (body.object === 'page') {
      await this.handlePageWebhook(body);
    } else if (body.object === 'instagram') {
      await this.handleInstagramWebhook(body);
    } else {
      this.logger.warn(`[Webhook] Unknown object type: ${body.object}`);
    }
  }

  private async handlePageWebhook(body: any): Promise<void> {
    for (const entry of body.entry || []) {
      const pageId = entry.id;

      // Check if this page has an Instagram account linked
      const igAccount = await this.socialAccountModel.findOne({
        pageId,
        platform: SocialPlatform.INSTAGRAM,
        status: SocialAccountStatus.CONNECTED,
      });

      // Handle messaging events (Messenger DMs or Instagram DMs)
      for (const event of entry.messaging || []) {
        try {
          if (event.message && !event.message.is_echo) {
            const recipientId = event.recipient?.id;
            
            // Determine channel by recipient.id:
            // - If recipient.id === pageId → Facebook Messenger
            // - If recipient.id === instagramBusinessAccountId → Instagram DM
            let platform: 'facebook' | 'instagram' = 'facebook';
            let accountId = pageId;
            
            if (igAccount && recipientId === igAccount.accountId) {
              // Instagram DM (recipient is the Instagram Business Account ID)
              platform = 'instagram';
              accountId = igAccount.accountId;
              this.markInstagramWebhook(String(igAccount.accountId));
              this.logger.log(
                `[Page Webhook] Detected Instagram DM (recipient: ${recipientId})`,
              );
            } else if (recipientId === pageId) {
              // Facebook Messenger (recipient is the Page ID)
              platform = 'facebook';
              accountId = pageId;
              this.logger.log(
                `[Page Webhook] Detected Facebook Messenger (recipient: ${recipientId})`,
              );
            } else {
              // Fallback: if recipient doesn't match, assume Messenger
              this.logger.warn(
                `[Page Webhook] Unknown recipient: ${recipientId}, defaulting to Messenger`,
              );
            }
            
            await this.handleIncomingMessage(accountId, event, platform);
          } else if (event.message?.is_echo) {
            // Echo of a message sent by the page/IG account (from AXENTYC or from outside it)
            const isIgEcho =
              !!igAccount && event.sender?.id === igAccount.accountId;
            await this.handleIncomingMessage(
              isIgEcho ? igAccount!.accountId! : pageId,
              event,
              isIgEcho ? 'instagram' : 'facebook',
            );
          } else if (event.read) {
            const isIgRead =
              !!igAccount && event.recipient?.id === igAccount.accountId;
            await this.handleMessageRead(
              isIgRead ? String(igAccount!.accountId) : pageId,
              event,
              isIgRead ? 'instagram' : 'facebook',
            );
          } else if (event.delivery) {
            this.logger.debug('Message delivered');
          } else if (event.postback) {
            await this.handlePostback(pageId, event);
          }
        } catch (err) {
          this.logger.error(
            `Error processing webhook event for page ${pageId}:`,
            err,
          );
        }
      }

      // Handle feed events (Comments on posts)
      if (entry.changes && entry.changes.length > 0) {
        this.logger.log(
          `[Feed] Received ${entry.changes.length} change(s) for page ${pageId}`,
        );
      }
      for (const change of entry.changes || []) {
        try {
          this.logger.debug(
            `[Feed] Change field: ${change.field}, value: ${JSON.stringify(change.value)}`,
          );
          if (change.field === 'feed' && change.value) {
            await this.handleFeedComment(pageId, change.value);
          }
        } catch (err) {
          this.logger.error(
            `Error processing feed event for page ${pageId}:`,
            err,
          );
        }
      }
    }
  }

  private async handleInstagramWebhook(body: any): Promise<void> {
    this.logger.log(
      `[IG Webhook] Processing Instagram webhook with ${body.entry?.length || 0} entries`,
    );
    for (const entry of body.entry || []) {
      const igAccountId = entry.id;
      this.markInstagramWebhook(igAccountId);
      this.logger.log(
        `[IG Webhook] Entry ID: ${igAccountId}, messaging events: ${entry.messaging?.length || 0}`,
      );

      // Handle messaging events (Instagram DMs)
      for (const event of entry.messaging || []) {
        try {
          if (event.message && !event.message.is_echo) {
            this.logger.log(
              `[IG Webhook] Incoming IG message from ${event.sender?.id} to ${event.recipient?.id}`,
            );
            this.logger.debug(
              `[IG Webhook] Event payload: ${JSON.stringify(event)}`,
            );
            
            // Instagram messages are sent via the linked Facebook Page
            // Try to find IG account by accountId or pageId
            const igAccount = await this.socialAccountModel.findOne({
              $or: [
                { accountId: igAccountId, platform: SocialPlatform.INSTAGRAM },
                { pageId: igAccountId, platform: SocialPlatform.INSTAGRAM },
              ],
              status: SocialAccountStatus.CONNECTED,
            });
            
            if (!igAccount) {
              this.logger.warn(
                `[IG Webhook] No connected IG account found for ID: ${igAccountId}`,
              );
              // List all IG accounts to help diagnose
              const allIgAccounts = await this.socialAccountModel
                .find({
                platform: SocialPlatform.INSTAGRAM,
                status: SocialAccountStatus.CONNECTED,
                })
                .select('accountId pageId accountName tenantId');
              this.logger.debug(
                `[IG Webhook] Connected IG accounts: ${JSON.stringify(allIgAccounts)}`,
              );
              this.logger.error(
                `[IG Webhook] Cannot process message without connected account. Skipping.`,
              );
              continue;
            }
            
            this.logger.log(
              `[IG Webhook] Found IG account: ${igAccount.accountName} (tenant: ${igAccount.tenantId})`,
            );
            
            // Process message immediately for real-time response
            // Use the IG accountId for lookup (not pageId)
            await this.handleIncomingMessage(
              igAccount.accountId || igAccountId,
              event,
              'instagram',
            );
          } else if (event.message?.is_echo) {
            await this.handleIncomingMessage(igAccountId, event, 'instagram');
          } else if (event.read) {
            await this.handleMessageRead(igAccountId, event, 'instagram');
          }
        } catch (err) {
          this.logger.error(
            `Error processing Instagram webhook event for account ${igAccountId}:`,
            err,
          );
        }
      }

      // Handle comments on Instagram posts
      for (const change of entry.changes || []) {
        try {
          if (change.field === 'comments' && change.value) {
            await this.handleInstagramComment(igAccountId, change.value);
          }
        } catch (err) {
          this.logger.error(
            `Error processing Instagram comment for account ${igAccountId}:`,
            err,
          );
        }
      }
    }
  }

  private async handleIncomingMessage(
    accountId: string,
    event: any,
    platform: 'facebook' | 'instagram',
  ): Promise<void> {
    const message = event.message;
    const isEcho = !!message?.is_echo;
    // For echoes the page/IG account is the sender and the end user is the recipient.
    const senderId = isEcho ? event.recipient?.id : event.sender?.id; // end user (PSID / IGSID)
    const recipientId = isEcho ? event.sender?.id : event.recipient?.id; // our page / IG account

    if (!senderId || !message) return;

    // Messages sent from AXENTYC through our own app are already stored locally
    if (isEcho) {
      const ownAppId = this.configService.get<string>('FACEBOOK_APP_ID');
      if (
        ownAppId &&
        message.app_id &&
        String(message.app_id) === String(ownAppId)
      ) {
        return;
      }
    }

    this.logger.log(
      `${isEcho ? 'Echo' : 'Incoming'} ${platform} message, account ${accountId}`,
    );

    // Find the social account (Facebook page or Instagram account)
    // For Facebook, recipientId is the Page ID. For Instagram, recipientId can vary by payload version.
    // Make the lookup robust by trying multiple combinations when platform is Instagram.
    let account = null as any;
    if (platform === 'facebook') {
      const lookupId = recipientId || accountId;
      this.logger.debug(
        `Looking for facebook account with pageId/accountId: ${lookupId}`,
      );
      account = await this.socialAccountModel.findOne({
        $or: [
          { pageId: lookupId, platform: SocialPlatform.FACEBOOK },
          { accountId: lookupId, platform: SocialPlatform.FACEBOOK },
        ],
        status: SocialAccountStatus.CONNECTED,
      });
    } else {
      // instagram: try recipientId as pageId/accountId and also the function param accountId as accountId/pageId
      const ors: any[] = [];
      if (recipientId) {
        ors.push({ pageId: recipientId, platform: SocialPlatform.INSTAGRAM });
        ors.push({
          accountId: recipientId,
          platform: SocialPlatform.INSTAGRAM,
        });
      }
      if (accountId) {
        ors.push({ accountId: accountId, platform: SocialPlatform.INSTAGRAM });
        ors.push({ pageId: accountId, platform: SocialPlatform.INSTAGRAM });
      }
      this.logger.debug(
        `Looking for instagram account with any of: ${JSON.stringify(ors.map((o) => ({ pageId: o.pageId, accountId: o.accountId })))}`,
      );
      account = await this.socialAccountModel.findOne({
        $or: ors,
        status: SocialAccountStatus.CONNECTED,
      });
    }

    if (!account) {
      this.logger.warn(
        `No connected ${platform} account found (recipientId: ${recipientId}, paramAccountId: ${accountId})`,
      );
      
      // Debug: List all connected accounts for this platform
      const allAccounts = await this.socialAccountModel
        .find({
          platform:
            platform === 'facebook'
              ? SocialPlatform.FACEBOOK
              : SocialPlatform.INSTAGRAM,
        status: SocialAccountStatus.CONNECTED,
        })
        .select('pageId accountId accountName tenantId');
      this.logger.debug(
        `Connected ${platform} accounts in DB: ${JSON.stringify(allAccounts.map((a) => ({ pageId: a.pageId, accountId: a.accountId, name: a.accountName })))}`,
      );
      return;
    }

    const tenantId = account.tenantId.toString();

    // Ignore anything authored by our own page / Instagram account (non-echo self events)
    if (
      !isEcho &&
      (senderId === account.pageId || senderId === account.accountId)
    ) {
      return;
    }

    // Deduplicate webhook retries / re-deliveries by message id
    if (message.mid) {
      const alreadyStored = await this.messageModel.exists({
        tenantId: new Types.ObjectId(tenantId),
        'metadata.externalId': message.mid,
      });
      if (alreadyStored) {
        this.logger.debug(
          `[handleIncomingMessage] Duplicate message ${message.mid} ignored`,
        );
        return;
      }
    }

    // Get or create contact
    this.logger.debug(
      `[handleIncomingMessage] Getting/creating contact for senderId: ${senderId}`,
    );
    // Resolve best access token for profile lookup
    let tokenToUse = account?.accessToken as string | undefined;
    if (platform === 'instagram' && (!tokenToUse || tokenToUse.length < 10)) {
      try {
        const fbAccount = await this.socialAccountModel
          .findOne({
          tenantId: new Types.ObjectId(tenantId),
          platform: SocialPlatform.FACEBOOK,
          pageId: account?.pageId || recipientId || accountId,
          status: SocialAccountStatus.CONNECTED,
          })
          .lean();
        if (fbAccount?.accessToken) {
          tokenToUse = fbAccount.accessToken;
          this.logger.log(
            '[handleIncomingMessage] Using linked Facebook Page access token for Instagram profile lookup',
          );
        } else {
          this.logger.warn(
            '[handleIncomingMessage] No access token found on linked Facebook Page for Instagram profile lookup',
          );
        }
      } catch (e) {
        this.logger.warn(
          `[handleIncomingMessage] Failed to resolve FB page token for IG lookup: ${e instanceof Error ? e.message : e}`,
        );
      }
    }
    const contact = await this.getOrCreateContact(
      tenantId,
      senderId,
      tokenToUse,
      platform,
      account.workspaceId,
    );
    this.logger.log(
      `[handleIncomingMessage] Contact: ${contact._id} (${contact.name})`,
    );

    // Get or create conversation
    this.logger.debug(`[handleIncomingMessage] Getting/creating conversation`);
    const conversation = await this.getOrCreateConversation(
      tenantId,
      contact._id.toString(),
      senderId,
      accountId,
      platform,
      account.accountName,
    );
    this.logger.log(
      `[handleIncomingMessage] Conversation: ${conversation._id} (new: ${conversation.isNew !== false})`,
    );

    // Determine message type and content
    let content = message.text || '';
    let type: MessageType | string = 'text';
    let media: any = undefined;

    if (message.attachments?.length > 0) {
      const attachment = message.attachments[0];
      if (attachment.type === 'image') {
        type = 'image';
        media = { url: attachment.payload?.url, mimeType: 'image/jpeg' };
        content = content || '[Imagen]';
      } else if (attachment.type === 'video') {
        type = 'video';
        media = { url: attachment.payload?.url, mimeType: 'video/mp4' };
        content = content || '[Video]';
      } else if (attachment.type === 'audio') {
        type = 'audio';
        media = { url: attachment.payload?.url, mimeType: 'audio/mpeg' };
        content = content || '[Audio]';
      } else if (attachment.type === 'file') {
        type = 'file';
        media = {
          url: attachment.payload?.url,
          fileName: attachment.payload?.name,
        };
        content = content || '[Archivo]';
      } else if (attachment.type === 'location') {
        type = 'text';
        const coords = attachment.payload?.coordinates;
        content = coords
          ? `📍 Ubicación: ${coords.lat}, ${coords.long}`
          : '[Ubicación]';
      }
    }

    // Add message to conversation
    const newMessage = new this.messageModel({
      tenantId: new Types.ObjectId(tenantId),
      workspaceId: (conversation as any).workspaceId,
      conversationId: conversation._id,
      direction: isEcho ? MessageDirection.OUTBOUND : MessageDirection.INBOUND,
      type,
      content,
      media,
      senderName: isEcho ? account.accountName : contact.name,
      status: MessageStatus.SENT,
      metadata: {
        externalId: message.mid,
        platform,
        pageName: account.accountName,
        ...(isEcho ? { sentExternally: true } : {}),
      },
    });
    const savedMessage = await newMessage.save();
    const messageObj = savedMessage.toObject();

    // Update conversation
    const isBeingViewed = this.eventsGateway.isConversationBeingViewed(
      conversation._id.toString(),
    );
    const updatedConv = await this.conversationModel
      .findByIdAndUpdate(
      conversation._id,
      {
        lastMessage: content,
        lastMessageAt: new Date(),
        ...(isEcho ? {} : { status: ConversationStatus.IN_PROGRESS }),
        $inc: { unreadCount: isEcho || isBeingViewed ? 0 : 1 },
      },
        { new: true },
      )
      .populate('contactId')
      .lean();
    // Notify conversation list update for UI refresh
    if (updatedConv) {
      this.eventsGateway.emitConversationUpdated(tenantId, updatedConv);
    }

    // Echoes: only refresh the open conversation, no inbound notification
    if (isEcho) {
      this.eventsGateway.emitToConversation(
        conversation._id.toString(),
        'message.new',
        messageObj,
      );
      return;
    }

    this.bus.emit(AUTOMATION_EVENT, {
      trigger: AutomationTrigger.MESSAGE_RECEIVED,
      tenantId,
      workspaceId: (conversation as any).workspaceId
        ? String((conversation as any).workspaceId)
        : undefined,
      conversationId: String(conversation._id),
      contactId: String(contact._id),
      channel: platform,
      text: type === 'text' ? content : '',
    } as AutomationEventPayload);

    // Emit real-time events
    this.eventsGateway.emitMessageReceived(
      tenantId,
      conversation._id.toString(),
      messageObj,
      contact,
    );

    this.eventsGateway.emitToConversation(
      conversation._id.toString(),
      'message.new',
      messageObj,
    );
  }

  /**
   * The customer opened our messages. Messenger sends a watermark (everything up to that time was read),
   * Instagram sends the id of the last message seen. Marks our outbound messages as read and tells the UI.
   */
  private async handleMessageRead(
    accountKey: string,
    event: any,
    platform: 'facebook' | 'instagram',
  ): Promise<void> {
    const userId = event?.sender?.id;
    if (!userId || !event?.read) return;

    const account = await this.socialAccountModel.findOne({
      $or:
        platform === 'instagram'
          ? [
              { accountId: accountKey, platform: SocialPlatform.INSTAGRAM },
              { pageId: accountKey, platform: SocialPlatform.INSTAGRAM },
            ]
          : [{ pageId: accountKey, platform: SocialPlatform.FACEBOOK }],
      status: SocialAccountStatus.CONNECTED,
    });
    if (!account) return;

    const tenantId = account.tenantId.toString();
    const owners: any[] = [];
    if (account.pageId) owners.push({ 'metadata.pageId': account.pageId });
    if (account.accountId) owners.push({ 'metadata.accountId': account.accountId });
    const conversation = await this.conversationModel.findOne({
      tenantId: account.tenantId,
      channel:
        platform === 'instagram'
          ? ConversationChannel.INSTAGRAM
          : ConversationChannel.FACEBOOK,
      'metadata.externalId': userId,
      'metadata.isComment': { $ne: true },
      ...(owners.length ? { $or: owners } : {}),
    });
    if (!conversation) return;

    const toDate = (raw: any): Date | undefined => {
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) return undefined;
      return new Date(n < 1e11 ? n * 1000 : n); // tolerate seconds
    };
    let readUpTo = toDate(event.read.watermark);
    if (!readUpTo && event.read.mid) {
      const seen = await this.messageModel
        .findOne({
          tenantId: account.tenantId,
          conversationId: conversation._id,
          'metadata.externalId': event.read.mid,
        })
        .select('createdAt')
        .lean();
      readUpTo = (seen as any)?.createdAt;
    }
    readUpTo = readUpTo || toDate(event.timestamp) || new Date();

    const result = await this.messageModel.updateMany(
      {
        tenantId: account.tenantId,
        conversationId: conversation._id,
        direction: MessageDirection.OUTBOUND,
        status: { $in: [MessageStatus.SENT, MessageStatus.DELIVERED] },
        createdAt: { $lte: readUpTo },
      },
      { $set: { status: MessageStatus.READ } },
    );
    if (!result.modifiedCount) return;

    const payload = {
      conversationId: String(conversation._id),
      status: 'read',
      readUpTo: readUpTo.toISOString(),
    };
    this.eventsGateway.emitToTenant(tenantId, 'message.status.updated', payload);
    this.eventsGateway.emitToConversation(
      String(conversation._id),
      'message.status.updated',
      payload,
    );
  }

  private async handlePostback(pageId: string, event: any): Promise<void> {
    // Handle postback like a text message with the payload
    const payload = event.postback?.payload;
    if (payload) {
      const fakeMessage = {
        ...event,
        message: { text: payload, mid: `postback_${Date.now()}` },
      };
      await this.handleIncomingMessage(pageId, fakeMessage, 'facebook');
    }
  }

  private async handleFeedComment(
    pageId: string,
    feedData: any,
  ): Promise<void> {
    // Handle comments on Facebook posts
    this.logger.debug(
      `[Feed] Processing feed data: ${JSON.stringify(feedData)}`,
    );
    const { item, verb, post_id, comment_id, message, from, created_time } =
      feedData;

    this.logger.log(
      `[Feed] item=${item}, verb=${verb}, post_id=${post_id}, comment_id=${comment_id}`,
    );

    // Only process new comments (verb: 'add') and comment items
    if (verb !== 'add' || (item !== 'comment' && item !== 'status')) {
      this.logger.debug(`[Feed] Skipping feed event: ${verb} ${item}`);
      return;
    }

    // If it's a status update (new post), skip it - we only want comments
    if (item === 'status' && !comment_id) {
      this.logger.debug('Skipping status update (new post)');
      return;
    }

    let commenterId = from?.id as string | undefined;
    let commenterName = from?.name as string | undefined;
    let commentText = typeof message === 'string' ? message : '';

    // Fallback: fetch comment details if message or from is missing
    if ((!commenterId || !commentText) && comment_id) {
      try {
        // Find the social account for this page (needed for access token)
        const accountForFetch = await this.socialAccountModel.findOne({
          pageId,
          platform: SocialPlatform.FACEBOOK,
          status: SocialAccountStatus.CONNECTED,
        });
        if (accountForFetch?.accessToken) {
          const fields =
            'from{id,name,picture},message,created_time,permalink_url,like_count,user_likes';
          const url = `${this.graphApiUrl}/${comment_id}?fields=${fields}&access_token=${accountForFetch.accessToken}`;
          this.logger.debug(
            `[Feed] Fetching comment details from Graph API for ${comment_id}`,
          );
          const resp = await fetch(url);
          if (resp.ok) {
            const details = (await resp.json()) as any;
            this.logger.debug(
              `[Feed] Comment details: ${JSON.stringify(details)}`,
            );
            commenterId = commenterId || details?.from?.id;
            commenterName = commenterName || details?.from?.name;
            commentText = commentText || details?.message || '';
          } else {
            const errText = await resp.text();
            this.logger.warn(
              `[Feed] Failed to fetch comment details (${resp.status}): ${errText}`,
            );
          }
        } else {
          this.logger.warn(
            '[Feed] Cannot fetch comment details: missing page access token',
          );
        }
      } catch (e) {
        this.logger.error('[Feed] Error fetching comment details', e as any);
      }
    }

    if (!commenterId) {
      this.logger.warn(
        '[Feed] Missing commenter ID after fallback; payload=' +
          JSON.stringify(feedData),
      );
      return;
    }

    // Mark webhook as received for this page
    this.markWebhookReceived(pageId);

    // Ignore comments authored by the page itself (e.g. replies sent from AXENTYC)
    if (commenterId === pageId) {
      this.logger.debug(`[Feed] Ignoring own page comment ${comment_id}`);
      return;
    }

    this.logger.log(
      `New comment on post ${post_id} from ${commenterName} (${commenterId})`,
    );

    // Find the social account for this page
    const account = await this.socialAccountModel.findOne({
      pageId,
      platform: SocialPlatform.FACEBOOK,
      status: SocialAccountStatus.CONNECTED,
    });

    if (!account) {
      this.logger.warn(
        `No connected Facebook account found for page ${pageId}`,
      );
      return;
    }

    const tenantId = account.tenantId.toString();

    // Deduplicate webhook retries / polling overlap by comment id
    if (comment_id) {
      const alreadyStored = await this.messageModel.exists({
        tenantId: new Types.ObjectId(tenantId),
        'metadata.commentId': comment_id,
      });
      if (alreadyStored) {
        this.logger.debug(`[Feed] Duplicate comment ${comment_id} ignored`);
        return;
      }
    }

    // Get or create contact for the commenter
    const contact = await this.getOrCreateContact(
      tenantId,
      commenterId,
      account.accessToken,
      'facebook',
      account.workspaceId,
    );

    // Get or create conversation for this post's comments
    const conversation = await this.getOrCreateCommentConversation(
      tenantId,
      contact._id.toString(),
      commenterId,
      post_id,
      pageId,
      account.accountName,
    );

    // Save the comment as a message (allow empty text; store metadata)
    const newMessage = new this.messageModel({
      tenantId: new Types.ObjectId(tenantId),
      workspaceId: (conversation as any).workspaceId,
      conversationId: conversation._id,
      direction: MessageDirection.INBOUND,
      type: MessageType.TEXT,
      content: commentText || '(comentario sin texto)',
      senderName: contact.name,
      status: MessageStatus.SENT,
      metadata: {
        commentId: comment_id,
        postId: post_id,
        platform: 'facebook',
        isComment: true,
        commentCreatedAt: created_time
          ? new Date(created_time * 1000).toISOString()
          : undefined,
      },
    });

    const savedMessage = await newMessage.save();

    // Update conversation
    const isBeingViewedFb = this.eventsGateway.isConversationBeingViewed(
      conversation._id.toString(),
    );
    await this.conversationModel.findByIdAndUpdate(conversation._id, {
      lastMessage: commentText || '(comentario sin texto)',
      lastMessageAt: new Date(),
      status: ConversationStatus.OPEN,
      $inc: { unreadCount: isBeingViewedFb ? 0 : 1 },
    });

    this.eventsGateway.emitMessageReceived(
      tenantId,
      conversation._id.toString(),
      savedMessage,
      contact,
    );

    // Emit dedicated FB comment event for real-time UI updates
    this.eventsGateway.emitToTenant(tenantId, 'fb.comment.new', {
      workspaceId: account.workspaceId?.toString(),
      postId: post_id,
      pageId,
      comment: {
        id: comment_id,
        from: {
          id: commenterId,
          name: commenterName,
          picture: contact.avatar
            ? { data: { url: contact.avatar } }
            : undefined,
        },
        message: commentText || '',
        created_time: created_time
          ? new Date(created_time * 1000).toISOString()
          : new Date().toISOString(),
        like_count: 0,
        user_likes: false,
      },
    });

    this.bus.emit(AUTOMATION_EVENT, {
      trigger: AutomationTrigger.MESSAGE_RECEIVED,
      tenantId,
      workspaceId: account.workspaceId
        ? String(account.workspaceId)
        : undefined,
      conversationId: String(conversation._id),
      contactId: String(contact._id),
      channel: 'facebook',
      text: commentText || '',
    } as AutomationEventPayload);

    this.logger.log(
      `Comment saved as message in conversation ${conversation._id}`,
    );
  }

  private async handleInstagramComment(
    igAccountId: string,
    commentData: any,
  ): Promise<void> {
    // Handle comments on Instagram posts
    const { id: commentId, text, from, media } = commentData;

    if (!from?.id || !text) {
      this.logger.warn(
        'Missing commenter ID or comment text in Instagram comment',
      );
      return;
    }

    const commenterId = from.id;
    const commenterUsername = from.username || 'Instagram User';

    // Ignore comments authored by our own Instagram account (e.g. replies sent from AXENTYC)
    if (commenterId === igAccountId) {
      this.logger.debug(
        `[IG Comment] Ignoring own account comment ${commentId}`,
      );
      return;
    }
    const mediaId = media?.id; // The post/media that was commented on

    this.logger.log(
      `New Instagram comment from @${commenterUsername} (${commenterId})`,
    );

    // Find the Instagram account
    const account = await this.socialAccountModel.findOne({
      accountId: igAccountId,
      platform: SocialPlatform.INSTAGRAM,
      status: SocialAccountStatus.CONNECTED,
    });

    if (!account) {
      this.logger.warn(
        `No connected Instagram account found for ${igAccountId}`,
      );
      return;
    }

    // Meta identifies the commenter with an app-scoped id, so "is it us?" cannot rely on the account id alone
    const isOwnComment =
      (!!from.self_ig_scoped_id && String(from.self_ig_scoped_id) === String(commenterId)) ||
      (!!from.username &&
        from.username.toLowerCase() === (account.accountName || '').toLowerCase());
    if (isOwnComment) {
      this.logger.debug(`[IG Comment] Ignoring own account comment ${commentId}`);
      return;
    }

    const tenantId = account.tenantId.toString();

    // Deduplicate webhook retries by comment id
    if (commentId) {
      const alreadyStored = await this.messageModel.exists({
        tenantId: new Types.ObjectId(tenantId),
        'metadata.commentId': commentId,
      });
      if (alreadyStored) {
        this.logger.debug(
          `[IG Comment] Duplicate comment ${commentId} ignored`,
        );
        return;
      }
    }

    // Get or create contact for the commenter
    const contact = await this.getOrCreateContact(
      tenantId,
      commenterId,
      account.accessToken,
      'instagram',
      account.workspaceId,
    );

    // Get or create conversation for this post's comments
    const conversation = await this.getOrCreateInstagramCommentConversation(
      tenantId,
      contact._id.toString(),
      commenterId,
      mediaId || commentId,
      igAccountId,
      account.accountName,
    );

    // Save the comment as a message
    const newMessage = new this.messageModel({
      tenantId: new Types.ObjectId(tenantId),
      workspaceId: (conversation as any).workspaceId,
      conversationId: conversation._id,
      direction: MessageDirection.INBOUND,
      type: MessageType.TEXT,
      content: text,
      senderName: contact.name,
      status: MessageStatus.SENT,
      metadata: {
        commentId,
        mediaId,
        platform: 'instagram',
        isComment: true,
      },
    });

    const savedMessage = await newMessage.save();

    // Update conversation
    const isBeingViewedIg = this.eventsGateway.isConversationBeingViewed(
      conversation._id.toString(),
    );
    const updatedIgConv = await this.conversationModel
      .findByIdAndUpdate(
      conversation._id,
      {
        lastMessage: text,
        lastMessageAt: new Date(),
        status: ConversationStatus.OPEN,
        $inc: { unreadCount: isBeingViewedIg ? 0 : 1 },
      },
      { new: true },
      )
      .populate('contactId')
      .lean();

    // Real-time UI updates (same events used for DMs / Facebook comments)
    if (updatedIgConv) {
      this.eventsGateway.emitConversationUpdated(tenantId, updatedIgConv);
    }
    this.eventsGateway.emitMessageReceived(
      tenantId,
      conversation._id.toString(),
      savedMessage,
      contact,
    );
    this.eventsGateway.emitToTenant(tenantId, 'ig.comment.new', {
      workspaceId: account.workspaceId?.toString(),
      mediaId,
      accountId: igAccountId,
      comment: {
        id: commentId,
        from: { id: commenterId, username: commenterUsername },
        text,
        created_time: new Date().toISOString(),
      },
    });

    this.bus.emit(AUTOMATION_EVENT, {
      trigger: AutomationTrigger.MESSAGE_RECEIVED,
      tenantId,
      workspaceId: account.workspaceId
        ? String(account.workspaceId)
        : undefined,
      conversationId: String(conversation._id),
      contactId: String(contact._id),
      channel: 'instagram',
      text,
    } as AutomationEventPayload);

    this.logger.log(
      `Instagram comment saved as message in conversation ${conversation._id}`,
    );
  }

  // ─── Send Message ───

  /** Conversation + connected Meta account needed to talk to a customer through the Send API. */
  private async resolveMetaThread(
    tenantId: string,
    conversationId: string,
  ): Promise<{
    conversation: ConversationDocument;
    account: SocialAccountDocument;
    externalId: string;
    isInstagram: boolean;
  } | null> {
    const conversation = await this.conversationModel.findOne({
      _id: new Types.ObjectId(conversationId),
      tenantId: new Types.ObjectId(tenantId),
    });
    if (!conversation) return null;

    const isFacebook = conversation.channel === ConversationChannel.FACEBOOK;
    const isInstagram = conversation.channel === ConversationChannel.INSTAGRAM;
    if (!isFacebook && !isInstagram) return null;

    const externalId = conversation.metadata?.externalId; // sender PSID / IGSID
    const pageId = conversation.metadata?.pageId;
    const accountId = conversation.metadata?.accountId;
    if (!externalId || (!pageId && !accountId)) {
      this.logger.warn(
        `Missing externalId or pageId/accountId for conversation ${conversationId}`,
      );
      return null;
    }

    const lookupId = pageId || accountId;
    const platformType = isInstagram
      ? SocialPlatform.INSTAGRAM
      : SocialPlatform.FACEBOOK;
    const account = await this.socialAccountModel.findOne({
      tenantId: new Types.ObjectId(tenantId),
      $or: [
        { pageId: lookupId, platform: platformType },
        { accountId: lookupId, platform: platformType },
      ],
      status: SocialAccountStatus.CONNECTED,
    });
    if (!account?.accessToken) {
      this.logger.warn(
        `No access token for ${isInstagram ? 'Instagram' : 'Facebook'} account ${lookupId}`,
      );
      return null;
    }
    return { conversation, account, externalId, isInstagram };
  }

  /**
   * "Escribiendo..." and "Visto" shown to the customer inside Messenger / Instagram.
   * Never throws: these are cosmetic and Meta refuses them outside the 24h window or for comment threads.
   */
  async sendSenderAction(
    tenantId: string,
    conversationId: string,
    action: 'typing_on' | 'typing_off' | 'mark_seen',
  ): Promise<boolean> {
    try {
      const thread = await this.resolveMetaThread(tenantId, conversationId);
      if (!thread || thread.conversation.metadata?.isComment) return false;
      const response = await fetch(
        `${this.graphApiUrl}/me/messages?access_token=${thread.account.accessToken}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            recipient: { id: thread.externalId },
            sender_action: action,
          }),
        },
      );
      const result = (await response.json().catch(() => ({}))) as any;
      if (result?.error) {
        this.logger.debug(`[SenderAction] ${action} refused: ${result.error.message}`);
        return false;
      }
      return true;
    } catch (e: any) {
      this.logger.debug(`[SenderAction] ${action} failed: ${e?.message || e}`);
      return false;
    }
  }

  async sendMessage(
    tenantId: string,
    conversationId: string,
    content: string,
    media?: { url: string; mimeType?: string },
  ): Promise<boolean> {
    const thread = await this.resolveMetaThread(tenantId, conversationId);
    if (!thread) return false;
    const { account, externalId, isInstagram } = thread;

    // Build Graph API message (same endpoint for both FB and IG)
    const messagePayload: any = {
      recipient: { id: externalId },
      messaging_type: 'RESPONSE',
    };

    if (media?.url) {
      // Determine attachment type
      let attachmentType = 'file';
      if (media.mimeType?.startsWith('image/')) attachmentType = 'image';
      else if (media.mimeType?.startsWith('video/')) attachmentType = 'video';
      else if (media.mimeType?.startsWith('audio/')) attachmentType = 'audio';

      messagePayload.message = {
        attachment: {
          type: attachmentType,
          payload: { url: media.url, is_reusable: true },
        },
      };
    } else {
      messagePayload.message = { text: content };
    }

    const url = `${this.graphApiUrl}/me/messages?access_token=${account.accessToken}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(messagePayload),
    });

    const result = (await response.json()) as any;
    if (result.error) {
      this.logger.error(
        `Failed to send ${isInstagram ? 'Instagram' : 'FB'} message: ${result.error.message}`,
      );
      return false;
    }

    this.logger.log(
      `${isInstagram ? 'IG' : 'FB'} message sent to ${externalId}, mid: ${result.message_id}`,
    );

    // Save externalId on the outbound message to prevent duplicates from polling
    if (result.message_id) {
      await this.messageModel
        .updateOne(
        {
          conversationId: new Types.ObjectId(conversationId),
          direction: MessageDirection.OUTBOUND,
          content,
          'metadata.externalId': { $exists: false },
        },
        {
          $set: {
            'metadata.externalId': result.message_id,
            'metadata.platform': isInstagram ? 'instagram' : 'facebook',
            status: MessageStatus.DELIVERED,
          },
        },
        )
        .sort({ createdAt: -1 })
        .limit(1);
    }

    return true;
  }

  async sendDirectMessage(
    tenantId: string,
    pageId: string,
    recipientPsid: string,
    content: string,
  ): Promise<{ success: boolean; messageId?: string }> {
    await this.billingService.assertCanReply(tenantId);
    const account = await this.socialAccountModel.findOne({
      tenantId: new Types.ObjectId(tenantId),
      pageId,
      platform: SocialPlatform.FACEBOOK,
      status: SocialAccountStatus.CONNECTED,
    });
    if (!account?.accessToken) {
      throw new BadRequestException(
        'Facebook page not connected or missing access token',
      );
    }

    const messagePayload: any = {
      recipient: { id: recipientPsid },
      messaging_type: 'RESPONSE',
      message: { text: content },
    };

    const url = `${this.graphApiUrl}/me/messages?access_token=${account.accessToken}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(messagePayload),
    });

    const result = (await response.json()) as any;
    if (result.error) {
      this.logger.error('Failed to send direct FB message:', result.error);
      throw new BadRequestException(
        result.error.message || 'Failed to send direct message',
      );
    }

    this.logger.log(
      `Direct FB message sent to ${recipientPsid}, mid: ${result.message_id}`,
    );

    // Also create or find contact and conversation for this recipient
    const contact = await this.getOrCreateContact(
      tenantId,
      recipientPsid,
      account.accessToken,
      'facebook',
      account.workspaceId,
    );
    const conversation = await this.getOrCreateConversation(
      tenantId,
      contact._id.toString(),
      recipientPsid,
      pageId,
      'facebook',
      account.accountName,
    );

    // Save the outbound message
    const newMessage = new this.messageModel({
      tenantId: new Types.ObjectId(tenantId),
      workspaceId: (conversation as any).workspaceId,
      conversationId: conversation._id,
      direction: MessageDirection.OUTBOUND,
      type: MessageType.TEXT,
      content,
      senderName: account.accountName,
      status: MessageStatus.SENT,
      metadata: {
        platform: 'facebook',
        pageId,
        externalId: recipientPsid,
      },
    });
    await newMessage.save();

    await this.conversationModel.findByIdAndUpdate(conversation._id, {
      lastMessage: content,
      lastMessageAt: new Date(),
    });

    this.eventsGateway.emitToConversation(
      conversation._id.toString(),
      'message.new',
      newMessage,
    );
    this.eventsGateway.emitToTenant(
      tenantId,
      'conversation.updated',
      conversation,
    );

    return { success: true, messageId: result.message_id };
  }

  // ─── Helpers ───

  private async getOrCreateContact(
    tenantId: string,
    senderId: string,
    pageAccessToken?: string,
    platform: 'facebook' | 'instagram' = 'facebook',
    workspaceId?: Types.ObjectId | string,
  ): Promise<ContactDocument> {
    // Check if contact exists by PSID (works for both FB and IG) inside the same workspace
    const psidField =
      platform === 'instagram'
        ? 'customFields.instagramPsid'
        : 'customFields.facebookPsid';
    let contact = await this.contactModel.findOne({
      tenantId: new Types.ObjectId(tenantId),
      ...(workspaceId
        ? { workspaceId: new Types.ObjectId(workspaceId.toString()) }
        : {}),
      [psidField]: senderId,
    });

    // Get profile from Facebook/Instagram to update name even if contact exists
    let name = `${platform === 'instagram' ? 'Instagram' : 'Facebook'} User ${senderId.slice(-4)}`;
    let profilePic: string | undefined;
    let username: string | undefined;

    if (pageAccessToken) {
      try {
        // Instagram: use username, name, profile_pic (IGSID)
        // Messenger: use first_name, last_name, profile_pic (PSID)
        const fields =
          platform === 'instagram'
          ? 'id,username,name,profile_pic' 
          : 'id,first_name,last_name,profile_pic';
        const url = `${this.graphApiUrl}/${senderId}?fields=${fields}&access_token=${pageAccessToken}`;
        this.logger.debug(
          `[getOrCreateContact] Fetching ${platform} profile for ${senderId}`,
        );
        const res = await fetch(url);
        const profile = (await res.json()) as any;
        
        this.logger.debug(
          `[getOrCreateContact] ${platform} API response received (error: ${!!profile.error})`,
        );
        
        if (profile.error) {
          this.logger.error(
            `[getOrCreateContact] ${platform} API error: ${profile.error.message} (type: ${profile.error.type})`,
          );
        }
        
        if (platform === 'instagram') {
          // Instagram may have 'name' (full name) or 'username' (handle)
          if (profile.name) {
            name = profile.name;
            this.logger.log(
              `[getOrCreateContact] Instagram name from 'name' field: ${name}`,
            );
          } else if (profile.username) {
            name = profile.username;
            this.logger.log(
              `[getOrCreateContact] Instagram name from 'username' field: ${name}`,
            );
          } else {
            this.logger.warn(
              `[getOrCreateContact] Instagram profile has no 'name' or 'username' field`,
            );
          }
          profilePic = profile.profile_pic;
          
          // Store username for socialProfiles
          if (profile.username) {
            username = profile.username;
            this.logger.log(
              `[getOrCreateContact] Instagram username: ${username}`,
            );
          }
        } else {
          // Messenger uses first_name and last_name
          if (profile.first_name) {
            name = `${profile.first_name}${profile.last_name ? ' ' + profile.last_name : ''}`;
            this.logger.log(`[getOrCreateContact] Messenger name: ${name}`);
          } else {
            this.logger.warn(
              `[getOrCreateContact] Messenger profile has no 'first_name' field`,
            );
          }
          profilePic = profile.profile_pic;
        }
        this.logger.log(
          `[getOrCreateContact] ${platform} profile fetched: name="${name}", hasProfilePic=${!!profilePic}`,
        );
      } catch (e) {
        this.logger.warn(
          `Failed to get ${platform} profile for ${senderId}: ${e.message}`,
        );
      }
    } else {
      this.logger.warn(
        `[getOrCreateContact] No pageAccessToken provided for ${platform}`,
      );
    }

    if (contact) {
      // Update existing contact with latest name, profile pic, and username
      if (contact.name !== name || contact.avatar !== profilePic) {
        this.logger.log(
          `[getOrCreateContact] Updating contact ${contact._id}: name "${contact.name}" -> "${name}", avatar updated: ${!!profilePic}`,
        );
        contact.name = name;
        if (profilePic) contact.avatar = profilePic;
        if (username && platform === 'instagram') {
          contact.socialProfiles = contact.socialProfiles || {};
          contact.socialProfiles.instagram = contact.socialProfiles
            .instagram || { id: senderId };
          contact.socialProfiles.instagram.username = username;
          this.logger.log(
            `[getOrCreateContact] Updated Instagram username: ${username}`,
          );
        }
        await contact.save();
      }
      return contact;
    }

    // Create contact
    const tags =
      platform === 'instagram' ? ['instagram'] : ['facebook', 'messenger'];
    const customFields =
      platform === 'instagram'
      ? { instagramPsid: senderId }
      : { facebookPsid: senderId };

    const socialProfiles =
      platform === 'instagram' && username
      ? { instagram: { id: senderId, username } }
      : undefined;

    this.logger.log(
      `[getOrCreateContact] Creating new contact: name="${name}", platform=${platform}, senderId=${senderId}`,
    );
    contact = new this.contactModel({
      tenantId: new Types.ObjectId(tenantId),
      workspaceId: workspaceId
        ? new Types.ObjectId(workspaceId.toString())
        : undefined,
      name,
      source:
        platform === 'instagram'
          ? ContactSource.INSTAGRAM
          : ContactSource.FACEBOOK,
      avatar: profilePic,
      tags,
      customFields,
      socialProfiles,
    });

    const savedContact = await contact.save();
    this.bus.emit(AUTOMATION_EVENT, {
      trigger: AutomationTrigger.CONTACT_CREATED,
      tenantId,
      workspaceId: savedContact.workspaceId
        ? String(savedContact.workspaceId)
        : undefined,
      contactId: String(savedContact._id),
      channel: platform,
    } as AutomationEventPayload);
    return savedContact;
  }

  /** Workspace of the connected page / Instagram account an event belongs to. */
  private async accountWorkspace(
    tenantId: string,
    platform: SocialPlatform,
    id: string,
  ): Promise<Types.ObjectId | undefined> {
    const account = await this.socialAccountModel
      .findOne({
        tenantId: new Types.ObjectId(tenantId),
        platform,
        $or: [{ pageId: id }, { accountId: id }],
      })
      .select('workspaceId')
      .lean();
    return (account as any)?.workspaceId;
  }

  private async getOrCreateConversation(
    tenantId: string,
    contactId: string,
    senderId: string,
    accountId: string,
    platform: 'facebook' | 'instagram' = 'facebook',
    accountName: string = '',
  ): Promise<any> {
    const channel =
      platform === 'instagram'
        ? ConversationChannel.INSTAGRAM
        : ConversationChannel.FACEBOOK;
    
    // Try to find existing conversation by externalId (Facebook PSID)
    // IMPORTANT: Exclude comment conversations (isComment: true)
    const existing = await this.conversationModel.findOne({
      tenantId: new Types.ObjectId(tenantId),
      channel,
      'metadata.externalId': senderId,
      'metadata.isComment': { $ne: true },  // Exclude comments
      $or: [
        { 'metadata.pageId': accountId },
        { 'metadata.accountId': accountId },
      ],
    });

    if (existing) {
      return existing;
    }

    // Create new conversation
    const subject =
      platform === 'instagram' ? 'Instagram DM' : 'Facebook Messenger';
    const metadata: any = {
      externalId: senderId,
      pageName: accountName,  // Add page/account name for display
    };
    
    if (platform === 'instagram') {
      metadata.accountId = accountId;
    } else {
      metadata.pageId = accountId;
    }

    const newConversation = new this.conversationModel({
      tenantId: new Types.ObjectId(tenantId),
      workspaceId: await this.accountWorkspace(
        tenantId,
        platform === 'instagram'
          ? SocialPlatform.INSTAGRAM
          : SocialPlatform.FACEBOOK,
        accountId,
      ),
      contactId: new Types.ObjectId(contactId),
      channel,
      subject,
      status: ConversationStatus.OPEN,
      metadata,
    });
    const savedConversation = await newConversation.save();
    this.logger.log(
      `✅ New ${platform} conversation created: ${savedConversation._id}`,
    );
    
    // Populate contactId and emit event to notify frontend
    const populatedConversation = await savedConversation.populate('contactId');
    const conversationObj = populatedConversation.toObject();
    this.logger.log(
      `[getOrCreateConversation] Emitting conversation.created to tenant:${tenantId}`,
    );
    this.logger.debug(
      `[getOrCreateConversation] Conversation data: ${JSON.stringify({ _id: conversationObj._id, channel: conversationObj.channel, contactName: (conversationObj.contactId as any)?.name })}`,
    );
    this.eventsGateway.emitToTenant(
      tenantId,
      'conversation.created',
      conversationObj,
    );
    this.bus.emit(AUTOMATION_EVENT, {
      trigger: AutomationTrigger.CONVERSATION_CREATED,
      tenantId,
      workspaceId: savedConversation.workspaceId
        ? String(savedConversation.workspaceId)
        : undefined,
      conversationId: String(savedConversation._id),
      contactId: contactId,
      channel: platform,
    } as AutomationEventPayload);
    
    return savedConversation;
  }

  private async getOrCreateCommentConversation(
    tenantId: string,
    contactId: string,
    commenterId: string,
    postId: string,
    pageId: string,
    pageName: string,
  ): Promise<any> {
    // Try to find existing conversation for this person (by externalId, not by post)
    // This way all comments from the same person go to the same conversation
    const existing = await this.conversationModel
      .findOne({
      tenantId: new Types.ObjectId(tenantId),
      channel: ConversationChannel.FACEBOOK,
      'metadata.externalId': commenterId,
      'metadata.pageId': pageId,
      'metadata.isComment': true,
      })
      .populate('contactId');

    if (existing) return existing;

    // Create new conversation for this person's comments
    const newConversation = new this.conversationModel({
      tenantId: new Types.ObjectId(tenantId),
      contactId: new Types.ObjectId(contactId),
      workspaceId: await this.accountWorkspace(
        tenantId,
        SocialPlatform.FACEBOOK,
        pageId,
      ),
      channel: ConversationChannel.FACEBOOK,
      subject: `Comentarios Facebook`,
      status: ConversationStatus.OPEN,
      metadata: {
        postId, // Keep first post ID for reference
        pageId,
        pageName,
        isComment: true,
        externalId: commenterId,
      },
    });
    const saved = await newConversation.save();
    const populated = await saved.populate('contactId');
    this.logger.log(`New Facebook comment conversation created: ${saved._id}`);
    return populated;
  }

  private async getOrCreateInstagramCommentConversation(
    tenantId: string,
    contactId: string,
    commenterId: string,
    mediaId: string,
    igAccountId: string,
    accountName: string,
  ): Promise<any> {
    // Try to find existing conversation for this person (by externalId, not by media)
    // This way all comments from the same person go to the same conversation
    const existing = await this.conversationModel
      .findOne({
      tenantId: new Types.ObjectId(tenantId),
      channel: ConversationChannel.INSTAGRAM,
      'metadata.externalId': commenterId,
      'metadata.accountId': igAccountId,
      'metadata.isComment': true,
      })
      .populate('contactId');

    if (existing) return existing;

    // Create new conversation for this person's Instagram comments
    const newConversation = new this.conversationModel({
      tenantId: new Types.ObjectId(tenantId),
      contactId: new Types.ObjectId(contactId),
      workspaceId: await this.accountWorkspace(
        tenantId,
        SocialPlatform.INSTAGRAM,
        igAccountId,
      ),
      channel: ConversationChannel.INSTAGRAM,
      subject: `Comentarios Instagram`,
      status: ConversationStatus.OPEN,
      metadata: {
        mediaId, // Keep first media ID for reference
        accountId: igAccountId,
        pageName: accountName,
        isComment: true,
        externalId: commenterId,
      },
    });
    const saved = await newConversation.save();
    const populated = await saved.populate('contactId');
    this.logger.log(`New Instagram comment conversation created: ${saved._id}`);
    return populated;
  }

  // ─── Instagram DM Import / Manual Sync ───

  async syncInstagramMessages(
    tenantId: string,
    opts: { since?: Date } = {},
  ): Promise<{ newConversations: number; newMessages: number }> {
    const result = { newConversations: 0, newMessages: 0 };

    // Get all connected Facebook pages (IG DMs are fetched via Page ID)
    const fbAccounts = await this.socialAccountModel
      .find({
      tenantId: new Types.ObjectId(tenantId),
      platform: SocialPlatform.FACEBOOK,
      status: SocialAccountStatus.CONNECTED,
      })
      .exec();

    for (const fbAccount of fbAccounts) {
      if (!fbAccount.pageId || !fbAccount.accessToken) continue;

      // Check if this page has Instagram linked
      const igAccount = await this.socialAccountModel.findOne({
        tenantId: new Types.ObjectId(tenantId),
        platform: SocialPlatform.INSTAGRAM,
        pageId: fbAccount.pageId,
        status: SocialAccountStatus.CONNECTED,
      });

      if (!igAccount) continue;

      this.logger.log(
        `[IG Sync] Fetching Instagram DMs for page ${fbAccount.pageId} (IG: ${igAccount.accountId})`,
      );

      try {
        // GET /{page-id}/conversations?platform=instagram
        const convUrl = `${this.graphApiUrl}/${fbAccount.pageId}/conversations?platform=instagram&limit=50&fields=id,updated_time,participants&access_token=${fbAccount.accessToken}`;
        const convResp = await fetch(convUrl);
        const convData = (await convResp.json()) as any;

        if (convData.error) {
          this.logger.warn(
            `[IG Sync] Error fetching IG conversations for page ${fbAccount.pageId}: ${convData.error.message}`,
          );
          continue;
        }

        const conversations = convData.data || [];
        this.logger.log(
          `[IG Sync] Found ${conversations.length} IG conversations for page ${fbAccount.pageId}`,
        );

        for (const conv of conversations) {
          const convId = conv.id;
          // Background polling only looks at threads that moved since the last run
          if (
            opts.since &&
            conv.updated_time &&
            new Date(conv.updated_time).getTime() < opts.since.getTime()
          ) {
            continue;
          }
          const participants = conv.participants?.data || [];
          // The sender is the participant that's not our IG account
          const sender = participants.find(
            (p: any) => p.id !== igAccount.accountId,
          );
          const senderId = sender?.id || convId;
          const senderName =
            sender?.name || `Instagram User ${senderId.slice(-4)}`;
          const senderUsername = sender?.username;

          // Get or create contact (same helper as webhook)
          const contact = await this.getOrCreateContact(
            tenantId,
            senderId,
            fbAccount.accessToken,
            'instagram',
            igAccount.workspaceId,
          );

          // Get or create conversation — search by Graph API conversation ID (stable, never changes)
          // This prevents duplicates that happened when searching by externalId (which gets updated)
          let conversation = await this.conversationModel.findOne({
            tenantId: new Types.ObjectId(tenantId),
            channel: ConversationChannel.INSTAGRAM,
            'metadata.conversationId': convId,
          });

          if (!conversation) {
            // Fallback: search by externalId (for conversations created by webhook before we stored conversationId)
            conversation = await this.conversationModel.findOne({
              tenantId: new Types.ObjectId(tenantId),
              channel: ConversationChannel.INSTAGRAM,
              'metadata.externalId': senderId,
            });
          }

          if (!conversation) {
            // Fallback: search by contactId (webhook may have used a different externalId)
            conversation = await this.conversationModel.findOne({
              tenantId: new Types.ObjectId(tenantId),
              channel: ConversationChannel.INSTAGRAM,
              contactId: contact._id,
            });
          }

          if (!conversation) {
            conversation = new this.conversationModel({
              tenantId: new Types.ObjectId(tenantId),
              contactId: contact._id,
              workspaceId: igAccount.workspaceId,
              channel: ConversationChannel.INSTAGRAM,
              subject: 'Instagram DM',
              status: ConversationStatus.OPEN,
              metadata: {
                externalId: senderId,
                accountId: igAccount.accountId,
                pageId: fbAccount.pageId,
                pageName: igAccount.accountName,
                conversationId: convId,
              },
            });
            await conversation.save();
            result.newConversations++;
          }

          // Ensure conversation has the Graph API conversationId stored (for future lookups)
          if (!conversation.metadata?.conversationId) {
            await this.conversationModel.updateOne(
              { _id: conversation._id },
              { $set: { 'metadata.conversationId': convId } },
            );
            conversation.metadata = conversation.metadata || {};
            conversation.metadata.conversationId = convId;
          }

          // Fetch messages for this conversation
          const msgUrl = `${this.graphApiUrl}/${convId}/messages?access_token=${fbAccount.accessToken}`;
          const msgResp = await fetch(msgUrl);
          const msgData = (await msgResp.json()) as any;

          if (msgData.error) {
            this.logger.warn(
              `[IG Sync] Error fetching messages for conv ${convId}: ${msgData.error.message}`,
            );
            continue;
          }

          const messages = msgData.data || [];
          // Messages are in reverse chronological order, process oldest first
          for (const msg of messages.reverse()) {
            const msgId = msg.id;

            // Already stored: skip the extra Graph call (keeps frequent polling cheap)
            if (
              await this.messageModel.exists({
                tenantId: new Types.ObjectId(tenantId),
                'metadata.externalId': msgId,
              })
            ) {
              continue;
            }

            // Fetch message details first (needed for from.id = IGSID)
            const detailUrl = `${this.graphApiUrl}/${msgId}?fields=from,created_time,message,attachments&access_token=${fbAccount.accessToken}`;
            const detailResp = await fetch(detailUrl);
            const detail = (await detailResp.json()) as any;

            if (detail.error) continue;

            const isFromUs =
              detail.from?.id === igAccount.accountId ||
              detail.from?.id === fbAccount.pageId;

            // For inbound messages, set/fix externalId to the sender IGSID from message details.
            // It must not be the Graph conversation id; Send API needs the sender id.
            if (!isFromUs && detail.from?.id) {
              const currentExternalId = conversation.metadata?.externalId;
              const shouldFixExternalId =
                !currentExternalId ||
                currentExternalId === convId ||
                currentExternalId === senderId;
              if (shouldFixExternalId && currentExternalId !== detail.from.id) {
                this.logger.log(
                  `[IG Sync] Setting conversation externalId from ${currentExternalId} to ${detail.from.id} (IGSID from message)`,
                );
                await this.conversationModel.updateOne(
                  { _id: conversation._id },
                  { $set: { 'metadata.externalId': detail.from.id } },
                );
                conversation.metadata = conversation.metadata || {};
                conversation.metadata.externalId = detail.from.id;
              }

              if (contact.customFields?.instagramPsid !== detail.from.id) {
                await this.contactModel.updateOne(
                  { _id: contact._id },
                  { $set: { 'customFields.instagramPsid': detail.from.id } },
                );
              }
            }

            // Now check if message already exists by externalId
            const existing = await this.messageModel.findOne({
              tenantId: new Types.ObjectId(tenantId),
              'metadata.externalId': msgId,
            });
            if (existing) continue;

            let content = detail.message || '';
            let type: any = 'text';
            let media: any = undefined;

            if (detail.attachments?.data?.length > 0) {
              const att = detail.attachments.data[0];
              if (att.image) {
                type = 'image';
                media = { url: att.image, mimeType: 'image/jpeg' };
                content = content || '[Imagen]';
              } else if (att.video) {
                type = 'video';
                media = { url: att.video, mimeType: 'video/mp4' };
                content = content || '[Video]';
              } else if (att.audio) {
                type = 'audio';
                media = { url: att.audio, mimeType: 'audio/mpeg' };
                content = content || '[Audio]';
              }
            }

            // For outbound messages, check if we already sent it from Axentyc (no externalId yet)
            if (isFromUs && content) {
              const existingOutbound = await this.messageModel.findOne({
                tenantId: new Types.ObjectId(tenantId),
                conversationId: conversation._id,
                direction: MessageDirection.OUTBOUND,
                content,
              });
              if (existingOutbound) {
                // Update the existing message with the externalId instead of creating duplicate
                await this.messageModel.updateOne(
                  { _id: existingOutbound._id },
                  {
                    $set: {
                      'metadata.externalId': msgId,
                      'metadata.platform': 'instagram',
                    },
                  },
                );
                continue;
              }
            }

            const newMessage = new this.messageModel({
              tenantId: new Types.ObjectId(tenantId),
              workspaceId: (conversation as any).workspaceId,
              conversationId: conversation._id,
              direction: isFromUs
                ? MessageDirection.OUTBOUND
                : MessageDirection.INBOUND,
              type,
              content,
              media,
              senderName: isFromUs
                ? igAccount.accountName
                : senderUsername
                  ? `@${senderUsername}`
                  : senderName,
              status: MessageStatus.SENT,
              metadata: {
                externalId: msgId,
                platform: 'instagram',
              },
            });
            const savedMessage = await newMessage.save();
            const messageObj = savedMessage.toObject();
            result.newMessages++;

            // Update conversation last message
            const isBeingViewed = this.eventsGateway.isConversationBeingViewed(
              conversation._id.toString(),
            );
            const updatedConv = await this.conversationModel
              .findByIdAndUpdate(
              conversation._id,
              {
                lastMessage: content,
                lastMessageAt: new Date(detail.created_time || Date.now()),
                status: ConversationStatus.IN_PROGRESS,
                  $inc: { unreadCount: isFromUs ? 0 : isBeingViewed ? 0 : 1 },
              },
                { new: true },
              )
              .populate('contactId')
              .lean();
            // Notify conversation list update for UI refresh
            if (updatedConv) {
              this.eventsGateway.emitConversationUpdated(tenantId, updatedConv);
            }

            // Emit real-time events (same as handleIncomingMessage)
            if (isFromUs) {
              this.eventsGateway.emitToConversation(
                conversation._id.toString(),
                'message.new',
                messageObj,
              );
            } else {
              // Inbound: notify exactly like the webhook would (bell, sound, automations)
              this.eventsGateway.emitMessageReceived(
                tenantId,
                conversation._id.toString(),
                messageObj,
                contact,
              );
              this.bus.emit(AUTOMATION_EVENT, {
                trigger: AutomationTrigger.MESSAGE_RECEIVED,
                tenantId,
                workspaceId: (conversation as any).workspaceId
                  ? String((conversation as any).workspaceId)
                  : undefined,
                conversationId: String(conversation._id),
                contactId: String(contact._id),
                channel: 'instagram',
                text: type === 'text' ? content : '',
              } as AutomationEventPayload);
            }
          }
        }
      } catch (e: any) {
        this.logger.error(
          `[IG Sync] Error syncing Instagram DMs for page ${fbAccount.pageId}: ${e.message}`,
        );
      }
    }

    this.logger.log(
      `[IG Sync] Completed: ${result.newConversations} new conversations, ${result.newMessages} new messages`,
    );
    return result;
  }
}
