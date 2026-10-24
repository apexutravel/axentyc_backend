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
    /** Stripe price currently billed */
    providerPriceId?: string;
    /** Set when the first failed payment happened; drives the grace period */
    pastDueSince?: Date;
    /** Paid plan granted without payment (legacy / courtesy). Never expires nor locks. */
    complimentary?: boolean;
  };

  /** Billing e-mail notices already sent, keyed to avoid duplicates (e.g. trial_3d:2026-07-14) */
  @Prop({ type: Object })
  billingNotices?: Record<string, Date>;

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
  limits?: Record<string, number>;

  @Prop({ default: true })
  isActive: boolean;
}

export const TenantSchema = SchemaFactory.createForClass(Tenant);

TenantSchema.index({ status: 1 });
