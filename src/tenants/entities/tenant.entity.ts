import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type TenantDocument = Tenant & Document;

export enum TenantPlan {
  FREE = 'free',
  STARTER = 'starter',
  PRO = 'pro',
  PROFESSIONAL = 'professional',
  AGENCY = 'agency',
  BUSINESS = 'business',
  ENTERPRISE = 'enterprise',
}

export enum TenantStatus {
  ACTIVE = 'active',
  SUSPENDED = 'suspended',
  TRIAL = 'trial',
  CANCELLED = 'cancelled',
  PAST_DUE = 'past_due',
  LOCKED = 'locked',
}

export enum SubscriptionStatus {
  TRIALING = 'trialing',
  ACTIVE = 'active',
  PAST_DUE = 'past_due',
  CANCELED = 'canceled',
  UNPAID = 'unpaid',
  PAUSED = 'paused',
}

@Schema({ timestamps: true })
export class Tenant {
  @Prop({ required: true, unique: true })
  name: string;

  @Prop({ required: true, unique: true })
  slug: string;

  @Prop({ type: String })
  logo?: string;

  @Prop({ type: String, enum: TenantPlan, default: TenantPlan.FREE })
  plan: TenantPlan;

  @Prop({ type: String, enum: TenantStatus, default: TenantStatus.TRIAL })
  status: TenantStatus;

  @Prop({ type: Date })
  trialEndsAt?: Date;

  @Prop({ type: Object })
  subscription?: {
    planKey: string;
    status: SubscriptionStatus;
    billingCycle?: 'monthly' | 'yearly';
    currentPeriodStart?: Date;
    currentPeriodEnd?: Date;
    cancelAtPeriodEnd?: boolean;
    canceledAt?: Date;
    provider?: 'manual' | 'stripe';
    providerCustomerId?: string;
    providerSubscriptionId?: string;
  };

  @Prop({ type: Object })
  settings?: {
    timezone?: string;
    language?: string;
    currency?: string;
    businessHours?: {
      enabled: boolean;
      schedule: Record<string, { start: string; end: string }>;
    };
  };

  @Prop({ type: Object })
  integrations?: {
    facebook?: { enabled: boolean; pageId?: string; accessToken?: string };
    instagram?: { enabled: boolean; accountId?: string; accessToken?: string };
    whatsapp?: { enabled: boolean; phoneNumberId?: string; accessToken?: string };
    tiktok?: { enabled: boolean; accountId?: string; accessToken?: string };
  };

  @Prop({ type: Object })
  limits?: {
    maxUsers?: number;
    maxWorkspaces?: number;
    maxConnectedAssets?: number;
    maxSocialAccounts?: number;
    maxEmailIntegrations?: number;
    maxWidgets?: number;
    maxConversations?: number;
    maxLeads?: number;
    automationsEnabled?: boolean;
    teamRolesEnabled?: boolean;
    whiteLabelEnabled?: boolean;
  };

  @Prop({ default: true })
  isActive: boolean;
}

export const TenantSchema = SchemaFactory.createForClass(Tenant);

TenantSchema.index({ status: 1 });
