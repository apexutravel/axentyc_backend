import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type EmailIntegrationDocument = EmailIntegration & Document;

@Schema({ timestamps: true })
export class EmailIntegration {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId: Types.ObjectId;

  @Prop({ type: Object, required: true })
  smtp: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    passEnc: string; // AES-GCM encrypted
    fromName?: string;
    fromAddress?: string;
  };

  @Prop({ type: Object, required: true })
  imap: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    passEnc: string; // AES-GCM encrypted
  };

  @Prop({ default: 'disconnected' })
  status: 'connected' | 'disconnected' | 'error';

  @Prop()
  lastTestAt?: Date;

  @Prop()
  connectedAt?: Date;

  @Prop({ type: String })
  lastError?: string | null;
}

export const EmailIntegrationSchema = SchemaFactory.createForClass(EmailIntegration);
