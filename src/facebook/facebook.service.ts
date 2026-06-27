import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
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
} from '../integrations/entities/social-account.entity';
import {
  Conversation,
  ConversationDocument,
  ConversationChannel,
  ConversationStatus,
} from '../conversations/entities/conversation.entity';
import { Message, MessageDocument, MessageDirection, MessageType, MessageStatus } from '../conversations/entities/message.entity';
import { EventsGateway } from '../events/events.gateway';
import { Contact, ContactDocument, ContactSource } from '../crm/entities/contact.entity';
import { FacebookConfig, FacebookConfigDocument } from './entities/facebook-config.entity';
import { randomUUID } from 'crypto';

@Injectable()
export class FacebookService {
  private readonly logger = new Logger(FacebookService.name);
  private readonly pendingPageSelections = new Map<string, { tenantId: string; expiresAt: number; pages: any[] }>();
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
  ) {}

  // Get global Facebook app config from environment variables
  private getGlobalAppConfig(): { appId: string; appSecret: string; verifyToken: string } | null {
    const appId = this.configService.get<string>('FACEBOOK_APP_ID');
    const appSecret = this.configService.get<string>('FACEBOOK_APP_SECRET');
    const verifyToken = this.configService.get<string>('FACEBOOK_VERIFY_TOKEN') || 'axentyc_fb_verify';

    if (!appId || !appSecret) {
      this.logger.warn('Facebook app credentials not configured in environment variables');
      return null;
    }
    return { appId, appSecret, verifyToken };
  }

  // ─── Automatic Polling (Hybrid: Webhook + Polling Fallback) ───

  @Cron('*/3 * * * *') // Every 3 minutes
  async autoSyncComments() {
    const enabled = this.configService.get<string>('FACEBOOK_COMMENTS_POLLING_ENABLED') === 'true';
    if (!enabled) {
      return;
    }

    this.logger.log('[Auto-Sync] Starting automatic comment sync for all tenants');

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
            this.logger.debug(`[Auto-Sync] Skipping ${account.accountName} - recent webhook received`);
            continue;
          }

          try {
            const result = await this.syncCommentsForTenant(tenantId, account.pageId!);
            const added = result.results[0]?.commentsAdded || 0;
            if (added > 0) {
              this.logger.log(`[Auto-Sync] Synced ${added} new comments for ${account.accountName}`);
              totalSynced += added;
            }
          } catch (e: any) {
            this.logger.error(`[Auto-Sync] Error syncing ${account.accountName}: ${e.message}`);
          }
        }
      }

      if (totalSynced > 0) {
        this.logger.log(`[Auto-Sync] Completed: ${totalSynced} new comments synced`);
      }
    } catch (e: any) {
      this.logger.error(`[Auto-Sync] Fatal error: ${e.message}`);
    }
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
        throw new BadRequestException('pageId is required to reply to a comment');
      }

      // Find the social account
      const account = await this.socialAccountModel.findOne({
        tenantId: new Types.ObjectId(tenantId),
        pageId,
        platform: SocialPlatform.FACEBOOK,
        status: SocialAccountStatus.CONNECTED,
      });

      if (!account?.accessToken) {
        throw new BadRequestException('Facebook page not connected or missing access token');
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

      const data = await response.json() as any;
      if (data.error) {
        this.logger.error('Failed to reply to comment:', data.error);
        throw new BadRequestException(data.error.message || 'Failed to reply to comment');
      }

      this.logger.log(`Replied to comment ${commentId}: ${data.id}`);

      // Save the reply as an outbound message (if we can associate it)
      // Try to resolve conversation from existing message or by postId
      let conversation = existingMessage
        ? await this.conversationModel.findById(existingMessage.conversationId)
        : null;
      if (!conversation && postId) {
        conversation = await this.conversationModel.findOne({
          tenantId: new Types.ObjectId(tenantId),
          'metadata.postId': postId,
        }) as any;
      }
      if (conversation) {
        const replyMessage = new this.messageModel({
          tenantId: new Types.ObjectId(tenantId),
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
      throw new BadRequestException('Facebook page not connected or missing access token');
    }

    const normalizedType = (reactionType || 'LIKE').toUpperCase();
    const edge = normalizedType === 'LIKE' ? 'likes' : 'reactions';
    const url = `${this.graphApiUrl}/${objectId}/${edge}`;

    this.logger.log(`[reactToObject] POST ${url} type=${normalizedType} objectId=${objectId}`);

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

    const data = await response.json() as any;
    if (data.error) {
      this.logger.error('Failed to react to Facebook object:', JSON.stringify(data.error));

      // If error #3 (capability), diagnose token permissions to give a better message
      if (data.error?.code === 3) {
        let missingPermissions: string[] = [];
        let grantedPermissions: string[] = [];
        try {
          const debugUrl = `${this.graphApiUrl}/me/permissions?access_token=${account.accessToken}`;
          const debugResp = await fetch(debugUrl);
          const debugData = await debugResp.json() as any;
          if (Array.isArray(debugData?.data)) {
            grantedPermissions = debugData.data.filter((p: any) => p.status === 'granted').map((p: any) => p.permission);
            const granted = new Set(grantedPermissions);
            const required = ['pages_manage_engagement', 'pages_read_engagement'];
            missingPermissions = required.filter(p => !granted.has(p));
            this.logger.log(`[reactToObject] Token permissions: granted=${grantedPermissions.join(',')}, missing=${missingPermissions.join(',')}`);
          }
        } catch (e) {
          this.logger.warn('[reactToObject] Could not fetch token permissions:', e);
        }

        // Check if it's a feature/capability issue vs permission issue
        const errorMsg = data.error?.message || '';
        const isCapabilityError = errorMsg.toLowerCase().includes('capability') || errorMsg.toLowerCase().includes('permission');

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

      throw new BadRequestException(data.error.message || 'Failed to react to Facebook object');
    }

    return { success: true };
  }

  async diagnoseTokenPermissions(tenantId: string, pageId: string): Promise<{ permissions: any[]; hasEngagementPermissions: boolean; tokenValid: boolean; reactionTestError?: string }> {
    const account = await this.socialAccountModel.findOne({
      tenantId: new Types.ObjectId(tenantId),
      pageId,
      platform: SocialPlatform.FACEBOOK,
      status: SocialAccountStatus.CONNECTED,
    });
    if (!account?.accessToken) {
      return { permissions: [], hasEngagementPermissions: false, tokenValid: false };
    }

    try {
      const debugUrl = `${this.graphApiUrl}/me/permissions?access_token=${account.accessToken}`;
      const resp = await fetch(debugUrl);
      const data = await resp.json() as any;
      if (data.error) {
        this.logger.error('[diagnoseTokenPermissions] Error:', data.error);
        return { permissions: [], hasEngagementPermissions: false, tokenValid: false };
      }
      const permissions = Array.isArray(data?.data) ? data.data : [];
      const granted = new Set(permissions.filter((p: any) => p.status === 'granted').map((p: any) => p.permission));
      const hasEngagement = granted.has('pages_manage_engagement') && granted.has('pages_read_engagement');

      // Also get the app's access level for pages_manage_engagement
      let appReviewInfo: string | undefined;
      try {
        // Try to get debug token info to see app features
        const appTokenUrl = `${this.graphApiUrl}/debug_token?input_token=${account.accessToken}&access_token=${account.accessToken}`;
        const appResp = await fetch(appTokenUrl);
        const appData = await appResp.json() as any;
        if (appData?.data) {
          this.logger.log(`[diagnoseTokenPermissions] Token debug info: ${JSON.stringify(appData.data)}`);
          appReviewInfo = appData.data?.scopes?.join(', ') || undefined;
        }
      } catch (e) {
        this.logger.warn('[diagnoseTokenPermissions] Could not fetch debug token info:', e);
      }

      return { 
        permissions, 
        hasEngagementPermissions: hasEngagement, 
        tokenValid: true,
        reactionTestError: appReviewInfo,
      };
    } catch (e) {
      this.logger.error('[diagnoseTokenPermissions] Exception:', e);
      return { permissions: [], hasEngagementPermissions: false, tokenValid: false };
    }
  }

  async hideComment(tenantId: string, pageId: string, commentId: string, hide: boolean): Promise<{ success: boolean }> {
    const account = await this.socialAccountModel.findOne({
      tenantId: new Types.ObjectId(tenantId),
      pageId,
      platform: SocialPlatform.FACEBOOK,
      status: SocialAccountStatus.CONNECTED,
    });
    if (!account?.accessToken) {
      throw new BadRequestException('Facebook page not connected or missing access token');
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
    const data = await resp.json() as any;
    if (data.error) {
      this.logger.error('Failed to hide/unhide comment:', data.error);
      throw new BadRequestException(data.error.message || 'Failed to hide/unhide comment');
    }
    return { success: true };
  }

  async deleteComment(tenantId: string, pageId: string, commentId: string): Promise<{ success: boolean }> {
    const account = await this.socialAccountModel.findOne({
      tenantId: new Types.ObjectId(tenantId),
      pageId,
      platform: SocialPlatform.FACEBOOK,
      status: SocialAccountStatus.CONNECTED,
    });
    if (!account?.accessToken) {
      throw new BadRequestException('Facebook page not connected or missing access token');
    }

    const url = `${this.graphApiUrl}/${commentId}?access_token=${account.accessToken}`;
    const resp = await fetch(url, { method: 'DELETE' });
    if (!resp.ok) {
      try {
        const data = await resp.json() as any;
        if (data?.error) {
          this.logger.error('Failed to delete comment:', data.error);
          throw new BadRequestException(data.error.message || 'Failed to delete comment');
        }
      } catch (e) {
        // ignore json parse error
      }
      throw new BadRequestException('Failed to delete comment');
    }
    return { success: true };
  }

  // ─── Manual Sync (Fallback when webhooks are not delivering) ───

  async syncCommentsForTenant(tenantId: string, pageId?: string): Promise<{ success: boolean; results: any[] }> {
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
        results.push({ pageId: account.pageId, status: 'skipped', reason: 'missing_token_or_page' });
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

        results.push({ pageId: account.pageId, status: 'ok', posts: posts.length, commentsAdded: created });
      } catch (e: any) {
        this.logger.error(`[Sync] Error syncing page ${account.pageId}: ${e?.message || e}`);
        results.push({ pageId: account.pageId, status: 'error', error: e?.message || String(e) });
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
    const isBeingViewed = this.eventsGateway.isConversationBeingViewed(conversation._id.toString());
    await this.conversationModel.findByIdAndUpdate(conversation._id, {
      lastMessage: newMessage.content,
      lastMessageAt: new Date(),
      status: ConversationStatus.OPEN,
      $inc: { unreadCount: isBeingViewed ? 0 : 1 },
    });

    return true;
  }

  async getPageFeed(tenantId: string, pageId: string, limit = 10): Promise<{ pageId: string; posts: any[] }> {
    const account = await this.socialAccountModel.findOne({
      tenantId: new Types.ObjectId(tenantId),
      platform: SocialPlatform.FACEBOOK,
      pageId,
      status: SocialAccountStatus.CONNECTED,
    });

    if (!account?.accessToken) {
      throw new BadRequestException('Facebook page not connected or missing access token');
    }

    const fields = [
      'id',
      'permalink_url',
      'created_time',
      'from{id,name,picture}',
      'admin_creator{id,name,picture}',
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
    const data = await resp.json() as any;
    if (data.error) {
      throw new BadRequestException(data.error?.message || 'Failed to fetch page feed');
    }
    const posts = Array.isArray(data?.data) ? data.data : [];
    await this.enrichFeedAvatars(posts, account.accessToken);
    return { pageId, posts };
  }

  private async enrichFeedAvatars(posts: any[], pageAccessToken: string): Promise<void> {
    const profileCache = new Map<string, string | null>();

    const enrichProfile = async (profile: any) => {
      const profileId = profile?.id;
      if (!profileId || profile?.picture?.data?.url) return;
      if (!profileCache.has(profileId)) {
        try {
          const fields = 'picture.type(large),profile_pic';
          const url = `${this.graphApiUrl}/${profileId}?fields=${encodeURIComponent(fields)}&access_token=${pageAccessToken}`;
          const resp = await fetch(url);
          const data = await resp.json() as any;
          const picUrl = data?.picture?.data?.url || data?.profile_pic || null;
          if (!picUrl) {
            // Fallback: try simple picture field
            const fallbackUrl = `${this.graphApiUrl}/${profileId}/picture?type=normal&access_token=${pageAccessToken}`;
            profileCache.set(profileId, fallbackUrl);
          } else {
            profileCache.set(profileId, picUrl);
          }
        } catch {
          // Last resort: use the redirect endpoint directly
          profileCache.set(profileId, `${this.graphApiUrl}/${profileId}/picture?type=normal&access_token=${pageAccessToken}`);
        }
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

  // Get tenant-specific Facebook config from database (DEPRECATED - kept for migration)
  private async getTenantConfig(tenantId: string): Promise<FacebookConfigDocument | null> {
    return this.facebookConfigModel.findOne({
      tenantId: new Types.ObjectId(tenantId),
      isActive: true,
    });
  }

  get graphApiUrl(): string {
    return 'https://graph.facebook.com/v21.0';
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

    this.logger.log(`Facebook config saved for tenant ${tenantId} (secret ${appSecret && !appSecret.includes('•') ? 'updated' : 'preserved'})`);
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

  async getOAuthUrl(tenantId: string, redirectUri: string): Promise<string | null> {
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
    ].join(',');

    const params = new URLSearchParams({
      client_id: config.appId,
      redirect_uri: redirectUri,
      scope: scopes,
      response_type: 'code',
      state: tenantId,
      auth_type: 'rerequest',
    });

    return `https://www.facebook.com/v21.0/dialog/oauth?${params.toString()}`;
  }

  async exchangeCodeForToken(tenantId: string, code: string, redirectUri: string): Promise<{
    accessToken: string;
    expiresIn: number;
  }> {
    const config = this.getGlobalAppConfig();
    if (!config) {
      throw new BadRequestException('Facebook app not configured');
    }

    this.logger.log(`[exchangeCodeForToken] Starting - appId: ${config.appId}, secret length: ${config.appSecret?.length}, redirectUri: ${redirectUri}`);

    const url = `${this.graphApiUrl}/oauth/access_token?client_id=${config.appId}&client_secret=${config.appSecret}&redirect_uri=${encodeURIComponent(redirectUri)}&code=${code}`;

    const response = await fetch(url);
    const data = await response.json() as any;

    this.logger.log(`[exchangeCodeForToken] Facebook response: ${JSON.stringify({ hasToken: !!data.access_token, expiresIn: data.expires_in, error: data.error || null })}`);

    if (data.error) {
      this.logger.error(`[exchangeCodeForToken] Facebook OAuth error: ${JSON.stringify(data.error)}`);
      throw new BadRequestException(data.error.message || 'Failed to exchange code');
    }

    return {
      accessToken: data.access_token,
      expiresIn: data.expires_in,
    };
  }

  async getLongLivedToken(tenantId: string, shortLivedToken: string): Promise<{
    accessToken: string;
    expiresIn: number;
  }> {
    const config = this.getGlobalAppConfig();
    if (!config) {
      throw new BadRequestException('Facebook app not configured');
    }

    const url = `${this.graphApiUrl}/oauth/access_token?grant_type=fb_exchange_token&client_id=${config.appId}&client_secret=${config.appSecret}&fb_exchange_token=${shortLivedToken}`;

    const response = await fetch(url);
    const data = await response.json() as any;

    if (data.error) {
      this.logger.warn(`Long-lived token error: ${JSON.stringify(data.error)} — falling back to short-lived token`);
      return { accessToken: shortLivedToken, expiresIn: 3600 };
    }

    this.logger.log(`Long-lived token obtained, expires in ${data.expires_in}s`);

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
      const meData = await meResponse.json() as any;
      this.logger.log(`[getUserPages] User info: ${JSON.stringify(meData)}`);
    } catch (err) {
      this.logger.warn(`[getUserPages] Could not fetch user info: ${err.message}`);
    }

    // Check token permissions
    const debugUrl = `${this.graphApiUrl}/me/permissions?access_token=${userAccessToken}`;
    try {
      const debugResponse = await fetch(debugUrl);
      const debugData = await debugResponse.json() as any;
        this.logger.log(`[getUserPages] Token permissions checked: ${Array.isArray(debugData?.data) ? debugData.data.map((item: any) => `${item.permission}:${item.status}`).join(',') : 'unavailable'}`);
    } catch (err) {
      this.logger.warn(`[getUserPages] Could not fetch token permissions: ${err.message}`);
    }

    const url = `${this.graphApiUrl}/me/accounts?access_token=${userAccessToken}&fields=id,name,access_token,picture,category,fan_count,instagram_business_account`;

    this.logger.log('[getUserPages] Fetching pages from Facebook');

    const response = await fetch(url);
    const data = await response.json() as any;

    this.logger.log(`[getUserPages] Facebook returned ${Array.isArray(data.data) ? data.data.length : 0} page(s)`);

    if (data.error) {
      this.logger.error(`[getUserPages] Facebook API error: ${JSON.stringify(data.error)}`);
      throw new BadRequestException(data.error.message || 'Failed to get pages');
    }

    if (!data.data || data.data.length === 0) {
      this.logger.warn(`[getUserPages] No pages found for user. User may not be admin of any page or didn't select pages during OAuth.`);
      this.logger.warn(`[getUserPages] IMPORTANT: Check if the user selected pages during OAuth flow, or if the app has 'pages_show_list' permission approved.`);
    }

    const pages = await Promise.all((data.data || []).map(async (page: any) => {
      let instagramAccount = null;
      let instagramLinked = false;
      let instagramError = null;
      
      // Check if page has Instagram Business Account linked
      if (page.instagram_business_account?.id) {
        try {
          const igData = await this.getInstagramAccountInfo(
            page.instagram_business_account.id,
            page.access_token
          );
          instagramAccount = igData;
          instagramLinked = true;
        } catch (err: any) {
          instagramError = err.message;
          this.logger.warn(`Failed to get Instagram info for page ${page.id}: ${err.message}`);
        }
      }

      return {
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
    }));

    this.logger.log(`[getUserPages] Mapped ${pages.length} pages: ${JSON.stringify(pages.map((p: any) => ({ id: p.id, name: p.name, hasInstagram: p.instagramLinked, igError: p.instagramError })))}`);
    return pages;
  }

  private async getInstagramAccountInfo(igAccountId: string, pageAccessToken: string): Promise<any> {
    const url = `${this.graphApiUrl}/${igAccountId}?fields=id,username,name,profile_picture_url,followers_count&access_token=${pageAccessToken}`;
    
    const response = await fetch(url);
    const data = await response.json() as any;

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

  createPendingPageSelection(tenantId: string, pages: any[]): { selectionToken: string; pages: any[] } {
    const selectionToken = randomUUID();
    const expiresAt = Date.now() + 10 * 60 * 1000;

    this.pendingPageSelections.set(selectionToken, { tenantId, expiresAt, pages });

    return {
      selectionToken,
      pages: pages.map((page) => ({
        id: page.id,
        name: page.name,
        picture: page.picture,
        category: page.category,
        fanCount: page.fanCount,
        instagramAccount: page.instagramAccount,
      })),
    };
  }

  consumePendingPageSelection(tenantId: string, selectionToken: string, pageId: string): any {
    const selection = this.pendingPageSelections.get(selectionToken);

    if (!selection || selection.tenantId !== tenantId || selection.expiresAt < Date.now()) {
      this.pendingPageSelections.delete(selectionToken);
      throw new BadRequestException('Facebook page selection expired. Please reconnect Facebook.');
    }

    const page = selection.pages.find((item) => item.id === pageId);
    if (!page?.accessToken) {
      throw new BadRequestException('Selected Facebook page is not available. Please reconnect Facebook.');
    }

    this.pendingPageSelections.delete(selectionToken);
    return page;
  }

  // ─── Connect / Disconnect ───

  async connectPage(
    tenantId: string,
    pageId: string,
    pageName: string,
    pageAccessToken: string,
    metadata?: Record<string, any>,
  ): Promise<SocialAccount> {
    // Subscribe page to webhook (includes Instagram if linked)
    await this.subscribePageToWebhook(pageId, pageAccessToken);

    // Check if page has Instagram linked
    const instagramAccount = metadata?.instagramAccount;
    if (instagramAccount?.id) {
      this.logger.log(`Instagram account @${instagramAccount.username} detected for page ${pageId}`);
      // Subscribe Instagram to webhook (non-blocking: don't fail FB connection if IG fails)
      try {
        await this.subscribeInstagramToWebhook(instagramAccount.id, pageAccessToken);
      } catch (err) {
        this.logger.warn(`Instagram webhook subscription failed for @${instagramAccount.username}: ${err.message}. Facebook page will still be connected.`);
      }
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
        platform: SocialPlatform.FACEBOOK,
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
          platform: SocialPlatform.INSTAGRAM,
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
          },
          isActive: true,
        },
        { upsert: true, new: true },
      );
      this.logger.log(`Instagram account @${instagramAccount.username} connected for tenant ${tenantId}`);

      // Sync existing Instagram DMs immediately
      this.syncInstagramMessages(tenantId).catch((e) => {
        this.logger.warn(`Initial IG DM sync failed for tenant ${tenantId}: ${e.message}`);
      });
    }

    this.logger.log(`Facebook page "${pageName}" (${pageId}) connected for tenant ${tenantId}`);
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
        if (account.platform === SocialPlatform.INSTAGRAM && account.accountId) {
          // Unsubscribe Instagram webhook
          const url = `${this.graphApiUrl}/${account.accountId}/subscribed_apps?access_token=${account.accessToken}`;
          await fetch(url, { method: 'DELETE' });
          this.logger.log(`Instagram account ${account.accountId} unsubscribed from webhook events`);
        } else {
          await this.unsubscribePageFromWebhook(account.pageId, account.accessToken);
        }
      } catch (e) {
        this.logger.warn(`Failed to unsubscribe ${account.platform} account from webhook: ${e}`);
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
        this.logger.log(`Linked Instagram account ${igAccount.accountId} also disconnected`);
      }
    }

    this.logger.log(`${account.platform} account "${account.accountName}" disconnected for tenant ${tenantId}`);
  }

  async getStatus(tenantId: string): Promise<{
    connected: boolean;
    accounts: SocialAccount[];
  }> {
    const accounts = await this.socialAccountModel
      .find({
        tenantId: new Types.ObjectId(tenantId),
        platform: { $in: [SocialPlatform.FACEBOOK, SocialPlatform.INSTAGRAM] },
      })
      .exec();

    return {
      connected: accounts.some(a => a.status === SocialAccountStatus.CONNECTED),
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
    const fbPagesWithIg = fbAccounts.filter(a => a.metadata?.instagramAccount?.id);

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
          const profileData = await profileResp.json() as any;
          if (profileData.error) {
            tokenError = profileData.error.message;
            this.logger.warn(`[diagnoseInstagram] Token error for ${ig.accountId}: ${profileData.error.message}`);
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
          const data = await resp.json() as any;
          if (Array.isArray(data?.data)) {
            webhookSubscribed = data.data.length > 0;
            webhookFields = data.data?.flatMap((app: any) => app.subscribed_fields || []) || [];
          }
        } catch (e) {
          this.logger.warn(`[diagnoseInstagram] Could not check webhook subscription for ${ig.accountId}`);
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

    return {
      instagramConnected: igAccounts.some(a => a.status === SocialAccountStatus.CONNECTED),
      instagramAccounts: accountsStatus,
      fbPagesWithInstagram: fbPagesWithIg.map(a => ({
        pageId: a.pageId,
        accountName: a.accountName,
        instagramAccount: a.metadata?.instagramAccount,
      })),
      instagramConversations: igConversations,
      recommendations: this.getInstagramRecommendations(igAccounts, fbPagesWithIg, igConversations),
    };
  }

  private getInstagramRecommendations(igAccounts: any[], fbPagesWithIg: any[], igConversations: number): string[] {
    const recs: string[] = [];
    if (igAccounts.length === 0) {
      if (fbPagesWithIg.length === 0) {
        recs.push('No hay cuentas de Instagram conectadas. Tu página de Facebook no tiene una cuenta de Instagram Business vinculada.');
        recs.push('Para conectar Instagram: ve a Facebook → Configuración de la Página → Instagram → vincula tu cuenta de Instagram Business.');
        recs.push('Después de vincular, desconecta y reconecta la página en AXENTYC.');
      } else {
        recs.push('Tu página de Facebook tiene Instagram vinculado pero no se creó la cuenta de Instagram en AXENTYC.');
        recs.push('Desconecta y reconecta la página de Facebook en AXENTYC para que se cree la cuenta de Instagram.');
      }
    } else {
      const connected = igAccounts.find(a => a.status === SocialAccountStatus.CONNECTED);
      if (!connected) {
        recs.push('La cuenta de Instagram existe pero no está conectada. Reconecta la página de Facebook.');
      }
      // Check for token errors
      const tokenErrors = igAccounts.filter(a => a.tokenError);
      if (tokenErrors.length > 0) {
        recs.push('⚠️ El token de acceso de Instagram es inválido: ' + tokenErrors[0].tokenError);
        recs.push('Desconecta y reconecta la página de Facebook en AXENTYC para obtener un token nuevo.');
      }
      // Check webhook subscription
      const notSubscribed = igAccounts.filter(a => !a.webhookSubscribed);
      if (notSubscribed.length > 0) {
        recs.push('⚠️ La cuenta de Instagram no está suscrita a webhooks.');
        recs.push('En Meta Developers → Webhooks → Instagram, verifica que el callback URL esté configurado.');
        recs.push('Luego desconecta y reconecta la página en AXENTYC para re-suscribir.');
      }
    }
    if (igConversations === 0) {
      recs.push('No hay conversaciones de Instagram. Verifica:');
      recs.push('1. Meta Developers → Webhooks → Instagram: callback URL verificado y campos suscritos (messages, comments)');
      recs.push('2. La cuenta de Instagram debe ser Business o Creator (no personal)');
      recs.push('3. En Meta Developers → Roles → Instagram Testers: agrega tu cuenta como tester si la app está en desarrollo');
      recs.push('4. Envía un DM desde otra cuenta de Instagram a la tuya para probar');
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
        await this.subscribePageToWebhook(account.pageId!, account.accessToken!);
        results.push({ pageId: account.pageId, name: account.accountName, status: 'subscribed' });
        this.logger.log(`Re-subscribed page ${account.accountName} (${account.pageId}) with feed`);
      } catch (err: any) {
        results.push({ pageId: account.pageId, name: account.accountName, status: 'error', error: err.message });
        this.logger.error(`Failed to re-subscribe page ${account.pageId}:`, err);
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
      return { success: false, message: 'No connected Instagram accounts found' };
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
          results.push({ igId: ig.accountId, name: ig.accountName, status: 'error', error: 'No Facebook page token found' });
          continue;
        }

        await this.subscribeInstagramToWebhook(ig.accountId!, fbAccount.accessToken);
        results.push({ igId: ig.accountId, name: ig.accountName, status: 'subscribed' });
        this.logger.log(`Re-subscribed Instagram account ${ig.accountName} (${ig.accountId}) to webhooks`);
      } catch (err: any) {
        results.push({ igId: ig.accountId, name: ig.accountName, status: 'error', error: err.message });
        this.logger.error(`Failed to re-subscribe Instagram ${ig.accountId}:`, err);
      }
    }

    return { success: true, results };
  }

  private async subscribePageToWebhook(pageId: string, pageAccessToken: string): Promise<void> {
    const url = `${this.graphApiUrl}/${pageId}/subscribed_apps`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        access_token: pageAccessToken,
        subscribed_fields: ['messages', 'messaging_postbacks', 'message_reads', 'message_deliveries', 'feed'],
      }),
    });

    const data = await response.json() as any;
    if (data.error) {
      this.logger.error('Failed to subscribe page to webhook:', data.error);
      throw new BadRequestException(data.error.message || 'Failed to subscribe page');
    }

    this.logger.log(`Page ${pageId} subscribed to webhook events`);
  }

  private async unsubscribePageFromWebhook(pageId: string, pageAccessToken: string): Promise<void> {
    const url = `${this.graphApiUrl}/${pageId}/subscribed_apps?access_token=${pageAccessToken}`;
    await fetch(url, { method: 'DELETE' });
    this.logger.log(`Page ${pageId} unsubscribed from webhook events`);
  }

  private async subscribeInstagramToWebhook(igAccountId: string, pageAccessToken: string): Promise<void> {
    const url = `${this.graphApiUrl}/${igAccountId}/subscribed_apps`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        access_token: pageAccessToken,
        subscribed_fields: ['messages', 'messaging_postbacks', 'comments', 'mentions', 'message_reactions', 'message_edit'],
      }),
    });

    const data = await response.json() as any;
    if (data.error) {
      this.logger.error('Failed to subscribe Instagram to webhook:', data.error);
      throw new BadRequestException(data.error.message || 'Failed to subscribe Instagram');
    }

    this.logger.log(`Instagram account ${igAccountId} subscribed to webhook events`);
  }

  // ─── Webhook Handler ───

  async verifyWebhook(mode: string, token: string, challenge: string): Promise<string> {
    if (mode !== 'subscribe') {
      throw new BadRequestException('Invalid mode');
    }

    // Check global verify token from env
    const globalConfig = this.getGlobalAppConfig();
    if (globalConfig && token === globalConfig.verifyToken) {
      this.logger.log('Facebook webhook verified with global token');
      return challenge;
    }

    this.logger.warn(`Webhook verification failed - token mismatch: ${token}`);
    throw new BadRequestException('Webhook verification failed');
  }

  async handleWebhook(body: any): Promise<void> {
    // Handle both Facebook Page and Instagram webhooks
    this.logger.log(`[Webhook] Processing ${body.object} webhook with ${body.entry?.length || 0} entries`);
    
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

      // Check if this page is linked to an Instagram account
      const igAccount = await this.socialAccountModel.findOne({
        pageId,
        platform: SocialPlatform.INSTAGRAM,
        status: SocialAccountStatus.CONNECTED,
      });

      // Handle messaging events (Messenger DMs or Instagram DMs)
      for (const event of entry.messaging || []) {
        try {
          if (event.message && !event.message.is_echo) {
            // Instagram DMs come through page webhooks too
            // Determine if this is Instagram or Messenger based on the account
            if (igAccount) {
              this.logger.log(`[Page Webhook] Routing as Instagram DM (page linked to IG account)`);
              await this.handleIncomingMessage(igAccount.accountId || pageId, event, 'instagram');
              // Trigger background sync for Instagram
              this.syncInstagramMessages(igAccount.tenantId.toString()).catch((err) => {
                this.logger.error(`[Page Webhook] Background IG sync failed: ${err.message}`);
              });
            } else {
              // Regular Facebook Messenger
              await this.handleIncomingMessage(pageId, event, 'facebook');
            }
          } else if (event.message?.is_echo) {
            this.logger.debug('Received echo, skipping');
          } else if (event.read) {
            await this.handleMessageRead(pageId, event);
          } else if (event.delivery) {
            this.logger.debug('Message delivered');
          } else if (event.postback) {
            await this.handlePostback(pageId, event);
          }
        } catch (err) {
          this.logger.error(`Error processing webhook event for page ${pageId}:`, err);
        }
      }

      // Handle feed events (Comments on posts)
      if (entry.changes && entry.changes.length > 0) {
        this.logger.log(`[Feed] Received ${entry.changes.length} change(s) for page ${pageId}`);
      }
      for (const change of entry.changes || []) {
        try {
          this.logger.debug(`[Feed] Change field: ${change.field}, value: ${JSON.stringify(change.value)}`);
          if (change.field === 'feed' && change.value) {
            await this.handleFeedComment(pageId, change.value);
          }
        } catch (err) {
          this.logger.error(`Error processing feed event for page ${pageId}:`, err);
        }
      }
    }
  }

  private async handleInstagramWebhook(body: any): Promise<void> {
    this.logger.log(`[IG Webhook] Processing Instagram webhook with ${body.entry?.length || 0} entries`);
    for (const entry of body.entry || []) {
      const igAccountId = entry.id;
      this.logger.log(`[IG Webhook] Entry ID: ${igAccountId}, messaging events: ${entry.messaging?.length || 0}`);

      // Handle messaging events (Instagram DMs)
      for (const event of entry.messaging || []) {
        try {
          if (event.message && !event.message.is_echo) {
            this.logger.log(`[IG Webhook] Incoming IG message from ${event.sender?.id} to ${event.recipient?.id}`);
            this.logger.debug(`[IG Webhook] Event payload: ${JSON.stringify(event)}`);
            
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
              this.logger.warn(`[IG Webhook] No connected IG account found for ID: ${igAccountId}`);
              // List all IG accounts to help diagnose
              const allIgAccounts = await this.socialAccountModel.find({
                platform: SocialPlatform.INSTAGRAM,
                status: SocialAccountStatus.CONNECTED,
              }).select('accountId pageId accountName tenantId');
              this.logger.debug(`[IG Webhook] Connected IG accounts: ${JSON.stringify(allIgAccounts)}`);
              this.logger.error(`[IG Webhook] Cannot process message without connected account. Skipping.`);
              continue;
            }
            
            this.logger.log(`[IG Webhook] Found IG account: ${igAccount.accountName} (tenant: ${igAccount.tenantId})`);
            
            // Process message immediately for real-time response
            // Use the IG accountId for lookup (not pageId)
            await this.handleIncomingMessage(igAccount.accountId || igAccountId, event, 'instagram');
            
            // Also trigger background sync to ensure thread state is authoritative
            this.syncInstagramMessages(igAccount.tenantId.toString()).catch((err) => {
              this.logger.error(`[IG Webhook] Background sync failed: ${err.message}`);
            });
          } else if (event.read) {
            await this.handleMessageRead(igAccountId, event);
          }
        } catch (err) {
          this.logger.error(`Error processing Instagram webhook event for account ${igAccountId}:`, err);
        }
      }

      // Handle comments on Instagram posts
      for (const change of entry.changes || []) {
        try {
          if (change.field === 'comments' && change.value) {
            await this.handleInstagramComment(igAccountId, change.value);
          }
        } catch (err) {
          this.logger.error(`Error processing Instagram comment for account ${igAccountId}:`, err);
        }
      }
    }
  }

  private async handleIncomingMessage(accountId: string, event: any, platform: 'facebook' | 'instagram'): Promise<void> {
    const senderId = event.sender?.id;
    const recipientId = event.recipient?.id;
    const timestamp = event.timestamp;
    const message = event.message;

    if (!senderId || !message) return;

    this.logger.log(`Incoming ${platform} message from ${senderId} to account ${accountId}`);
    this.logger.debug(`Event details - senderId: ${senderId}, recipientId: ${recipientId}, paramAccountId: ${accountId}`);

    // Find the social account (Facebook page or Instagram account)
    // For Facebook, recipientId is the Page ID. For Instagram, recipientId can vary by payload version.
    // Make the lookup robust by trying multiple combinations when platform is Instagram.
    let account = null as any;
    if (platform === 'facebook') {
      const lookupId = recipientId || accountId;
      this.logger.debug(`Looking for facebook account with pageId/accountId: ${lookupId}`);
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
        ors.push({ accountId: recipientId, platform: SocialPlatform.INSTAGRAM });
      }
      if (accountId) {
        ors.push({ accountId: accountId, platform: SocialPlatform.INSTAGRAM });
        ors.push({ pageId: accountId, platform: SocialPlatform.INSTAGRAM });
      }
      this.logger.debug(`Looking for instagram account with any of: ${JSON.stringify(ors.map(o => ({ pageId: o.pageId, accountId: o.accountId })))}`);
      account = await this.socialAccountModel.findOne({
        $or: ors,
        status: SocialAccountStatus.CONNECTED,
      });
    }

    if (!account) {
      this.logger.warn(`No connected ${platform} account found (recipientId: ${recipientId}, paramAccountId: ${accountId})`);
      
      // Debug: List all connected accounts for this platform
      const allAccounts = await this.socialAccountModel.find({
        platform: platform === 'facebook' ? SocialPlatform.FACEBOOK : SocialPlatform.INSTAGRAM,
        status: SocialAccountStatus.CONNECTED,
      }).select('pageId accountId accountName tenantId');
      this.logger.debug(`Connected ${platform} accounts in DB: ${JSON.stringify(allAccounts.map(a => ({ pageId: a.pageId, accountId: a.accountId, name: a.accountName })))}`);
      return;
    }

    const tenantId = account.tenantId.toString();
    this.logger.log(`[handleIncomingMessage] Processing for tenant: ${tenantId}`);

    // Get or create contact
    this.logger.debug(`[handleIncomingMessage] Getting/creating contact for senderId: ${senderId}`);
    const contact = await this.getOrCreateContact(tenantId, senderId, account.accessToken, platform);
    this.logger.log(`[handleIncomingMessage] Contact: ${contact._id} (${contact.name})`);

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
    this.logger.log(`[handleIncomingMessage] Conversation: ${conversation._id} (new: ${conversation.isNew !== false})`);

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
        media = { url: attachment.payload?.url, fileName: attachment.payload?.name };
        content = content || '[Archivo]';
      } else if (attachment.type === 'location') {
        type = 'text';
        const coords = attachment.payload?.coordinates;
        content = coords ? `📍 Ubicación: ${coords.lat}, ${coords.long}` : '[Ubicación]';
      }
    }

    // Add message to conversation
    const newMessage = new this.messageModel({
      tenantId: new Types.ObjectId(tenantId),
      conversationId: conversation._id,
      direction: MessageDirection.INBOUND,
      type,
      content,
      media,
      senderName: contact.name,
      status: MessageStatus.SENT,
      metadata: {
        externalId: message.mid,
        platform,
      },
    });
    const savedMessage = await newMessage.save();
    const messageObj = savedMessage.toObject();

    // Update conversation
    const isBeingViewed = this.eventsGateway.isConversationBeingViewed(conversation._id.toString());
    const updatedConv = await this.conversationModel.findByIdAndUpdate(
      conversation._id,
      {
        lastMessage: content,
        lastMessageAt: new Date(),
        status: ConversationStatus.IN_PROGRESS,
        $inc: { unreadCount: isBeingViewed ? 0 : 1 },
      },
      { new: true }
    ).populate('contactId').lean();
    // Notify conversation list update for UI refresh
    if (updatedConv) {
      this.eventsGateway.emitConversationUpdated(tenantId, updatedConv);
    }

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

  private async handleMessageRead(pageId: string, event: any): Promise<void> {
    // Could update message statuses to 'read'
    this.logger.debug(`Messages read by user ${event.sender?.id}`);
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

  private async handleFeedComment(pageId: string, feedData: any): Promise<void> {
    // Handle comments on Facebook posts
    this.logger.log(`[Feed] Processing feed data: ${JSON.stringify(feedData)}`);
    const { item, verb, post_id, comment_id, message, from, created_time } = feedData;

    this.logger.log(`[Feed] item=${item}, verb=${verb}, post_id=${post_id}, comment_id=${comment_id}`);

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
          const fields = 'from{id,name,picture},message,created_time,permalink_url,like_count,user_likes';
          const url = `${this.graphApiUrl}/${comment_id}?fields=${fields}&access_token=${accountForFetch.accessToken}`;
          this.logger.debug(`[Feed] Fetching comment details from Graph API: ${url}`);
          const resp = await fetch(url);
          if (resp.ok) {
            const details = await resp.json();
            this.logger.debug(`[Feed] Comment details: ${JSON.stringify(details)}`);
            commenterId = commenterId || details?.from?.id;
            commenterName = commenterName || details?.from?.name;
            commentText = commentText || details?.message || '';
          } else {
            const errText = await resp.text();
            this.logger.warn(`[Feed] Failed to fetch comment details (${resp.status}): ${errText}`);
          }
        } else {
          this.logger.warn('[Feed] Cannot fetch comment details: missing page access token');
        }
      } catch (e) {
        this.logger.error('[Feed] Error fetching comment details', e as any);
      }
    }

    if (!commenterId) {
      this.logger.warn('[Feed] Missing commenter ID after fallback; payload=' + JSON.stringify(feedData));
      return;
    }

    this.logger.log(`New comment on post ${post_id} from ${commenterName} (${commenterId})`);

    // Mark webhook as received for this page
    this.markWebhookReceived(pageId);

    // Find the social account for this page
    const account = await this.socialAccountModel.findOne({
      pageId,
      platform: SocialPlatform.FACEBOOK,
      status: SocialAccountStatus.CONNECTED,
    });

    if (!account) {
      this.logger.warn(`No connected Facebook account found for page ${pageId}`);
      return;
    }

    const tenantId = account.tenantId.toString();

    // Get or create contact for the commenter
    const contact = await this.getOrCreateContact(tenantId, commenterId, account.accessToken, 'facebook');

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
        commentCreatedAt: created_time ? new Date(created_time * 1000).toISOString() : undefined,
      },
    });

    const savedMessage = await newMessage.save();

    // Update conversation
    const isBeingViewedFb = this.eventsGateway.isConversationBeingViewed(conversation._id.toString());
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
      postId: post_id,
      pageId,
      comment: {
        id: comment_id,
        from: { id: commenterId, name: commenterName, picture: contact.avatar ? { data: { url: contact.avatar } } : undefined },
        message: commentText || '',
        created_time: created_time ? new Date(created_time * 1000).toISOString() : new Date().toISOString(),
        like_count: 0,
        user_likes: false,
      },
    });

    this.logger.log(`Comment saved as message in conversation ${conversation._id}`);
  }

  private async handleInstagramComment(igAccountId: string, commentData: any): Promise<void> {
    // Handle comments on Instagram posts
    const { id: commentId, text, from, media } = commentData;

    if (!from?.id || !text) {
      this.logger.warn('Missing commenter ID or comment text in Instagram comment');
      return;
    }

    const commenterId = from.id;
    const commenterUsername = from.username || 'Instagram User';
    const mediaId = media?.id; // The post/media that was commented on

    this.logger.log(`New Instagram comment from @${commenterUsername} (${commenterId})`);

    // Find the Instagram account
    const account = await this.socialAccountModel.findOne({
      accountId: igAccountId,
      platform: SocialPlatform.INSTAGRAM,
      status: SocialAccountStatus.CONNECTED,
    });

    if (!account) {
      this.logger.warn(`No connected Instagram account found for ${igAccountId}`);
      return;
    }

    const tenantId = account.tenantId.toString();

    // Get or create contact for the commenter
    const contact = await this.getOrCreateContact(tenantId, commenterId, account.accessToken, 'instagram');

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
    const isBeingViewedIg = this.eventsGateway.isConversationBeingViewed(conversation._id.toString());
    await this.conversationModel.findByIdAndUpdate(conversation._id, {
      lastMessage: text,
      lastMessageAt: new Date(),
      status: ConversationStatus.OPEN,
      $inc: { unreadCount: isBeingViewedIg ? 0 : 1 },
    });

    this.logger.log(`Instagram comment saved as message in conversation ${conversation._id}`);
  }

  // ─── Send Message ───

  async sendMessage(
    tenantId: string,
    conversationId: string,
    content: string,
    media?: { url: string; mimeType?: string },
  ): Promise<boolean> {
    // Find the conversation to get the sender PSID
    const conversation = await this.conversationModel.findOne({
      _id: new Types.ObjectId(conversationId),
      tenantId: new Types.ObjectId(tenantId),
    });
    if (!conversation) {
      return false;
    }

    const isFacebook = conversation.channel === ConversationChannel.FACEBOOK;
    const isInstagram = conversation.channel === ConversationChannel.INSTAGRAM;
    if (!isFacebook && !isInstagram) {
      return false;
    }

    const externalId = conversation.metadata?.externalId; // sender PSID
    const pageId = conversation.metadata?.pageId;
    const accountId = conversation.metadata?.accountId;
    if (!externalId || (!pageId && !accountId)) {
      this.logger.warn(`Missing externalId or pageId/accountId for conversation ${conversationId}`);
      return false;
    }

    // Find the social account (Facebook page or Instagram account)
    const lookupId = pageId || accountId;
    const platformType = isInstagram ? SocialPlatform.INSTAGRAM : SocialPlatform.FACEBOOK;
    const account = await this.socialAccountModel.findOne({
      tenantId: new Types.ObjectId(tenantId),
      $or: [
        { pageId: lookupId, platform: platformType },
        { accountId: lookupId, platform: platformType },
      ],
      status: SocialAccountStatus.CONNECTED,
    });

    if (!account?.accessToken) {
      this.logger.warn(`No access token for ${isInstagram ? 'Instagram' : 'Facebook'} account ${lookupId}`);
      return false;
    }

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

    const result = await response.json() as any;
    if (result.error) {
      this.logger.error(`Failed to send ${isInstagram ? 'Instagram' : 'FB'} message: ${result.error.message}`);
      return false;
    }

    this.logger.log(`${isInstagram ? 'IG' : 'FB'} message sent to ${externalId}, mid: ${result.message_id}`);

    // Save externalId on the outbound message to prevent duplicates from polling
    if (result.message_id) {
      await this.messageModel.updateOne(
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
      ).sort({ createdAt: -1 }).limit(1);
    }

    return true;
  }

  async sendDirectMessage(
    tenantId: string,
    pageId: string,
    recipientPsid: string,
    content: string,
  ): Promise<{ success: boolean; messageId?: string }> {
    const account = await this.socialAccountModel.findOne({
      tenantId: new Types.ObjectId(tenantId),
      pageId,
      platform: SocialPlatform.FACEBOOK,
      status: SocialAccountStatus.CONNECTED,
    });
    if (!account?.accessToken) {
      throw new BadRequestException('Facebook page not connected or missing access token');
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

    const result = await response.json() as any;
    if (result.error) {
      this.logger.error('Failed to send direct FB message:', result.error);
      throw new BadRequestException(result.error.message || 'Failed to send direct message');
    }

    this.logger.log(`Direct FB message sent to ${recipientPsid}, mid: ${result.message_id}`);

    // Also create or find contact and conversation for this recipient
    const contact = await this.getOrCreateContact(tenantId, recipientPsid, account.accessToken, 'facebook');
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

    this.eventsGateway.emitToConversation(conversation._id.toString(), 'message.new', newMessage);
    this.eventsGateway.emitToTenant(tenantId, 'conversation.updated', conversation);

    return { success: true, messageId: result.message_id };
  }

  // ─── Helpers ───

  private async getOrCreateContact(
    tenantId: string,
    senderId: string,
    pageAccessToken?: string,
    platform: 'facebook' | 'instagram' = 'facebook',
  ): Promise<ContactDocument> {
    // Check if contact exists by PSID (works for both FB and IG)
    const psidField = platform === 'instagram' ? 'customFields.instagramPsid' : 'customFields.facebookPsid';
    let contact = await this.contactModel.findOne({
      tenantId: new Types.ObjectId(tenantId),
      [psidField]: senderId,
    });

    if (contact) return contact;

    // Get profile from Facebook/Instagram
    let name = `${platform === 'instagram' ? 'Instagram' : 'Facebook'} User ${senderId.slice(-4)}`;
    let profilePic: string | undefined;

    if (pageAccessToken) {
      try {
        const url = `${this.graphApiUrl}/${senderId}?fields=first_name,last_name,profile_pic&access_token=${pageAccessToken}`;
        const res = await fetch(url);
        const profile = await res.json() as any;
        if (profile.first_name) {
          name = `${profile.first_name}${profile.last_name ? ' ' + profile.last_name : ''}`;
          profilePic = profile.profile_pic;
        }
      } catch (e) {
        this.logger.warn(`Failed to get ${platform} profile for ${senderId}`);
      }
    }

    // Create contact
    const tags = platform === 'instagram' ? ['instagram'] : ['facebook', 'messenger'];
    const customFields = platform === 'instagram' 
      ? { instagramPsid: senderId }
      : { facebookPsid: senderId };

    contact = new this.contactModel({
      tenantId: new Types.ObjectId(tenantId),
      name,
      source: platform === 'instagram' ? ContactSource.INSTAGRAM : ContactSource.FACEBOOK,
      avatar: profilePic,
      tags,
      customFields,
    });

    return contact.save();
  }

  private async getOrCreateConversation(
    tenantId: string,
    contactId: string,
    senderId: string,
    accountId: string,
    platform: 'facebook' | 'instagram' = 'facebook',
    accountName: string = '',
  ): Promise<any> {
    const channel = platform === 'instagram' ? ConversationChannel.INSTAGRAM : ConversationChannel.FACEBOOK;
    
    // Try to find existing conversation by externalId (Facebook PSID)
    const existing = await this.conversationModel.findOne({
      tenantId: new Types.ObjectId(tenantId),
      channel,
      'metadata.externalId': senderId,
      $or: [
        { 'metadata.pageId': accountId },
        { 'metadata.accountId': accountId },
      ],
    });

    if (existing) {
      return existing;
    }

    // Create new conversation
    const subject = platform === 'instagram' ? 'Instagram DM' : 'Facebook Messenger';
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
      contactId: new Types.ObjectId(contactId),
      channel,
      subject,
      status: ConversationStatus.OPEN,
      metadata,
    });
    const savedConversation = await newConversation.save();
    this.logger.log(`✅ New ${platform} conversation created: ${savedConversation._id}`);
    
    // Populate contactId and emit event to notify frontend
    const populatedConversation = await savedConversation.populate('contactId');
    const conversationObj = populatedConversation.toObject();
    this.logger.log(`[getOrCreateConversation] Emitting conversation.created to tenant:${tenantId}`);
    this.logger.debug(`[getOrCreateConversation] Conversation data: ${JSON.stringify({ _id: conversationObj._id, channel: conversationObj.channel, contactName: (conversationObj.contactId as any)?.name })}`);
    this.eventsGateway.emitToTenant(tenantId, 'conversation.created', conversationObj);
    
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
    const existing = await this.conversationModel.findOne({
      tenantId: new Types.ObjectId(tenantId),
      channel: ConversationChannel.FACEBOOK,
      'metadata.externalId': commenterId,
      'metadata.pageId': pageId,
      'metadata.isComment': true,
    }).populate('contactId');

    if (existing) return existing;

    // Create new conversation for this person's comments
    const newConversation = new this.conversationModel({
      tenantId: new Types.ObjectId(tenantId),
      contactId: new Types.ObjectId(contactId),
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
    const existing = await this.conversationModel.findOne({
      tenantId: new Types.ObjectId(tenantId),
      channel: ConversationChannel.INSTAGRAM,
      'metadata.externalId': commenterId,
      'metadata.accountId': igAccountId,
      'metadata.isComment': true,
    }).populate('contactId');

    if (existing) return existing;

    // Create new conversation for this person's Instagram comments
    const newConversation = new this.conversationModel({
      tenantId: new Types.ObjectId(tenantId),
      contactId: new Types.ObjectId(contactId),
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

  async syncInstagramMessages(tenantId: string): Promise<{ newConversations: number; newMessages: number }> {
    const result = { newConversations: 0, newMessages: 0 };

    // Get all connected Facebook pages (IG DMs are fetched via Page ID)
    const fbAccounts = await this.socialAccountModel.find({
      tenantId: new Types.ObjectId(tenantId),
      platform: SocialPlatform.FACEBOOK,
      status: SocialAccountStatus.CONNECTED,
    }).exec();

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

      this.logger.log(`[IG Sync] Fetching Instagram DMs for page ${fbAccount.pageId} (IG: ${igAccount.accountId})`);

      try {
        // GET /{page-id}/conversations?platform=instagram
        const convUrl = `${this.graphApiUrl}/${fbAccount.pageId}/conversations?platform=instagram&fields=id,updated_time,participants&access_token=${fbAccount.accessToken}`;
        const convResp = await fetch(convUrl);
        const convData = await convResp.json() as any;

        if (convData.error) {
          this.logger.warn(`[IG Sync] Error fetching IG conversations for page ${fbAccount.pageId}: ${convData.error.message}`);
          continue;
        }

        const conversations = convData.data || [];
        this.logger.log(`[IG Sync] Found ${conversations.length} IG conversations for page ${fbAccount.pageId}`);

        for (const conv of conversations) {
          const convId = conv.id;
          const participants = conv.participants?.data || [];
          // The sender is the participant that's not our IG account
          const sender = participants.find((p: any) => p.id !== igAccount.accountId);
          const senderId = sender?.id || convId;
          const senderName = sender?.name || `Instagram User ${senderId.slice(-4)}`;
          const senderUsername = sender?.username;

          // Get or create contact (same helper as webhook)
          const contact = await this.getOrCreateContact(tenantId, senderId, fbAccount.accessToken, 'instagram');

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
          const msgData = await msgResp.json() as any;

          if (msgData.error) {
            this.logger.warn(`[IG Sync] Error fetching messages for conv ${convId}: ${msgData.error.message}`);
            continue;
          }

          const messages = msgData.data || [];
          // Messages are in reverse chronological order, process oldest first
          for (const msg of messages.reverse()) {
            const msgId = msg.id;

            // Fetch message details first (needed for from.id = IGSID)
            const detailUrl = `${this.graphApiUrl}/${msgId}?fields=from,created_time,message,attachments&access_token=${fbAccount.accessToken}`;
            const detailResp = await fetch(detailUrl);
            const detail = await detailResp.json() as any;

            if (detail.error) continue;

            const isFromUs = detail.from?.id === igAccount.accountId || detail.from?.id === fbAccount.pageId;

            // For inbound messages, set/fix externalId to the sender IGSID from message details.
            // It must not be the Graph conversation id; Send API needs the sender id.
            if (!isFromUs && detail.from?.id) {
              const currentExternalId = conversation.metadata?.externalId;
              const shouldFixExternalId = !currentExternalId || currentExternalId === convId || currentExternalId === senderId;
              if (shouldFixExternalId && currentExternalId !== detail.from.id) {
                this.logger.log(`[IG Sync] Setting conversation externalId from ${currentExternalId} to ${detail.from.id} (IGSID from message)`);
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
              if (att.image) { type = 'image'; media = { url: att.image, mimeType: 'image/jpeg' }; content = content || '[Imagen]'; }
              else if (att.video) { type = 'video'; media = { url: att.video, mimeType: 'video/mp4' }; content = content || '[Video]'; }
              else if (att.audio) { type = 'audio'; media = { url: att.audio, mimeType: 'audio/mpeg' }; content = content || '[Audio]'; }
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
                  { $set: { 'metadata.externalId': msgId, 'metadata.platform': 'instagram' } },
                );
                continue;
              }
            }

            const newMessage = new this.messageModel({
              tenantId: new Types.ObjectId(tenantId),
              conversationId: conversation._id,
              direction: isFromUs ? MessageDirection.OUTBOUND : MessageDirection.INBOUND,
              type,
              content,
              media,
              senderName: isFromUs ? igAccount.accountName : (senderUsername ? `@${senderUsername}` : senderName),
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
            const isBeingViewed = this.eventsGateway.isConversationBeingViewed(conversation._id.toString());
            const updatedConv = await this.conversationModel.findByIdAndUpdate(
              conversation._id,
              {
                lastMessage: content,
                lastMessageAt: new Date(detail.created_time || Date.now()),
                status: ConversationStatus.IN_PROGRESS,
                $inc: { unreadCount: isFromUs ? 0 : (isBeingViewed ? 0 : 1) },
              },
              { new: true }
            ).populate('contactId').lean();
            // Notify conversation list update for UI refresh
            if (updatedConv) {
              this.eventsGateway.emitConversationUpdated(tenantId, updatedConv);
            }

            // Emit real-time events (same as handleIncomingMessage)
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
        }
      } catch (e: any) {
        this.logger.error(`[IG Sync] Error syncing Instagram DMs for page ${fbAccount.pageId}: ${e.message}`);
      }
    }

    this.logger.log(`[IG Sync] Completed: ${result.newConversations} new conversations, ${result.newMessages} new messages`);
    return result;
  }
}
