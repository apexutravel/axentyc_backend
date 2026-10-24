import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type QuickReplyDocument = QuickReply & Document;

@Schema({ timestamps: true })
export class QuickReply {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Workspace', index: true })
  workspaceId?: Types.ObjectId;

  /** Short handle typed after "/" in the chat, lowercase, no spaces */
  @Prop({ required: true })
  shortcut: string;

  @Prop({ required: true })
  body: string;
}

export const QuickReplySchema = SchemaFactory.createForClass(QuickReply);

QuickReplySchema.index({ tenantId: 1, workspaceId: 1, shortcut: 1 }, { unique: true });
