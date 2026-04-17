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

  // Get tenant-specific Facebook config from database
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
    appSecret: string,
    verifyToken?: string,
  ): Promise<FacebookConfig> {
    const config = await this.facebookConfigModel.findOneAndUpdate(
      { tenantId: new Types.ObjectId(tenantId) },
      {
        tenantId: new Types.ObjectId(tenantId),
        appId,
        appSecret,
        verifyToken: verifyToken || 'axentyc_fb_verify',
        isActive: true,
      },
      { upsert: true, new: true },
    );

    this.logger.log(`Facebook config saved for tenant ${tenantId}`);
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
    const config = await this.getTenantConfig(tenantId);
    if (!config) {
      this.logger.warn(`No Facebook config found for tenant ${tenantId}`);
      return null;
    }

    const scopes = [
      'pages_messaging',
      'pages_show_list',
      'pages_manage_metadata',
      'pages_read_engagement',
    ].join(',');

    return `https://www.facebook.com/v21.0/dialog/oauth?client_id=${config.appId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${scopes}&response_type=code&state=${tenantId}`;
  }

  async exchangeCodeForToken(tenantId: string, code: string, redirectUri: string): Promise<{
    accessToken: string;
    expiresIn: number;
  }> {
    const config = await this.getTenantConfig(tenantId);
    if (!config) {
      throw new BadRequestException('No Facebook configuration found for this tenant');
    }

    this.logger.log(`Exchange token - appId: ${config.appId}, secret length: ${config.appSecret?.length}, redirectUri: ${redirectUri}`);

    const url = `${this.graphApiUrl}/oauth/access_token?client_id=${config.appId}&client_secret=${config.appSecret}&redirect_uri=${encodeURIComponent(redirectUri)}&code=${code}`;

    const response = await fetch(url);
    const data = await response.json() as any;

    if (data.error) {
      this.logger.error(`Facebook OAuth error: ${JSON.stringify(data.error)}`);
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
    const config = await this.getTenantConfig(tenantId);
    if (!config) {
      throw new BadRequestException('No Facebook configuration found for this tenant');
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
    const url = `${this.graphApiUrl}/me/accounts?access_token=${userAccessToken}&fields=id,name,access_token,picture,category,fan_count`;

    this.logger.log(`Fetching pages with token: ${userAccessToken?.substring(0, 15)}...`);

    const response = await fetch(url);
    const data = await response.json() as any;

    this.logger.log(`Facebook /me/accounts response: ${JSON.stringify({ data: data.data?.length ?? 0, error: data.error || null })}`);

    if (data.error) {
      this.logger.error(`getUserPages error: ${JSON.stringify(data.error)}`);
      throw new BadRequestException(data.error.message || 'Failed to get pages');
    }

    const pages = (data.data || []).map((page: any) => ({
      id: page.id,
      name: page.name,
      accessToken: page.access_token,
      picture: page.picture?.data?.url,
      category: page.category,
      fanCount: page.fan_count,
    }));

    this.logger.log(`Found ${pages.length} pages: ${pages.map((p: any) => p.name).join(', ')}`);
    return pages;
  }

  // ─── Connect / Disconnect ───

  async connectPage(
    tenantId: string,
    pageId: string,
    pageName: string,
    pageAccessToken: string,
    metadata?: Record<string, any>,
  ): Promise<SocialAccount> {
    // Subscribe page to webhook
    await this.subscribePageToWebhook(pageId, pageAccessToken);

    // Upsert social account
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

  // ─── Webhook Handler ───

  async verifyWebhook(mode: string, token: string, challenge: string): Promise<string> {
    if (mode !== 'subscribe') {
      throw new BadRequestException('Invalid mode');
    }

    // Check if token matches any tenant's verify token in DB
    const config = await this.facebookConfigModel.findOne({
      verifyToken: token,
      isActive: true,
    });

    if (config) {
      this.logger.log(`Facebook webhook verified for tenant ${config.tenantId}`);
      return challenge;
    }

    this.logger.warn(`Webhook verification failed - token not found: ${token}`);
    throw new BadRequestException('Webhook verification failed');
  }

  async handleWebhook(body: any): Promise<void> {
    if (body.object !== 'page') {
      this.logger.warn('Received non-page webhook event');
      return;
    }

    for (const entry of body.entry || []) {
      const pageId = entry.id;

      for (const event of entry.messaging || []) {
        try {
          if (event.message && !event.message.is_echo) {
            await this.handleIncomingMessage(pageId, event);
          } else if (event.message?.is_echo) {
            // Echo of our own sent message, skip
            this.logger.debug('Received echo, skipping');
          } else if (event.read) {
            await this.handleMessageRead(pageId, event);
          } else if (event.delivery) {
            // Delivery receipt - log only
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

  private async handleIncomingMessage(pageId: string, event: any): Promise<void> {
    const senderId = event.sender?.id;
    const recipientId = event.recipient?.id;
    const timestamp = event.timestamp;
    const message = event.message;

    if (!senderId || !message) return;

    this.logger.log(`Incoming FB message from ${senderId} to page ${pageId}`);

    // Find the social account for this page
    const account = await this.socialAccountModel.findOne({
      pageId: recipientId || pageId,
      platform: SocialPlatform.FACEBOOK,
      status: SocialAccountStatus.CONNECTED,
    });

    if (!account) {
      this.logger.warn(`No connected Facebook account found for page ${pageId}`);
      return;
    }

    const tenantId = account.tenantId.toString();

    // Get or create contact
    const contact = await this.getOrCreateContact(tenantId, senderId, account.accessToken);

    // Get or create conversation
    const conversation = await this.getOrCreateConversation(
      tenantId,
      contact._id.toString(),
      senderId,
      pageId,
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
      await this.handleIncomingMessage(pageId, fakeMessage);
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
  ): Promise<ContactDocument> {
    // Check if contact exists by FB PSID
    let contact = await this.contactModel.findOne({
      tenantId: new Types.ObjectId(tenantId),
      'customFields.facebookPsid': senderId,
    });

    if (contact) return contact;

    // Get profile from Facebook
    let name = `Facebook User ${senderId.slice(-4)}`;
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
        this.logger.warn(`Failed to get FB profile for ${senderId}`);
      }
    }

    // Create contact
    contact = new this.contactModel({
      tenantId: new Types.ObjectId(tenantId),
      name,
      source: ContactSource.FACEBOOK || 'facebook',
      avatar: profilePic,
      tags: ['facebook', 'messenger'],
      customFields: {
        facebookPsid: senderId,
      },
    });

    return contact.save();
  }

  private async getOrCreateConversation(
    tenantId: string,
    contactId: string,
    senderId: string,
    pageId: string,
  ): Promise<any> {
    // Try to find existing conversation
    const existing = await this.conversationModel.findOne({
      tenantId: new Types.ObjectId(tenantId),
      channel: ConversationChannel.FACEBOOK,
      'metadata.externalId': senderId,
      'metadata.pageId': pageId,
    });

    if (existing) return existing;

    // Create new conversation
    const newConversation = new this.conversationModel({
      tenantId: new Types.ObjectId(tenantId),
      contactId: new Types.ObjectId(contactId),
      channel: ConversationChannel.FACEBOOK,
      subject: 'Facebook Messenger',
      status: ConversationStatus.OPEN,
      metadata: {
        externalId: senderId,
        pageId,
      },
    });
    return newConversation.save();
  }
}
