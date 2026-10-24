import { EventEmitter2 } from '@nestjs/event-emitter';
import { AUTOMATION_EVENT } from '../automations/automation-events';
import type { AutomationEventPayload } from '../automations/automation-events';
import { AutomationTrigger } from '../automations/entities/automation.entity';
import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { Model, Types } from 'mongoose';
import { randomBytes } from 'crypto';
import { WidgetConfig, WidgetConfigDocument } from './entities/widget-config.entity';
import { CreateWidgetConfigDto } from './dto/create-widget-config.dto';
import { UpdateWidgetConfigDto } from './dto/update-widget-config.dto';
import { ConversationsService } from '../conversations/conversations.service';
import { ConversationChannel } from '../conversations/entities/conversation.entity';
import { MessageDirection } from '../conversations/entities/message.entity';
import { EventsGateway } from '../events/events.gateway';
import { FirebaseAdminService } from '../firebase/firebase-admin.service';
import { UsersService } from '../users/users.service';
import { extractContactInfo, hasExtractedInfo, extractSubject } from '../common/utils/contact-info-extractor';
import { BillingService } from '../billing/billing.service';

@Injectable()
export class ChatWidgetService {
  constructor(
    @InjectModel(WidgetConfig.name)
    private widgetConfigModel: Model<WidgetConfigDocument>,
    private conversationsService: ConversationsService,
    private eventsGateway: EventsGateway,
    private configService: ConfigService,
    private firebaseAdminService: FirebaseAdminService,
    private usersService: UsersService,
    private billingService: BillingService,
    private bus: EventEmitter2,
  ) {}

  async createWidgetConfig(
    tenantId: string,
    createDto: CreateWidgetConfigDto,
  ): Promise<WidgetConfig> {
    await this.billingService.assertCanCreateWidget(tenantId, createDto.workspaceId);

    const query: any = { tenantId: new Types.ObjectId(tenantId) };
    if (createDto.workspaceId) query.workspaceId = new Types.ObjectId(createDto.workspaceId);

    const existing = await this.widgetConfigModel.findOne(query);
    
    if (existing) {
      throw new BadRequestException('Widget configuration already exists for this tenant');
    }

    const widgetId = this.generateWidgetId();

    const widgetConfig = new this.widgetConfigModel({
      tenantId: new Types.ObjectId(tenantId),
      workspaceId: createDto.workspaceId ? new Types.ObjectId(createDto.workspaceId) : undefined,
      widgetId,
      ...createDto,
    });

    return widgetConfig.save();
  }

  async saveWidgetConfig(
    tenantId: string,
    dto: UpdateWidgetConfigDto,
  ): Promise<WidgetConfig> {
    const query: any = { tenantId: new Types.ObjectId(tenantId) };
    if (dto.workspaceId) query.workspaceId = new Types.ObjectId(dto.workspaceId);

    const existing = await this.widgetConfigModel.findOne(query);

    const plain: any = Object.fromEntries(
      Object.entries({ ...dto }).filter(([, v]) => v !== undefined),
    );
    // Only plans that include it may hide the AXENTYC badge
    if (plain.showBranding === false && !(await this.billingService.canRemoveBranding(tenantId))) {
      plain.showBranding = true;
    }
    if (plain.workspaceId) {
      plain.workspaceId = new Types.ObjectId(plain.workspaceId as string);
    }

    if (existing) {
      const updated = await this.widgetConfigModel.findOneAndUpdate(
        query,
        { $set: plain },
        { returnDocument: 'after' },
      );
      return updated!;
    }

    await this.billingService.assertCanCreateWidget(tenantId, dto.workspaceId);

    const widgetId = this.generateWidgetId();
    const widgetConfig = new this.widgetConfigModel({
      tenantId: new Types.ObjectId(tenantId),
      workspaceId: plain.workspaceId,
      widgetId,
      ...plain,
    });
    return widgetConfig.save();
  }

  async getWidgetConfig(tenantId: string, workspaceId?: string): Promise<WidgetConfig> {
    const query: any = { tenantId: new Types.ObjectId(tenantId) };
    if (workspaceId) query.workspaceId = new Types.ObjectId(workspaceId);

    const config = await this.widgetConfigModel.findOne(query);
    
    if (!config) {
      throw new NotFoundException('Widget configuration not found');
    }

    return config;
  }

  async getWidgetConfigOrNull(tenantId: string, workspaceId?: string): Promise<WidgetConfig | null> {
    const query: any = { tenantId: new Types.ObjectId(tenantId) };
    if (workspaceId) query.workspaceId = new Types.ObjectId(workspaceId);

    return this.widgetConfigModel.findOne(query);
  }

  async getWidgetConfigByWidgetId(widgetId: string): Promise<WidgetConfig> {
    const config = await this.widgetConfigModel.findOne({ widgetId }).lean();
    
    if (!config) {
      throw new NotFoundException('Widget configuration not found');
    }

    return config as WidgetConfig;
  }

  async updateWidgetConfig(
    tenantId: string,
    updateDto: UpdateWidgetConfigDto,
  ): Promise<WidgetConfig> {
    const config = await this.widgetConfigModel.findOneAndUpdate(
      { tenantId: new Types.ObjectId(tenantId) },
      { $set: updateDto },
      { returnDocument: 'after' },
    );

    if (!config) {
      throw new NotFoundException('Widget configuration not found');
    }

    return config;
  }

  canHideBranding(tenantId: string): Promise<boolean> {
    return this.billingService.canRemoveBranding(tenantId);
  }

  async regenerateWidgetId(tenantId: string): Promise<WidgetConfig> {
    const widgetId = this.generateWidgetId();

    const config = await this.widgetConfigModel.findOneAndUpdate(
      { tenantId: new Types.ObjectId(tenantId) },
      { $set: { widgetId } },
      { returnDocument: 'after' },
    );

    if (!config) {
      throw new NotFoundException('Widget configuration not found');
    }

    return config;
  }

  async handleWidgetMessage(
    widgetId: string,
    message: string,
    visitorId: string,
    type?: string,
    media?: {
      url: string;
      mimeType?: string;
      fileName?: string;
      fileSize?: number;
      thumbnailUrl?: string;
    },
    visitorData?: {
      name?: string;
      email?: string;
      phone?: string;
      metadata?: any;
    },
  ) {
    const config = await this.getWidgetConfigByWidgetId(widgetId);

    if (!config.enabled) {
      throw new BadRequestException('Widget is currently disabled');
    }

    let conversation = await this.conversationsService.findByWidgetVisitor(
      config.tenantId.toString(),
      visitorId,
      (config as any).workspaceId?.toString(),
    );

    let createdNewConversation = false;
    if (!conversation) {
      createdNewConversation = true;
      // Always create contact - simpler and more reliable
      const contact = await this.conversationsService.createWidgetContact(
        config.tenantId.toString(),
        (config as any).workspaceId?.toString(),
        visitorId,
        visitorData,
      );

      conversation = await this.conversationsService.create(
        config.tenantId.toString(),
        {
          workspaceId: (config as any).workspaceId?.toString(),
          contactId: (contact as any)._id.toString(),
          channel: ConversationChannel.WEB_CHAT,
          subject: `Chat Widget - ${visitorData?.name || visitorId}`,
          metadata: {
            widgetId,
            visitorId,
          },
        },
      );

      // Notify admin about new conversation
      this.eventsGateway.emitToTenant(
        config.tenantId.toString(),
        'conversation.created',
        conversation,
      );
    }

    const messageDoc = await this.conversationsService.addMessage(
      (conversation as any)._id.toString(),
      {
        content: message,
        direction: MessageDirection.INBOUND,
        type: type as any,
        media,
        senderName: visitorData?.name || 'Visitor',
        metadata: {
          widgetId,
          visitorId,
        },
      },
    );

    const conversationId = (conversation as any)._id.toString();

    // Get contact info for notification - contactId might be populated or just an ID
    let contact: any = null;
    if (conversation.contactId) {
      // Check if already populated
      if (typeof conversation.contactId === 'object' && (conversation.contactId as any).name) {
        contact = conversation.contactId;
      } else {
        // Fetch contact if only ID is present
        try {
          contact = await this.conversationsService.getContactById((conversation.contactId as any).toString());
        } catch (error) {
          console.error('[ChatWidget] Failed to fetch contact:', error);
          contact = null;
        }
      }
    }

    this.eventsGateway.emitMessageReceived(
      config.tenantId.toString(),
      conversationId,
      messageDoc,
      contact,
    );
    this.eventsGateway.emitAdminMessage(conversationId, {
      conversationId,
      message: messageDoc,
    });

    // Automations: a brand new chat, and the message itself
    const wsId = (config as any).workspaceId?.toString();
    const base = { tenantId: config.tenantId.toString(), workspaceId: wsId, conversationId, contactId: contact?._id ? String(contact._id) : undefined, channel: 'web_chat' };
    if (createdNewConversation) {
      this.bus.emit(AUTOMATION_EVENT, { ...base, trigger: AutomationTrigger.CONVERSATION_CREATED } as AutomationEventPayload);
    }
    this.bus.emit(AUTOMATION_EVENT, { ...base, trigger: AutomationTrigger.MESSAGE_RECEIVED, text: message } as AutomationEventPayload);

    // Send FCM push notifications to all users in tenant
    this.sendPushNotificationsToTenant(
      config.tenantId.toString(),
      conversationId,
      visitorData?.name || 'Visitante',
      message,
    ).catch((error) => {
      console.error('[FCM] Failed to send push notifications:', error);
    });

    // Auto-detect contact info (email, phone, name) from inbound message
    this.autoEnrichContact(conversation, message).catch(() => {});

    return {
      conversationId,
      message: messageDoc,
    };
  }

  async getWidgetConversationMessages(widgetId: string, visitorId: string) {
    const config = await this.getWidgetConfigByWidgetId(widgetId);

    const conversation = await this.conversationsService.findByWidgetVisitor(
      config.tenantId.toString(),
      visitorId,
      (config as any).workspaceId?.toString(),
    );

    if (!conversation) {
      return [];
    }

    return this.conversationsService.getWidgetMessages((conversation as any)._id.toString());
  }

  async markMessagesAsRead(widgetId: string, visitorId: string) {
    const config = await this.getWidgetConfigByWidgetId(widgetId);

    const conversation = await this.conversationsService.findByWidgetVisitor(
      config.tenantId.toString(),
      visitorId,
      (config as any).workspaceId?.toString(),
    );

    if (!conversation) {
      return { modified: 0 };
    }

    const modified = await this.conversationsService.markOutboundAsRead(
      (conversation as any)._id.toString(),
    );

    return { modified };
  }

  private async autoEnrichContact(conversation: any, messageText: string): Promise<void> {
    const tenantId = conversation.tenantId?.toString();
    if (!tenantId) return;

    const conversationId = (conversation as any)._id.toString();

    // --- Auto-detect contact info (email, phone, name) ---
    const extracted = extractContactInfo(messageText);
    const contactId = conversation.contactId?._id || conversation.contactId;

    if (hasExtractedInfo(extracted) && contactId) {
      const updateData: Record<string, any> = {};
      if (extracted.email) updateData.email = extracted.email;
      if (extracted.phone) updateData.phone = extracted.phone;
      if (extracted.name) updateData.name = extracted.name;

      if (Object.keys(updateData).length > 0) {
        await this.conversationsService.updateContact(tenantId, contactId.toString(), updateData);

        this.eventsGateway.emitToTenant(tenantId, 'contact.enriched', {
          conversationId,
          contactId: contactId.toString(),
          enrichedFields: Object.keys(updateData),
          data: updateData,
        });
      }
    }

    // --- Auto-detect conversation subject/topic ---
    const currentSubject = conversation.subject || '';
    const isGenericSubject = !currentSubject || currentSubject.startsWith('Chat Widget');

    if (isGenericSubject) {
      const subjectResult = extractSubject(messageText);
      if (subjectResult) {
        const convUpdate: Record<string, any> = { subject: subjectResult.subject };
        if (subjectResult.tags.length > 0) {
          convUpdate.tags = [...new Set([...(conversation.tags || []), ...subjectResult.tags])];
        }
        await this.conversationsService.updateConversationFields(conversationId, tenantId, convUpdate);

        this.eventsGateway.emitToTenant(tenantId, 'conversation.updated', {
          _id: conversationId,
          subject: subjectResult.subject,
          tags: convUpdate.tags || conversation.tags,
        });
      }
    }
  }

  private async sendPushNotificationsToTenant(
    tenantId: string,
    conversationId: string,
    senderName: string,
    messageContent: string,
  ): Promise<void> {
    try {
      const users = await this.usersService.findByTenant(tenantId);
      const allTokens: string[] = [];

      for (const user of users) {
        if (user.fcmTokens && user.fcmTokens.length > 0) {
          allTokens.push(...user.fcmTokens);
        }
      }

      if (allTokens.length === 0) {
        return;
      }

      await this.firebaseAdminService.sendToMultipleDevices(
        allTokens,
        'Nuevo mensaje de chat',
        `${senderName}: ${messageContent.substring(0, 100)}`,
        {
          conversationId,
          type: 'chat_message',
          senderName,
        },
      );
    } catch (error) {
      console.error('[FCM] Error sending push notifications:', error);
      throw error;
    }
  }

  private generateWidgetId(): string {
    return `wdg_${randomBytes(16).toString('hex')}`;
  }

  getWidgetScript(widgetId: string): string {
    const port = this.configService.get<number>('PORT') || 3001;
    const apiPrefix = this.configService.get<string>('API_PREFIX') || 'api/v1';
    const apiUrl = this.configService.get<string>('API_URL');
    
    // Construir baseUrl dinámicamente
    const baseUrl = apiUrl || `http://localhost:${port}`;
    
    return `
<!-- AXENTYC Chat Widget -->
<script>
  (function() {
    window.AXENTYCWidget = {
      widgetId: '${widgetId}',
      apiUrl: '${baseUrl}/${apiPrefix}'
    };
    var script = document.createElement('script');
    script.src = '${baseUrl}/widget/widget.js';
    script.async = true;
    document.head.appendChild(script);
  })();
</script>
    `.trim();
  }
}
