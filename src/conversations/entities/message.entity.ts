import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type MessageDocument = Message & Document;

export enum MessageDirection {
  INBOUND = 'inbound',
  OUTBOUND = 'outbound',
}

export enum MessageType {
  TEXT = 'text',
  IMAGE = 'image',
  VIDEO = 'video',
  AUDIO = 'audio',
  FILE = 'file',
  LOCATION = 'location',
  TEMPLATE = 'template',
  INTERACTIVE = 'interactive',
}

export enum MessageStatus {
  SENT = 'sent',
  DELIVERED = 'delivered',
  READ = 'read',
  FAILED = 'failed',
  PENDING = 'pending',
}

@Schema({ timestamps: true })
export class Message {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Conversation', required: true, index: true })
  conversationId: Types.ObjectId;

  @Prop({ type: String, enum: MessageDirection, required: true })
  direction: MessageDirection;

  @Prop({ type: String, enum: MessageType, default: MessageType.TEXT })
  type: MessageType;

  @Prop({ type: String })
  content?: string;

  @Prop({ type: Object })
  media?: {
    url: string;
    mimeType?: string;
    fileName?: string;
    fileSize?: number;
    thumbnailUrl?: string;
  };

  @Prop({ type: String, enum: MessageStatus, default: MessageStatus.PENDING })
  status: MessageStatus;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  senderId?: Types.ObjectId;

  @Prop({ type: String })
  senderName?: string;

  @Prop({ type: Object })
  metadata?: {
    externalId?: string;
    platform?: string;
    replyTo?: string;
    widgetId?: string;
    visitorId?: string;
  };

  @Prop({ type: Boolean, default: false })
  isBot: boolean;
}

export const MessageSchema = SchemaFactory.createForClass(Message);

MessageSchema.index({ conversationId: 1, createdAt: -1 });
MessageSchema.index({ tenantId: 1, createdAt: -1 });
