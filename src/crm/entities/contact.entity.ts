import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type ContactDocument = Contact & Document;

export enum ContactSource {
  FACEBOOK = 'facebook',
  INSTAGRAM = 'instagram',
  WHATSAPP = 'whatsapp',
  TIKTOK = 'tiktok',
  WEB_CHAT = 'web_chat',
  MANUAL = 'manual',
  IMPORT = 'import',
}

@Schema({ timestamps: true })
export class Contact {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId: Types.ObjectId;

  @Prop({ required: true })
  name: string;

  @Prop({ type: String })
  email?: string;

  @Prop({ type: String })
  phone?: string;

  @Prop({ type: String })
  company?: string;

  @Prop({ type: String })
  avatar?: string;

  @Prop({ type: String, enum: ContactSource, default: ContactSource.MANUAL })
  source: ContactSource;

  @Prop({ type: Object })
  socialProfiles?: {
    facebook?: { id: string; username?: string };
    instagram?: { id: string; username?: string };
    whatsapp?: { phoneNumber: string };
    tiktok?: { id: string; username?: string };
  };

  @Prop({ type: [String], default: [] })
  tags: string[];

  @Prop({ type: Object })
  customFields?: Record<string, any>;

  @Prop({ type: String })
  notes?: string;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  assignedTo?: Types.ObjectId;

  @Prop({ type: Date })
  lastContactedAt?: Date;

  @Prop({ default: true })
  isActive: boolean;
}

export const ContactSchema = SchemaFactory.createForClass(Contact);

ContactSchema.index({ tenantId: 1, email: 1 });
ContactSchema.index({ tenantId: 1, phone: 1 });
ContactSchema.index({ tenantId: 1, tags: 1 });
ContactSchema.index({ tenantId: 1, source: 1 });
