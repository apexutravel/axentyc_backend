import { BadRequestException, ConflictException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Tenant, TenantDocument, SubscriptionStatus, TenantStatus } from '../tenants/entities/tenant.entity';
import { BillingService } from './billing.service';
import { StripeClient } from './stripe.client';
import {
  BillingCycle,
  PlanDefinition,
  getPlanDefinition,
  isKnownPlan,
  normalizePlanKey,
  periodAmountCents,
} from './plans';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Stripe Checkout rejects a trial_end closer than ~48h; below that we simply charge at checkout. */
const MIN_TRIAL_REMAINING_MS = 49 * 60 * 60 * 1000;

export type ChangePlanResult =
  | { action: 'checkout'; url: string }
  | { action: 'updated'; message: string }
  | { action: 'scheduled_cancel'; message: string };

@Injectable()
export class BillingPaymentsService {
  private readonly logger = new Logger(BillingPaymentsService.name);
  private readonly priceCache = new Map<string, string>();

  constructor(
    @InjectModel(Tenant.name) private tenantModel: Model<TenantDocument>,
    private readonly billing: BillingService,
    private readonly stripe: StripeClient,
    private readonly config: ConfigService,
  ) {}

  // ─── Capabilities ───────────────────────────────────────────────────────────────

  get currency(): string {
    return (this.config.get<string>('BILLING_CURRENCY') || 'usd').toLowerCase();
  }

  private get frontendUrl(): string {
    const raw = this.config.get<string>('FRONTEND_URL') || this.config.get<string>('CORS_ORIGIN') || 'http://localhost:3000';
    return raw.replace(/\/+$/, '');
  }

  /**
   * Plans can only be activated for free outside production when no payment provider is set up.
   * In production an unconfigured provider means "payments unavailable", never "everything is free".
   */
  get devSelfActivation(): boolean {
    return !this.stripe.isConfigured && this.config.get<string>('NODE_ENV') !== 'production';
  }

  getPaymentConfig() {
    return {
      provider: this.stripe.isConfigured ? 'stripe' : 'none',
      paymentsEnabled: this.stripe.isConfigured,
      devSelfActivation: this.devSelfActivation,
      currency: this.currency.toUpperCase(),
    };
  }

  // ─── Stripe objects ─────────────────────────────────────────────────────────────

  private async loadTenant(tenantId: string): Promise<TenantDocument> {
    const tenant = await this.tenantModel.findById(tenantId);
    if (!tenant) throw new BadRequestException('Tenant not found');
    return tenant;
  }

  private async ensureCustomer(tenant: TenantDocument, email?: string): Promise<string> {
    const existing = tenant.subscription?.providerCustomerId;
    if (existing) return existing;

    const customer = await this.stripe.request<{ id: string }>('POST', '/customers', {
      name: tenant.name,
      email,
      metadata: { tenantId: String(tenant._id) },
    });
    tenant.subscription = { ...(tenant.subscription as any), providerCustomerId: customer.id };
    tenant.markModified('subscription');
    await tenant.save();
    return customer.id;
  }

  /** Price objects are created lazily and found again by lookup_key, so no Stripe dashboard setup is needed. */
  private async ensurePrice(plan: PlanDefinition, cycle: BillingCycle): Promise<string> {
    const amount = periodAmountCents(plan, cycle);
    const lookupKey = `axentyc_${plan.key}_${cycle}_${this.currency}_${amount}`;

    const cached = this.priceCache.get(lookupKey);
    if (cached) return cached;

    const found = await this.stripe.request<{ data: { id: string }[] }>('GET', '/prices', {
      lookup_keys: [lookupKey],
      active: true,
      limit: 1,
    });
    if (found.data[0]) {
      this.priceCache.set(lookupKey, found.data[0].id);
      return found.data[0].id;
    }

    const created = await this.stripe.request<{ id: string }>('POST', '/prices', {
      currency: this.currency,
      unit_amount: amount,
      recurring: { interval: cycle === 'yearly' ? 'year' : 'month' },
      lookup_key: lookupKey,
      product_data: { name: `AXENTYC ${plan.name}`, metadata: { planKey: plan.key } },
      metadata: { planKey: plan.key, cycle },
    });
    this.priceCache.set(lookupKey, created.id);
    return created.id;
  }

  // ─── Public flows ───────────────────────────────────────────────────────────────

  /**
   * Customer picks a plan. Returns where to go next:
   *  - checkout: new paid subscription (Stripe Checkout, card is collected there)
   *  - updated: existing paid subscription moved to another price (prorated)
   *  - scheduled_cancel: choosing Free keeps the paid plan until the period ends
   */
  async changePlan(
    tenantId: string,
    user: { email?: string },
    planKey: string,
    billingCycle: BillingCycle = 'monthly',
  ): Promise<ChangePlanResult> {
    if (!isKnownPlan(planKey)) throw new BadRequestException('Plan desconocido');
    const plan = getPlanDefinition(planKey);
    const cycle: BillingCycle = billingCycle === 'yearly' ? 'yearly' : 'monthly';

    const tenant = await this.loadTenant(tenantId);
    const currentPlan = this.billing.planOf(tenant);
    const subId = tenant.subscription?.providerSubscriptionId;
    const sameSelection = currentPlan.key === plan.key && (tenant.subscription?.billingCycle || 'monthly') === cycle;

    // Never leave the account with more than the new plan allows
    const isDowngrade = plan.limits.maxConnectedAssets < currentPlan.limits.maxConnectedAssets || plan.monthlyPrice < currentPlan.monthlyPrice;
    if (isDowngrade) {
      const conflicts = await this.billing.findDowngradeConflicts(tenantId, plan);
      if (conflicts.length > 0) {
        const detail = conflicts.map((c) => `${c.used} ${c.label} (el plan ${plan.name} permite ${c.limit})`).join(', ');
        throw new ConflictException({
          message: `No puedes cambiar al plan ${plan.name} todavía. Reduce primero: ${detail}.`,
          code: 'DOWNGRADE_BLOCKED',
          details: conflicts,
        });
      }
    }

    // Free: nothing to charge
    if (plan.monthlyPrice === 0) {
      if (subId) {
        await this.stripe.request('POST', `/subscriptions/${subId}`, { cancel_at_period_end: true });
        await this.refreshFromStripe(tenantId);
        return { action: 'scheduled_cancel', message: 'Pasarás al plan Free al terminar tu período actual.' };
      }
      await this.applyLocalPlan(tenant, plan, cycle, { status: SubscriptionStatus.ACTIVE });
      return { action: 'updated', message: 'Plan Free activado.' };
    }

    // Paid plan, but payments are not configured
    if (!this.stripe.isConfigured) {
      if (this.devSelfActivation) {
        // Development convenience only (never in production): no money involved
        await this.applyLocalPlan(tenant, plan, cycle, { status: SubscriptionStatus.ACTIVE });
        return { action: 'updated', message: `Plan ${plan.name} activado (modo desarrollo, sin cobro).` };
      }
      throw new ServiceUnavailableException('Los pagos no están disponibles todavía. Contacta a soporte para activar tu plan.');
    }

    // Existing paid subscription: switch price with proration
    if (subId && !sameSelection) {
      const sub = await this.stripe.request<any>('GET', `/subscriptions/${subId}`);
      const itemId = sub.items?.data?.[0]?.id;
      const priceId = await this.ensurePrice(plan, cycle);
      await this.stripe.request('POST', `/subscriptions/${subId}`, {
        items: [{ id: itemId, price: priceId }],
        proration_behavior: 'create_prorations',
        cancel_at_period_end: false,
        metadata: { tenantId, planKey: plan.key, cycle },
      });
      await this.refreshFromStripe(tenantId);
      return { action: 'updated', message: `Plan cambiado a ${plan.name}.` };
    }
    if (subId && sameSelection) {
      throw new ConflictException('Ya estás en este plan.');
    }

    return { action: 'checkout', url: await this.createCheckoutUrl(tenant, user.email, plan, cycle) };
  }

  /** Starts (or restarts) a paid subscription. The free trial that is still running is honoured. */
  private async createCheckoutUrl(tenant: TenantDocument, email: string | undefined, plan: PlanDefinition, cycle: BillingCycle) {
    const customerId = await this.ensureCustomer(tenant, email);
    const priceId = await this.ensurePrice(plan, cycle);
    const tenantId = String(tenant._id);

    const access = this.billing.computeAccess(tenant);
    const remaining = access.trialEndsAt ? access.trialEndsAt.getTime() - Date.now() : 0;
    const keepTrial = access.state === 'trialing' && remaining >= MIN_TRIAL_REMAINING_MS;

    const session = await this.stripe.request<{ url: string }>('POST', '/checkout/sessions', {
      mode: 'subscription',
      customer: customerId,
      client_reference_id: tenantId,
      line_items: [{ price: priceId, quantity: 1 }],
      allow_promotion_codes: true,
      billing_address_collection: 'auto',
      success_url: `${this.frontendUrl}/account?tab=billing&checkout=success`,
      cancel_url: `${this.frontendUrl}/account?tab=billing&checkout=cancelled`,
      subscription_data: {
        metadata: { tenantId, planKey: plan.key, cycle },
        ...(keepTrial ? { trial_end: Math.floor((Date.now() + remaining) / 1000) } : {}),
      },
    });
    return session.url;
  }

  async createPortalUrl(tenantId: string): Promise<string> {
    const tenant = await this.loadTenant(tenantId);
    const customerId = tenant.subscription?.providerCustomerId;
    if (!customerId) throw new BadRequestException('Aún no tienes un método de pago registrado.');
    const session = await this.stripe.request<{ url: string }>('POST', '/billing_portal/sessions', {
      customer: customerId,
      return_url: `${this.frontendUrl}/account?tab=billing`,
    });
    return session.url;
  }

  async cancelAtPeriodEnd(tenantId: string) {
    const tenant = await this.loadTenant(tenantId);
    const subId = tenant.subscription?.providerSubscriptionId;
    if (subId) {
      await this.stripe.request('POST', `/subscriptions/${subId}`, { cancel_at_period_end: true });
      await this.refreshFromStripe(tenantId);
    } else {
      // Trial (or dev plan) without a payment method: nothing to bill, drop to Free
      const free = getPlanDefinition('free');
      const conflicts = await this.billing.findDowngradeConflicts(tenantId, free);
      if (conflicts.length > 0) {
        throw new ConflictException({
          message: `Reduce primero: ${conflicts.map((c) => `${c.used} ${c.label} (Free permite ${c.limit})`).join(', ')}.`,
          code: 'DOWNGRADE_BLOCKED',
          details: conflicts,
        });
      }
      await this.applyLocalPlan(tenant, free, 'monthly', { status: SubscriptionStatus.ACTIVE });
    }
    return this.billing.getTenantSubscription(tenantId);
  }

  async reactivate(tenantId: string) {
    const tenant = await this.loadTenant(tenantId);
    const subId = tenant.subscription?.providerSubscriptionId;
    if (!subId) throw new BadRequestException('No hay una suscripción para reactivar. Elige un plan para comenzar.');
    await this.stripe.request('POST', `/subscriptions/${subId}`, { cancel_at_period_end: false });
    await this.refreshFromStripe(tenantId);
    return this.billing.getTenantSubscription(tenantId);
  }

  // ─── Local state helpers ────────────────────────────────────────────────────────

  private async applyLocalPlan(
    tenant: TenantDocument,
    plan: PlanDefinition,
    cycle: BillingCycle,
    opts: { status: SubscriptionStatus },
  ) {
    const now = new Date();
    tenant.plan = this.billing.mapPlanKeyToTenantPlan(plan.key);
    tenant.status = TenantStatus.ACTIVE;
    tenant.isActive = true;
    tenant.limits = { ...plan.limits };
    tenant.subscription = {
      planKey: plan.key,
      status: opts.status,
      billingCycle: cycle,
      currentPeriodStart: now,
      currentPeriodEnd: new Date(now.getTime() + (cycle === 'yearly' ? 365 : 30) * DAY_MS),
      cancelAtPeriodEnd: false,
      provider: 'manual',
    };
    tenant.markModified('subscription');
    await tenant.save();
  }

  async refreshFromStripe(tenantId: string) {
    const tenant = await this.loadTenant(tenantId);
    const subId = tenant.subscription?.providerSubscriptionId;
    if (!subId) return;
    const sub = await this.stripe.request<any>('GET', `/subscriptions/${subId}`);
    await this.syncSubscription(sub, tenantId);
  }

  // ─── Webhooks ───────────────────────────────────────────────────────────────────

  async handleStripeEvent(event: { id: string; type: string; data: { object: any } }) {
    const obj = event.data.object;
    this.logger.log(`Stripe event ${event.type} (${event.id})`);

    switch (event.type) {
      case 'checkout.session.completed': {
        if (obj.mode !== 'subscription' || !obj.subscription) return;
        const sub = await this.stripe.request<any>('GET', `/subscriptions/${obj.subscription}`);
        await this.syncSubscription(sub, obj.client_reference_id || sub.metadata?.tenantId);
        return;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        await this.syncSubscription(obj);
        return;
      case 'invoice.payment_failed': {
        const tenant = await this.findTenantByStripe(obj.subscription, obj.customer);
        if (!tenant) return;
        const sub: any = { ...(tenant.subscription as any) };
        if (!sub.pastDueSince) sub.pastDueSince = new Date();
        sub.status = SubscriptionStatus.PAST_DUE;
        tenant.subscription = sub;
        tenant.status = TenantStatus.PAST_DUE;
        tenant.markModified('subscription');
        await tenant.save();
        return;
      }
      default:
        return;
    }
  }

  private async findTenantByStripe(subscriptionId?: string, customerId?: string, tenantId?: string) {
    if (tenantId) {
      const byId = await this.tenantModel.findById(tenantId).catch(() => null);
      if (byId) return byId;
    }
    if (subscriptionId) {
      const bySub = await this.tenantModel.findOne({ 'subscription.providerSubscriptionId': subscriptionId });
      if (bySub) return bySub;
    }
    if (customerId) return this.tenantModel.findOne({ 'subscription.providerCustomerId': customerId });
    return null;
  }

  /** The Stripe subscription is the source of truth: applying it twice yields the same state (idempotent). */
  async syncSubscription(sub: any, tenantIdHint?: string) {
    const tenant = await this.findTenantByStripe(sub.id, typeof sub.customer === 'string' ? sub.customer : sub.customer?.id, tenantIdHint || sub.metadata?.tenantId);
    if (!tenant) {
      this.logger.warn(`Stripe subscription ${sub.id} does not match any tenant`);
      return;
    }

    const item = sub.items?.data?.[0];
    const price = item?.price;
    const cycle: BillingCycle = price?.recurring?.interval === 'year' ? 'yearly' : 'monthly';
    const planKey = normalizePlanKey(price?.metadata?.planKey || sub.metadata?.planKey || tenant.subscription?.planKey);

    const toDate = (seconds?: number) => (seconds ? new Date(seconds * 1000) : undefined);
    // Newer Stripe API versions moved the period to the subscription item
    const periodStart = toDate(sub.current_period_start ?? item?.current_period_start);
    const periodEnd = toDate(sub.current_period_end ?? item?.current_period_end);

    const ended = sub.status === 'canceled';
    const statusMap: Record<string, SubscriptionStatus> = {
      trialing: SubscriptionStatus.TRIALING,
      active: SubscriptionStatus.ACTIVE,
      past_due: SubscriptionStatus.PAST_DUE,
      unpaid: SubscriptionStatus.UNPAID,
      paused: SubscriptionStatus.PAUSED,
      canceled: SubscriptionStatus.CANCELED,
    };
    const status = statusMap[sub.status];
    if (!status) return; // incomplete / incomplete_expired: nothing to apply yet

    // A finished subscription returns the account to Free
    const plan = ended ? getPlanDefinition('free') : getPlanDefinition(planKey);
    const previous: any = tenant.subscription || {};

    tenant.plan = this.billing.mapPlanKeyToTenantPlan(plan.key);
    tenant.limits = { ...plan.limits };
    tenant.isActive = true;
    tenant.status =
      ended || status === SubscriptionStatus.ACTIVE
        ? TenantStatus.ACTIVE
        : status === SubscriptionStatus.TRIALING
          ? TenantStatus.TRIAL
          : status === SubscriptionStatus.PAST_DUE
            ? TenantStatus.PAST_DUE
            : TenantStatus.LOCKED;
    if (sub.trial_end) tenant.trialEndsAt = toDate(sub.trial_end);

    tenant.subscription = {
      ...previous,
      planKey: plan.key,
      status: ended ? SubscriptionStatus.ACTIVE : status,
      billingCycle: cycle,
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: ended ? false : !!sub.cancel_at_period_end,
      canceledAt: sub.canceled_at ? toDate(sub.canceled_at) : undefined,
      provider: 'stripe',
      providerCustomerId: typeof sub.customer === 'string' ? sub.customer : sub.customer?.id || previous.providerCustomerId,
      providerSubscriptionId: ended ? undefined : sub.id,
      providerPriceId: ended ? undefined : price?.id,
      pastDueSince: status === SubscriptionStatus.PAST_DUE ? previous.pastDueSince || new Date() : undefined,
      complimentary: false,
    };
    tenant.markModified('subscription');
    await tenant.save();
  }
}
