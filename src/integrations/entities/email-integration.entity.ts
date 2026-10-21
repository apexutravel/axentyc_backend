import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type EmailIntegrationDocument = EmailIntegration & Document;

@Schema({ timestamps: true })
export class EmailIntegration {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Workspace', index: true })
  workspaceId?: Types.ObjectId;

  // Friendly name shown in the UI (e.g. "Ventas", "Soporte")
  @Prop({ type: String })
  label?: string;

  // Normalized (lowercase) identity of the mailbox. Unique per tenant.
  @Prop({ type: String, index: true })
  emailAddress?: string;

  // Default sender / default inbox for its tenant + workspace scope
  @Prop({ type: Boolean, default: false })
  isDefault: boolean;

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

  @Prop()
  lastSyncAt?: Date;

  @Prop({ type: String })
  lastError?: string | null;
}

export const EmailIntegrationSchema = SchemaFactory.createForClass(EmailIntegration);

EmailIntegrationSchema.index({ tenantId: 1, workspaceId: 1 });
EmailIntegrationSchema.index({ tenantId: 1, emailAddress: 1 });
