import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type LeadDocument = Lead & Document;

export enum LeadStatus {
  NEW = 'new',
  CONTACTED = 'contacted',
  QUALIFIED = 'qualified',
  UNQUALIFIED = 'unqualified',
  CONVERTED = 'converted',
  LOST = 'lost',
}

export enum LeadPriority {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  URGENT = 'urgent',
}

@Schema({ timestamps: true })
export class Lead {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Contact', required: true })
  contactId: Types.ObjectId;

  @Prop({ required: true })
  title: string;

  @Prop({ type: String })
  description?: string;

  @Prop({ type: String, enum: LeadStatus, default: LeadStatus.NEW })
  status: LeadStatus;

  @Prop({ type: String, enum: LeadPriority, default: LeadPriority.MEDIUM })
  priority: LeadPriority;

  @Prop({ type: Number, default: 0 })
  estimatedValue?: number;

  @Prop({ type: String })
  currency?: string;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  assignedTo?: Types.ObjectId;

  @Prop({ type: String })
  source?: string;

  @Prop({ type: [String], default: [] })
  tags: string[];

  @Prop({ type: Object })
  customFields?: Record<string, any>;

  @Prop({ type: Date })
  expectedCloseDate?: Date;

  @Prop({ type: Date })
  lastActivityAt?: Date;

  @Prop({ type: String })
  notes?: string;

  @Prop({ default: true })
  isActive: boolean;
}

export const LeadSchema = SchemaFactory.createForClass(Lead);

LeadSchema.index({ tenantId: 1, status: 1 });
LeadSchema.index({ tenantId: 1, assignedTo: 1 });
LeadSchema.index({ tenantId: 1, priority: 1 });
LeadSchema.index({ tenantId: 1, createdAt: -1 });
