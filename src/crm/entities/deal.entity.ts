import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type DealDocument = Deal & Document;

export enum DealStage {
  NEW_LEAD = 'new_lead',
  CONTACTED = 'contacted',
  PROPOSAL = 'proposal',
  NEGOTIATION = 'negotiation',
  CLOSED_WON = 'closed_won',
  CLOSED_LOST = 'closed_lost',
}

@Schema({ timestamps: true })
export class Deal {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Contact', required: true })
  contactId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Lead' })
  leadId?: Types.ObjectId;

  @Prop({ required: true })
  title: string;

  @Prop({ type: String })
  description?: string;

  @Prop({ type: String, enum: DealStage, default: DealStage.NEW_LEAD })
  stage: DealStage;

  @Prop({ type: Number, required: true })
  value: number;

  @Prop({ type: String, default: 'USD' })
  currency: string;

  @Prop({ type: Number, min: 0, max: 100, default: 0 })
  probability: number;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  assignedTo?: Types.ObjectId;

  @Prop({ type: Date })
  expectedCloseDate?: Date;

  @Prop({ type: Date })
  actualCloseDate?: Date;

  @Prop({ type: [String], default: [] })
  tags: string[];

  @Prop({ type: Object })
  customFields?: Record<string, any>;

  @Prop({ type: String })
  notes?: string;

  @Prop({ type: String })
  lostReason?: string;

  @Prop({ default: true })
  isActive: boolean;
}

export const DealSchema = SchemaFactory.createForClass(Deal);

DealSchema.index({ tenantId: 1, stage: 1 });
DealSchema.index({ tenantId: 1, assignedTo: 1 });
DealSchema.index({ tenantId: 1, value: -1 });
DealSchema.index({ tenantId: 1, expectedCloseDate: 1 });
