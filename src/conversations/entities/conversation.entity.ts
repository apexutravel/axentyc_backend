import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type ConversationDocument = Conversation & Document;

export enum ConversationChannel {
  FACEBOOK = 'facebook',
  INSTAGRAM = 'instagram',
  WHATSAPP = 'whatsapp',
  TIKTOK = 'tiktok',
  EMAIL = 'email',
  WEB_CHAT = 'web_chat',
}

export enum ConversationStatus {
  OPEN = 'open',
  PENDING = 'pending',
  ASSIGNED = 'assigned',
  IN_PROGRESS = 'in_progress',
  CONVERTED = 'converted',
  RESOLVED = 'resolved',
  CLOSED = 'closed',
}

@Schema({ timestamps: true })
export class Conversation {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Contact', required: true })
  contactId: Types.ObjectId;

  @Prop({ type: String, enum: ConversationChannel, required: true })
  channel: ConversationChannel;

  @Prop({ type: String, enum: ConversationStatus, default: ConversationStatus.OPEN })
  status: ConversationStatus;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  assignedTo?: Types.ObjectId;

  @Prop({ type: String })
  subject?: string;

  @Prop({ type: String })
  lastMessage?: string;

  @Prop({ type: Date })
  lastMessageAt?: Date;

  @Prop({ type: Number, default: 0 })
  unreadCount: number;

  @Prop({ type: [String], default: [] })
  tags: string[];

  @Prop({ type: Object })
  metadata?: {
    externalId?: string;
    pageId?: string;
    threadId?: string;
    widgetId?: string;
    visitorId?: string;
  };

  @Prop({ type: Boolean, default: false })
  isBot: boolean;

  @Prop({ type: Number, default: 0 })
  priority: number;
}

export const ConversationSchema = SchemaFactory.createForClass(Conversation);

ConversationSchema.index({ tenantId: 1, status: 1 });
ConversationSchema.index({ tenantId: 1, channel: 1 });
ConversationSchema.index({ tenantId: 1, assignedTo: 1 });
ConversationSchema.index({ tenantId: 1, lastMessageAt: -1 });
ConversationSchema.index({ tenantId: 1, contactId: 1 });
