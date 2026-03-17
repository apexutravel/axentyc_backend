import {
  Injectable,
  NotFoundException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Conversation, ConversationDocument, ConversationStatus } from './entities/conversation.entity';
import { Message, MessageDocument, MessageDirection, MessageStatus, MessageType } from './entities/message.entity';
import { CreateConversationDto } from './dto/create-conversation.dto';
import { UpdateConversationDto } from './dto/update-conversation.dto';
import { SendMessageDto } from './dto/send-message.dto';
import { Contact, ContactDocument, ContactSource } from '../crm/entities/contact.entity';
import { EventsGateway } from '../events/events.gateway';
import { FacebookService } from '../facebook/facebook.service';

@Injectable()
export class ConversationsService {
  constructor(
    @InjectModel(Conversation.name)
    private conversationModel: Model<ConversationDocument>,
    @InjectModel(Message.name)
    private messageModel: Model<MessageDocument>,
    @InjectModel(Contact.name)
    private contactModel: Model<ContactDocument>,
    @Inject(forwardRef(() => EventsGateway))
    private eventsGateway: EventsGateway,
    @Inject(forwardRef(() => FacebookService))
    private facebookService: FacebookService,
  ) {}

  async create(tenantId: string, dto: CreateConversationDto): Promise<Conversation> {
    const conversation = new this.conversationModel({
      ...dto,
      tenantId: new Types.ObjectId(tenantId),
      contactId: new Types.ObjectId(dto.contactId),
      assignedTo: dto.assignedTo ? new Types.ObjectId(dto.assignedTo) : undefined,
    });
    const saved = await conversation.save();
    const populated = await this.conversationModel
      .findById(saved._id)
      .populate('contactId')
      .populate('assignedTo', 'firstName lastName email')
      .exec();
    if (!populated) {
      throw new Error('Failed to populate conversation after creation');
    }
    return populated;
  }

  async findAll(tenantId: string, filters?: {
    status?: string;
    channel?: string;
    assignedTo?: string;
    tags?: string[];
  }): Promise<Conversation[]> {
    const query: any = { tenantId: new Types.ObjectId(tenantId) };

    if (filters?.status) query.status = filters.status;
    if (filters?.channel) query.channel = filters.channel;
    if (filters?.assignedTo) query.assignedTo = new Types.ObjectId(filters.assignedTo);
    if (filters?.tags?.length) query.tags = { $in: filters.tags };

    return this.conversationModel
      .find(query)
      .populate('contactId')
      .populate('assignedTo', 'firstName lastName email')
      .sort({ lastMessageAt: -1 })
      .exec();
  }

  async findOne(tenantId: string, id: string): Promise<Conversation> {
    const conversation = await this.conversationModel
      .findOne({ _id: id, tenantId: new Types.ObjectId(tenantId) })
      .populate('contactId')
      .populate('assignedTo', 'firstName lastName email')
      .exec();
    if (!conversation) {
      throw new NotFoundException(`Conversation with ID ${id} not found`);
    }
    return conversation;
  }

  async update(tenantId: string, id: string, dto: UpdateConversationDto): Promise<Conversation> {
    const updateData: any = { ...dto };
    if (dto.assignedTo) {
      updateData.assignedTo = new Types.ObjectId(dto.assignedTo);
      if (!dto.status) {
        updateData.status = ConversationStatus.ASSIGNED;
      }
    }

    const conversation = await this.conversationModel
      .findOneAndUpdate(
        { _id: id, tenantId: new Types.ObjectId(tenantId) },
        updateData,
        { returnDocument: 'after' },
      )
      .populate('contactId')
      .populate('assignedTo', 'firstName lastName email')
      .exec();
    if (!conversation) {
      throw new NotFoundException(`Conversation with ID ${id} not found`);
    }
    return conversation;
  }

  private ensureAbsoluteMediaUrl(message: any): any {
    if (!message.media?.url) return message;
    if (message.media.url.startsWith('http')) return message;
    
    const baseUrl = process.env.APP_URL || process.env.BACKEND_URL || 'http://localhost:3001';
    return {
      ...message,
      media: {
        ...message.media,
        url: `${baseUrl}${message.media.url}`,
      },
    };
  }

  async sendMessage(
    tenantId: string,
    conversationId: string,
    senderId: string,
    dto: SendMessageDto,
  ): Promise<Message> {
    await this.findOne(tenantId, conversationId);

    const message = new this.messageModel({
      tenantId: new Types.ObjectId(tenantId),
      conversationId: new Types.ObjectId(conversationId),
      direction: MessageDirection.OUTBOUND,
      type: dto.type || 'text',
      content: dto.content,
      media: dto.media,
      senderId: new Types.ObjectId(senderId),
      status: MessageStatus.SENT,
    });

    const savedMessage = await message.save();

    const conv = await this.conversationModel.findByIdAndUpdate(conversationId, {
      $set: { status: ConversationStatus.IN_PROGRESS },
      lastMessage: dto.content,
      lastMessageAt: new Date(),
    });

    if (conv) {
      this.eventsGateway.emitToConversation(conversationId, 'message.new', savedMessage);

      if (conv.metadata?.visitorId && conv.metadata?.widgetId) {
        const messageForWidget = this.ensureAbsoluteMediaUrl(savedMessage.toObject());
        this.eventsGateway.emitWidgetMessage(
          conv.metadata.widgetId,
          conv.metadata.visitorId,
          messageForWidget,
        );
      }

      // Send via Facebook Graph API if it's a Facebook conversation
      if (conv.channel === 'facebook' && conv.metadata?.externalId) {
        this.facebookService.sendMessage(
          tenantId,
          conversationId,
          dto.content,
          dto.media ? { url: dto.media.url, mimeType: dto.media.mimeType } : undefined,
        ).catch((err) => {
          console.error('Failed to send Facebook message:', err);
        });
      }
    }

    return savedMessage;
  }

  async getMessages(
    tenantId: string,
    conversationId: string,
    page = 1,
    limit = 50,
  ): Promise<{ messages: Message[]; total: number }> {
    await this.findOne(tenantId, conversationId);

    const skip = (page - 1) * limit;

    const [messages, total] = await Promise.all([
      this.messageModel
        .find({
          conversationId: new Types.ObjectId(conversationId),
          tenantId: new Types.ObjectId(tenantId),
        })
        .populate('senderId', 'firstName lastName email avatar')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .exec(),
      this.messageModel.countDocuments({
        conversationId: new Types.ObjectId(conversationId),
        tenantId: new Types.ObjectId(tenantId),
      }),
    ]);

    return { messages, total };
  }

  async getWidgetMessages(conversationId: string): Promise<Message[]> {
    return this.messageModel
      .find({ conversationId: new Types.ObjectId(conversationId) })
      .populate('senderId', 'firstName lastName email avatar')
      .sort({ createdAt: 1 })
      .exec();
  }

  async markAsRead(tenantId: string, conversationId: string): Promise<void> {
    const conversation = await this.conversationModel.findOneAndUpdate(
      { _id: conversationId, tenantId: new Types.ObjectId(tenantId) },
      { unreadCount: 0 },
      { returnDocument: 'after' },
    );

    const result = await this.messageModel.updateMany(
      {
        conversationId: new Types.ObjectId(conversationId),
        tenantId: new Types.ObjectId(tenantId),
        direction: MessageDirection.INBOUND,
        status: { $ne: MessageStatus.READ },
      },
      { status: MessageStatus.READ },
    );

    // Emit event to widget if this is a widget conversation
    if (result.modifiedCount > 0 && conversation?.metadata?.visitorId && conversation?.metadata?.widgetId) {
      this.eventsGateway.emitWidgetMessageStatus(
        conversation.metadata.widgetId,
        conversation.metadata.visitorId,
        conversationId,
        MessageStatus.READ,
      );
    }

    // Emit conversation.updated event to update unread counts in real-time
    if (conversation) {
      this.eventsGateway.emitConversationUpdated(tenantId, conversation);
    }
  }

  async markOutboundAsRead(conversationId: string): Promise<number> {
    const conversation = await this.conversationModel.findById(conversationId).exec();
    if (!conversation) return 0;

    const result = await this.messageModel.updateMany(
      {
        conversationId: new Types.ObjectId(conversationId),
        direction: MessageDirection.OUTBOUND,
        status: { $in: [MessageStatus.SENT, MessageStatus.DELIVERED] },
      },
      { status: MessageStatus.READ },
    );

    if (result.modifiedCount > 0) {
      this.eventsGateway.emitToConversation(conversationId, 'message.status.updated', {
        conversationId,
        status: 'read',
      });

      const tenantId = conversation.tenantId?.toString();
      if (tenantId) {
        this.eventsGateway.emitToTenant(tenantId, 'message.status.updated', {
          conversationId,
          status: 'read',
        });
      }
    }

    return result.modifiedCount;
  }

  async findByWidgetVisitor(tenantId: string, visitorId: string): Promise<Conversation | null> {
    return this.conversationModel
      .findOne({
        tenantId: new Types.ObjectId(tenantId),
        'metadata.visitorId': visitorId,
      })
      .populate('contactId')
      .exec();
  }

  async getContactById(contactId: string): Promise<Contact | null> {
    return this.contactModel.findById(contactId).exec();
  }

  async updateConversationFields(conversationId: string, tenantId: string, data: Record<string, any>): Promise<Conversation | null> {
    return this.conversationModel
      .findOneAndUpdate(
        { _id: conversationId, tenantId: new Types.ObjectId(tenantId) },
        { $set: data },
        { returnDocument: 'after' },
      )
      .exec();
  }

  async updateContact(tenantId: string, contactId: string, data: Record<string, any>): Promise<Contact | null> {
    return this.contactModel
      .findOneAndUpdate(
        { _id: contactId, tenantId: new Types.ObjectId(tenantId) },
        { $set: data },
        { returnDocument: 'after' },
      )
      .exec();
  }

  async createWidgetContact(
    tenantId: string,
    visitorId: string,
    visitorData?: {
      name?: string;
      email?: string;
      phone?: string;
      metadata?: any;
    },
  ): Promise<Contact> {
    const contact = new this.contactModel({
      tenantId: new Types.ObjectId(tenantId),
      name: visitorData?.name || `Visitor ${visitorId}`,
      email: visitorData?.email,
      phone: visitorData?.phone,
      source: ContactSource.WEB_CHAT,
      tags: ['widget', 'visitor'],
      customFields: {
        visitorId,
        ...visitorData?.metadata,
      },
    });

    return contact.save();
  }

  async remove(tenantId: string, id: string): Promise<void> {
    const conversation = await this.conversationModel
      .findOneAndDelete({ _id: id, tenantId: new Types.ObjectId(tenantId) })
      .exec();
    if (!conversation) {
      throw new NotFoundException(`Conversation with ID ${id} not found`);
    }
    await this.messageModel.deleteMany({
      conversationId: new Types.ObjectId(id),
      tenantId: new Types.ObjectId(tenantId),
    });
  }

  async addMessage(
    conversationId: string,
    messageData: {
      content: string;
      direction: MessageDirection;
      senderName?: string;
      senderId?: string;
      metadata?: any;
      type?: MessageType | string;
      media?: {
        url: string;
        mimeType?: string;
        fileName?: string;
        fileSize?: number;
      };
    },
  ): Promise<Message> {
    const conversation = await this.conversationModel.findById(conversationId);
    
    if (!conversation) {
      throw new NotFoundException('Conversation not found');
    }

    const message = new this.messageModel({
      tenantId: conversation.tenantId,
      conversationId: new Types.ObjectId(conversationId),
      direction: messageData.direction,
      type: (messageData.type as any) || 'text',
      content: messageData.content,
      media: messageData.media,
      senderName: messageData.senderName,
      senderId: messageData.senderId ? new Types.ObjectId(messageData.senderId) : undefined,
      status: messageData.direction === MessageDirection.INBOUND ? MessageStatus.DELIVERED : MessageStatus.SENT,
      metadata: messageData.metadata,
    });

    const savedMessage = await message.save();

    // Check if conversation is being actively viewed by an admin
    const isBeingViewed = this.eventsGateway.isConversationBeingViewed(conversationId);
    
    // Only increment unreadCount if message is INBOUND and NOT being actively viewed
    const shouldIncrementUnread = messageData.direction === MessageDirection.INBOUND && !isBeingViewed;

    await this.conversationModel.findByIdAndUpdate(conversationId, {
      lastMessage: messageData.content,
      lastMessageAt: new Date(),
      $inc: { unreadCount: shouldIncrementUnread ? 1 : 0 },
    });

    return savedMessage;
  }
}
