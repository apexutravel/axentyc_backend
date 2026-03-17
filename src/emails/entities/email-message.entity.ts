import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type EmailMessageDocument = EmailMessage & Document;

@Schema({ timestamps: true })
export class EmailMessage {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId: Types.ObjectId;

  @Prop({ required: true, index: true })
  messageId: string; // IMAP UID or Message-ID header

  @Prop({ required: true, index: true })
  folder: string; // INBOX, Sent, Drafts, Trash, etc.

  @Prop({ type: Object, required: true })
  from: {
    name?: string;
    address: string;
  };

  @Prop({ type: [Object], default: [] })
  to: Array<{
    name?: string;
    address: string;
  }>;

  @Prop({ type: [Object], default: [] })
  cc: Array<{
    name?: string;
    address: string;
  }>;

  @Prop({ type: [Object], default: [] })
  bcc: Array<{
    name?: string;
    address: string;
  }>;

  @Prop({ required: true })
  subject: string;

  @Prop({ type: String })
  textBody?: string;

  @Prop({ type: String })
  htmlBody?: string;

  @Prop({ type: [Object], default: [] })
  attachments: Array<{
    filename: string;
    contentType: string;
    size: number;
    contentId?: string;
    url?: string; // URL to download attachment
  }>;

  @Prop({ required: true })
  date: Date;

  @Prop({ default: false })
  isRead: boolean;

  @Prop({ default: false })
  isFlagged: boolean;

  @Prop({ default: false })
  isDraft: boolean;

  @Prop({ type: String })
  inReplyTo?: string;

  @Prop({ type: [String], default: [] })
  references: string[];

  @Prop({ type: String })
  threadId?: string;

  @Prop({ type: Object })
  headers?: Record<string, string>;

  @Prop({ type: Types.ObjectId, ref: 'Contact' })
  contactId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Lead' })
  leadId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Deal' })
  dealId?: Types.ObjectId;
}

export const EmailMessageSchema = SchemaFactory.createForClass(EmailMessage);

// Indexes for performance
EmailMessageSchema.index({ tenantId: 1, folder: 1, date: -1 });
EmailMessageSchema.index({ tenantId: 1, messageId: 1, folder: 1 }, { unique: true });
EmailMessageSchema.index({ tenantId: 1, threadId: 1 });
