import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type SocialAccountDocument = SocialAccount & Document;

export enum SocialPlatform {
  FACEBOOK = 'facebook',
  INSTAGRAM = 'instagram',
  WHATSAPP = 'whatsapp',
  TIKTOK = 'tiktok',
}

export enum SocialAccountStatus {
  CONNECTED = 'connected',
  DISCONNECTED = 'disconnected',
  EXPIRED = 'expired',
  ERROR = 'error',
}

export enum IntegrationProvider {
  META = 'meta',
  TIKTOK = 'tiktok',
}

export enum ConnectedAssetType {
  FACEBOOK_PAGE = 'facebook_page',
  INSTAGRAM_ACCOUNT = 'instagram_account',
  WHATSAPP_NUMBER = 'whatsapp_number',
  TIKTOK_ACCOUNT = 'tiktok_account',
}

export enum IntegrationCapability {
  MESSENGER = 'messenger',
  FACEBOOK_COMMENTS = 'facebook_comments',
  INSTAGRAM_DM = 'instagram_dm',
  INSTAGRAM_COMMENTS = 'instagram_comments',
  WHATSAPP_MESSAGES = 'whatsapp_messages',
}

@Schema({ timestamps: true })
export class SocialAccount {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Workspace', index: true })
  workspaceId?: Types.ObjectId;

  @Prop({ type: String, enum: SocialPlatform, required: true })
  platform: SocialPlatform;

  @Prop({ type: String, enum: IntegrationProvider })
  provider?: IntegrationProvider;

  @Prop({ type: String, enum: ConnectedAssetType })
  assetType?: ConnectedAssetType;

  @Prop({ type: [String], enum: IntegrationCapability, default: [] })
  capabilities?: IntegrationCapability[];

  @Prop({ required: true })
  accountName: string;

  @Prop({ type: String })
  accountId?: string;

  @Prop({ type: String })
  pageId?: string;

  @Prop({ type: String })
  accessToken?: string;

  @Prop({ type: String })
  refreshToken?: string;

  @Prop({ type: Date })
  tokenExpiresAt?: Date;

  @Prop({ type: String, enum: SocialAccountStatus, default: SocialAccountStatus.DISCONNECTED })
  status: SocialAccountStatus;

  @Prop({ type: String })
  webhookUrl?: string;

  @Prop({ type: String })
  webhookSecret?: string;

  @Prop({ type: Object })
  metadata?: Record<string, any>;

  @Prop({ default: true })
  isActive: boolean;
}

export const SocialAccountSchema = SchemaFactory.createForClass(SocialAccount);

SocialAccountSchema.index({ tenantId: 1, platform: 1 });
SocialAccountSchema.index({ tenantId: 1, workspaceId: 1 });
SocialAccountSchema.index({ pageId: 1 }); // For fast lookup when webhook arrives
