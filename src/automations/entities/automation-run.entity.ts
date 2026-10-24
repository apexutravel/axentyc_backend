import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type AutomationRunDocument = AutomationRun & Document;

export interface ActionResult {
  type: string;
  ok: boolean;
  /** Human readable outcome or failure reason */
  detail?: string;
}

@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class AutomationRun {
  @Prop({ type: Types.ObjectId, required: true, index: true })
  tenantId: Types.ObjectId;

  @Prop({ type: Types.ObjectId })
  workspaceId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Automation', required: true, index: true })
  automationId: Types.ObjectId;

  @Prop({ required: true })
  automationName: string;

  @Prop({ required: true })
  trigger: string;

  @Prop({ type: String, enum: ['success', 'partial', 'failed'], required: true })
  status: 'success' | 'partial' | 'failed';

  @Prop({ type: Types.ObjectId })
  conversationId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId })
  contactId?: Types.ObjectId;

  @Prop({ type: [Object], default: [] })
  results: ActionResult[];

  @Prop({ type: Number, default: 0 })
  durationMs: number;
}

export const AutomationRunSchema = SchemaFactory.createForClass(AutomationRun);

AutomationRunSchema.index({ tenantId: 1, workspaceId: 1, createdAt: -1 });
AutomationRunSchema.index({ automationId: 1, conversationId: 1, createdAt: -1 });
// keep the log small: runs are only useful for a while
AutomationRunSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });
