import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type AutomationDocument = Automation & Document;

export enum AutomationTrigger {
  MESSAGE_RECEIVED = 'message.received',
  LEAD_CREATED = 'lead.created',
  DEAL_UPDATED = 'deal.updated',
  DEAL_STAGE_CHANGED = 'deal.stage_changed',
  CONTACT_CREATED = 'contact.created',
  CONVERSATION_CREATED = 'conversation.created',
  INVOICE_PAID = 'invoice.paid',
}

export enum AutomationAction {
  AUTO_REPLY = 'auto_reply',
  ASSIGN_AGENT = 'assign_agent',
  CREATE_TASK = 'create_task',
  SEND_NOTIFICATION = 'send_notification',
  ADD_TAG = 'add_tag',
  UPDATE_STATUS = 'update_status',
  CREATE_LEAD = 'create_lead',
  CREATE_DEAL = 'create_deal',
  SEND_WEBHOOK = 'send_webhook',
}

@Schema({ timestamps: true })
export class Automation {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId: Types.ObjectId;

  @Prop({ required: true })
  name: string;

  @Prop({ type: String })
  description?: string;

  @Prop({ type: String, enum: AutomationTrigger, required: true })
  trigger: AutomationTrigger;

  @Prop({ type: Object })
  conditions?: {
    channel?: string;
    tags?: string[];
    keywords?: string[];
    status?: string;
    stage?: string;
  };

  @Prop({
    type: [
      {
        type: { type: String, enum: AutomationAction },
        config: { type: Object },
      },
    ],
    required: true,
  })
  actions: {
    type: AutomationAction;
    config: Record<string, any>;
  }[];

  @Prop({ default: true })
  isActive: boolean;

  @Prop({ type: Number, default: 0 })
  executionCount: number;

  @Prop({ type: Date })
  lastExecutedAt?: Date;
}

export const AutomationSchema = SchemaFactory.createForClass(Automation);

AutomationSchema.index({ tenantId: 1, trigger: 1, isActive: 1 });
