import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type FacebookConfigDocument = FacebookConfig & Document;

@Schema({ timestamps: true })
export class FacebookConfig {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, unique: true })
  tenantId: Types.ObjectId;

  @Prop({ required: true })
  appId: string;

  @Prop({ required: true })
  appSecret: string;

  @Prop({ default: 'cconehub_fb_verify' })
  verifyToken: string;

  @Prop({ default: true })
  isActive: boolean;

  @Prop({ type: Object })
  metadata?: Record<string, any>;
}

export const FacebookConfigSchema = SchemaFactory.createForClass(FacebookConfig);

// Index for fast tenant lookup
FacebookConfigSchema.index({ tenantId: 1 });
