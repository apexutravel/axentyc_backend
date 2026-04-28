import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
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

@Injectable()
export class FacebookService {
  private readonly logger = new Logger(FacebookService.name);

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

    this.logger.log(`Facebook config saved for tenant ${tenantId} (secret ${appSecret && !appSecret.includes('•') ? 'updated — starts with: ' + appSecret.substring(0, 4) + '...' : 'preserved'})`);
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
      'pages_show_list',
      'pages_manage_metadata',
      'pages_read_engagement',
      'instagram_business_basic',
      'instagram_manage_comments',
      'instagram_business_manage_messages',
    ].join(',');

    return `https://www.facebook.com/v21.0/dialog/oauth?client_id=${config.appId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${scopes}&response_type=code&state=${tenantId}`;
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
    const url = `${this.graphApiUrl}/me/accounts?access_token=${userAccessToken}&fields=id,name,access_token,picture,category,fan_count,instagram_business_account`;

    this.logger.log(`[getUserPages] Fetching pages with token: ${userAccessToken?.substring(0, 15)}...`);
    this.logger.log(`[getUserPages] Full URL: ${url.replace(userAccessToken, 'TOKEN_HIDDEN')}`);

    const response = await fetch(url);
    const data = await response.json() as any;

    this.logger.log(`[getUserPages] Raw Facebook response: ${JSON.stringify(data)}`);

    if (data.error) {
      this.logger.error(`[getUserPages] Facebook API error: ${JSON.stringify(data.error)}`);
      throw new BadRequestException(data.error.message || 'Failed to get pages');
    }

    const pages = await Promise.all((data.data || []).map(async (page: any) => {
      let instagramAccount = null;
      
      // Check if page has Instagram Business Account linked
      if (page.instagram_business_account?.id) {
        try {
          const igData = await this.getInstagramAccountInfo(
            page.instagram_business_account.id,
            page.access_token
          );
          instagramAccount = igData;
        } catch (err) {
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
      };
    }));

    this.logger.log(`[getUserPages] Mapped ${pages.length} pages: ${JSON.stringify(pages.map((p: any) => ({ id: p.id, name: p.name, hasInstagram: !!p.instagramAccount })))}`);
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
      // Subscribe Instagram to webhook
      await this.subscribeInstagramToWebhook(instagramAccount.id, pageAccessToken);
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
    }

    this.logger.log(`Facebook page "${pageName}" (${pageId}) connected for tenant ${tenantId}`);
    return account;
  }

  async disconnect(tenantId: string, accountId: string): Promise<void> {
    const account = await this.socialAccountModel.findOne({
      _id: accountId,
      tenantId: new Types.ObjectId(tenantId),
      platform: SocialPlatform.FACEBOOK,
    });

    if (!account) {
      throw new NotFoundException('Facebook account not found');
    }

    // Unsubscribe from webhook
    if (account.pageId && account.accessToken) {
      try {
        await this.unsubscribePageFromWebhook(account.pageId, account.accessToken);
      } catch (e) {
        this.logger.warn(`Failed to unsubscribe page ${account.pageId} from webhook: ${e}`);
      }
    }

    account.status = SocialAccountStatus.DISCONNECTED;
    account.accessToken = undefined;
    account.isActive = false;
    await account.save();

    this.logger.log(`Facebook page disconnected for tenant ${tenantId}`);
  }

  async getStatus(tenantId: string): Promise<{
    connected: boolean;
    accounts: SocialAccount[];
  }> {
    const accounts = await this.socialAccountModel
      .find({
        tenantId: new Types.ObjectId(tenantId),
        platform: SocialPlatform.FACEBOOK,
      })
      .exec();

    return {
      connected: accounts.some(a => a.status === SocialAccountStatus.CONNECTED),
      accounts,
    };
  }

  // ─── Webhook Subscription ───

  private async subscribePageToWebhook(pageId: string, pageAccessToken: string): Promise<void> {
    const url = `${this.graphApiUrl}/${pageId}/subscribed_apps`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        access_token: pageAccessToken,
        subscribed_fields: ['messages', 'messaging_postbacks', 'message_reads', 'message_deliveries'],
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
        subscribed_fields: ['messages', 'messaging_postbacks', 'message_reads'],
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
    if (body.object === 'page') {
      await this.handlePageWebhook(body);
    } else if (body.object === 'instagram') {
      await this.handleInstagramWebhook(body);
    } else {
      this.logger.warn(`Received unknown webhook object type: ${body.object}`);
    }
  }

  private async handlePageWebhook(body: any): Promise<void> {
    for (const entry of body.entry || []) {
      const pageId = entry.id;

      for (const event of entry.messaging || []) {
        try {
          if (event.message && !event.message.is_echo) {
            await this.handleIncomingMessage(pageId, event, 'facebook');
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
    }
  }

  private async handleInstagramWebhook(body: any): Promise<void> {
    for (const entry of body.entry || []) {
      const igAccountId = entry.id;

      for (const event of entry.messaging || []) {
        try {
          if (event.message && !event.message.is_echo) {
            await this.handleIncomingMessage(igAccountId, event, 'instagram');
          } else if (event.read) {
            await this.handleMessageRead(igAccountId, event);
          }
        } catch (err) {
          this.logger.error(`Error processing Instagram webhook event for account ${igAccountId}:`, err);
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

    // Find the social account (Facebook page or Instagram account)
    const account = await this.socialAccountModel.findOne({
      $or: [
        { pageId: recipientId || accountId, platform: platform === 'facebook' ? SocialPlatform.FACEBOOK : SocialPlatform.INSTAGRAM },
        { accountId: recipientId || accountId, platform: platform === 'facebook' ? SocialPlatform.FACEBOOK : SocialPlatform.INSTAGRAM },
      ],
      status: SocialAccountStatus.CONNECTED,
    });

    if (!account) {
      this.logger.warn(`No connected ${platform} account found for ${accountId}`);
      return;
    }

    const tenantId = account.tenantId.toString();

    // Get or create contact
    const contact = await this.getOrCreateContact(tenantId, senderId, account.accessToken, platform);

    // Get or create conversation
    const conversation = await this.getOrCreateConversation(
      tenantId,
      contact._id.toString(),
      senderId,
      accountId,
      platform,
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
        platform: 'facebook',
      },
    });
    const savedMessage = await newMessage.save();

    // Update conversation
    const isBeingViewed = this.eventsGateway.isConversationBeingViewed(conversation._id.toString());
    await this.conversationModel.findByIdAndUpdate(conversation._id, {
      lastMessage: content,
      lastMessageAt: new Date(),
      status: ConversationStatus.IN_PROGRESS,
      $inc: { unreadCount: isBeingViewed ? 0 : 1 },
    });

    // Emit real-time events
    this.eventsGateway.emitMessageReceived(
      tenantId,
      conversation._id.toString(),
      savedMessage,
      contact,
    );

    this.eventsGateway.emitToConversation(
      conversation._id.toString(),
      'message.new',
      savedMessage,
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
    if (!conversation || conversation.channel !== ConversationChannel.FACEBOOK) {
      return false;
    }

    const externalId = conversation.metadata?.externalId; // sender PSID
    const pageId = conversation.metadata?.pageId;
    if (!externalId || !pageId) {
      this.logger.warn(`Missing externalId or pageId for conversation ${conversationId}`);
      return false;
    }

    // Find the page access token
    const account = await this.socialAccountModel.findOne({
      tenantId: new Types.ObjectId(tenantId),
      platform: SocialPlatform.FACEBOOK,
      pageId,
      status: SocialAccountStatus.CONNECTED,
    });

    if (!account?.accessToken) {
      this.logger.warn(`No access token for page ${pageId}`);
      return false;
    }

    // Build Graph API message
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
      this.logger.error(`Failed to send FB message: ${result.error.message}`);
      return false;
    }

    this.logger.log(`FB message sent to ${externalId}, mid: ${result.message_id}`);
    return true;
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
  ): Promise<any> {
    const channel = platform === 'instagram' ? ConversationChannel.INSTAGRAM : ConversationChannel.FACEBOOK;
    
    // Try to find existing conversation
    const existing = await this.conversationModel.findOne({
      tenantId: new Types.ObjectId(tenantId),
      channel,
      'metadata.externalId': senderId,
      $or: [
        { 'metadata.pageId': accountId },
        { 'metadata.accountId': accountId },
      ],
    });

    if (existing) return existing;

    // Create new conversation
    const subject = platform === 'instagram' ? 'Instagram DM' : 'Facebook Messenger';
    const metadata: any = {
      externalId: senderId,
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
    return newConversation.save();
  }
}
