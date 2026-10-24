import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type TaskDocument = Task & Document;

export enum TaskStatus {
  OPEN = 'open',
  DONE = 'done',
}

export enum TaskPriority {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
}

@Schema({ timestamps: true })
export class Task {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Workspace', index: true })
  workspaceId?: Types.ObjectId;

  @Prop({ required: true })
  title: string;

  @Prop({ type: String })
  description?: string;

  @Prop({ type: Date })
  dueAt?: Date;

  @Prop({ type: String, enum: TaskStatus, default: TaskStatus.OPEN })
  status: TaskStatus;

  @Prop({ type: String, enum: TaskPriority, default: TaskPriority.MEDIUM })
  priority: TaskPriority;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  assignedTo?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  createdBy?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Contact' })
  contactId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Lead' })
  leadId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Deal' })
  dealId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Conversation' })
  conversationId?: Types.ObjectId;

  @Prop({ type: Date })
  completedAt?: Date;

  /** Set once the "due soon / overdue" reminder was pushed, so it is only sent once */
  @Prop({ type: Date })
  remindedAt?: Date;

  @Prop({ type: String, default: 'manual' })
  source: 'manual' | 'automation';
}

export const TaskSchema = SchemaFactory.createForClass(Task);

TaskSchema.index({ tenantId: 1, workspaceId: 1, status: 1, dueAt: 1 });
TaskSchema.index({ tenantId: 1, assignedTo: 1, status: 1 });
TaskSchema.index({ tenantId: 1, contactId: 1 });
