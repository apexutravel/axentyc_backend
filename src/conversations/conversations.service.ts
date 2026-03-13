import {
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Conversation, ConversationDocument, ConversationStatus } from './entities/conversation.entity';
import { Message, MessageDocument, MessageDirection, MessageStatus } from './entities/message.entity';
import { CreateConversationDto } from './dto/create-conversation.dto';
import { UpdateConversationDto } from './dto/update-conversation.dto';
import { SendMessageDto } from './dto/send-message.dto';
import { Contact, ContactDocument, ContactSource } from '../crm/entities/contact.entity';
import { EventsGateway } from '../events/events.gateway';

@Injectable()
export class ConversationsService {
  constructor(
    @InjectModel(Conversation.name)
    private conversationModel: Model<ConversationDocument>,
    @InjectModel(Message.name)
    private messageModel: Model<MessageDocument>,
    @InjectModel(Contact.name)
    private contactModel: Model<ContactDocument>,
    private eventsGateway: EventsGateway,
  ) {}

  async create(tenantId: string, dto: CreateConversationDto): Promise<Conversation> {
    const conversation = new this.conversationModel({
      ...dto,
      tenantId: new Types.ObjectId(tenantId),
      contactId: new Types.ObjectId(dto.contactId),
      assignedTo: dto.assignedTo ? new Types.ObjectId(dto.assignedTo) : undefined,
    });
    return conversation.save();
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
        this.eventsGateway.emitWidgetMessage(
          conv.metadata.widgetId,
          conv.metadata.visitorId,
          savedMessage,
        );
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
      .exec();
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
      type: 'text',
      content: messageData.content,
      senderName: messageData.senderName,
      senderId: messageData.senderId ? new Types.ObjectId(messageData.senderId) : undefined,
      status: messageData.direction === MessageDirection.INBOUND ? MessageStatus.DELIVERED : MessageStatus.SENT,
      metadata: messageData.metadata,
    });

    const savedMessage = await message.save();

    await this.conversationModel.findByIdAndUpdate(conversationId, {
      lastMessage: messageData.content,
      lastMessageAt: new Date(),
      $inc: { unreadCount: messageData.direction === MessageDirection.INBOUND ? 1 : 0 },
    });

    return savedMessage;
  }
}
