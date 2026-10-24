import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { createHmac } from 'crypto';
import { BillingService, PlanLimitException, PaymentRequiredException } from './billing.service';
import { BillingPaymentsService } from './billing-payments.service';
import { BillingNoticesService } from './billing-notices.service';
import { SubscriptionGuard, PlanFeatureGuard } from './billing.guards';
import { encodeForm, verifyStripeSignature } from './stripe.client';
import { PLAN_DEFINITIONS, getPlanDefinition, periodAmountCents, UNLIMITED } from './plans';

const DAY = 24 * 60 * 60 * 1000;
const now = new Date('2026-10-22T12:00:00Z');
const inDays = (n: number) => new Date(now.getTime() + n * DAY);

const tenant = (planKey: string, sub: Record<string, any> = {}, extra: Record<string, any> = {}) => ({
  isActive: true,
  status: 'active',
  plan: planKey,
  subscription: { planKey, ...sub },
  ...extra,
});

const svc = () => new (BillingService as any)(...Array(9).fill({})) as BillingService;

describe('plans catalog', () => {
  it('every plan advertises only what it enforces (highlights come from limits/features)', () => {
    const pro = getPlanDefinition('pro');
    expect(pro.highlights).toContain('Pipeline de deals');
    expect(pro.highlights).toContain('25 automatizaciones');
    const starter = getPlanDefinition('starter');
    expect(starter.highlights.join(' ')).not.toMatch(/deals|Roles|marca/i);
    expect(getPlanDefinition('free').highlights.join(' ')).not.toMatch(/automatizaci/i);
    expect(getPlanDefinition('agency').highlights).toContain('Automatizaciones ilimitadas');
  });

  it('limits grow with the price', () => {
    const paid = PLAN_DEFINITIONS;
    for (let i = 1; i < paid.length; i++) {
      expect(paid[i].monthlyPrice).toBeGreaterThan(paid[i - 1].monthlyPrice);
      expect(paid[i].limits.maxConnectedAssets).toBeGreaterThan(paid[i - 1].limits.maxConnectedAssets);
      expect(paid[i].limits.maxUsers).toBeGreaterThan(paid[i - 1].limits.maxUsers);
    }
  });

  it('maps legacy keys and charges yearly plans once a year', () => {
    expect(getPlanDefinition('business').key).toBe('agency');
    expect(getPlanDefinition('professional').key).toBe('pro');
    expect(periodAmountCents(getPlanDefinition('pro'), 'monthly')).toBe(7900);
    expect(periodAmountCents(getPlanDefinition('pro'), 'yearly')).toBe(63 * 12 * 100);
  });
});

describe('access state', () => {
  const b = svc();

  it('free never expires', () => {
    expect(b.computeAccess(tenant('free', { status: 'active' }), now)).toMatchObject({ state: 'free', readOnly: false });
  });

  it('a running trial is writable and counts days', () => {
    const a = b.computeAccess(tenant('pro', { status: 'trialing' }, { trialEndsAt: inDays(3) }), now);
    expect(a).toMatchObject({ state: 'trialing', readOnly: false, trialDaysLeft: 3 });
  });

  it('an expired trial is read-only and asks for payment', () => {
    const a = b.computeAccess(tenant('pro', { status: 'trialing' }, { trialEndsAt: inDays(-1) }), now);
    expect(a).toMatchObject({ state: 'trial_expired', readOnly: true, paymentRequired: true });
  });

  it('a paid active subscription is writable; cancelled-at-period-end keeps access until the end', () => {
    const end = inDays(10);
    const a = b.computeAccess(tenant('pro', { status: 'active', cancelAtPeriodEnd: true, currentPeriodEnd: end }), now);
    expect(a).toMatchObject({ state: 'active', readOnly: false });
    expect(a.endsAt).toEqual(end);
  });

  it('failed payment: full access during the grace period, read-only afterwards', () => {
    expect(b.computeAccess(tenant('pro', { status: 'past_due', pastDueSince: inDays(-1) }), now).readOnly).toBe(false);
    expect(b.computeAccess(tenant('pro', { status: 'past_due', pastDueSince: inDays(-4) }), now).readOnly).toBe(true);
  });

  it('unpaid, canceled and locked tenants are read-only', () => {
    expect(b.computeAccess(tenant('pro', { status: 'unpaid' }), now).readOnly).toBe(true);
    expect(b.computeAccess(tenant('pro', { status: 'canceled' }), now).readOnly).toBe(true);
    expect(b.computeAccess(tenant('pro', { status: 'active' }, { status: 'locked' }), now).readOnly).toBe(true);
  });

  it('courtesy (complimentary) accounts never lock', () => {
    expect(b.computeAccess(tenant('pro', { status: 'trialing', complimentary: true }, { trialEndsAt: inDays(-90) }), now).readOnly).toBe(false);
  });
});

describe('limits', () => {
  const b: any = svc();
  const starter = getPlanDefinition('starter');
  const agency = getPlanDefinition('agency');

  it('blocks going past the cap with a machine readable error', () => {
    expect(() => b.assertWithin(starter, 'maxConnectedAssets', 3)).toThrow(PlanLimitException);
    expect(() => b.assertWithin(starter, 'maxConnectedAssets', 2)).not.toThrow();
    expect(() => b.assertWithin(starter, 'maxConnectedAssets', 2, 2)).toThrow(PlanLimitException);
  });

  it('a limit of 0 means the plan does not include the feature', () => {
    try { b.assertWithin(getPlanDefinition('free'), 'maxAutomations', 0); } catch (e: any) {
      expect(e.getResponse().code).toBe('PLAN_LIMIT_REACHED');
      expect(e.getResponse().message).toMatch(/no incluye/);
      return;
    }
    throw new Error('should have thrown');
  });

  it('-1 is unlimited', () => {
    expect(agency.limits.maxAutomations).toBe(UNLIMITED);
    expect(() => b.assertWithin(agency, 'maxAutomations', 99999)).not.toThrow();
  });

  it('feature gates follow the plan', async () => {
    const make = (planKey: string) => {
      const s: any = svc();
      s.tenantModel = { findById: () => ({ lean: () => Promise.resolve(tenant(planKey)) }) };
      return s as BillingService;
    };
    await expect(make('starter').assertFeature('t', 'deals')).rejects.toBeInstanceOf(PlanLimitException);
    await expect(make('pro').assertFeature('t', 'deals')).resolves.toBeUndefined();
    await expect(make('starter').assertRoleAllowed('t', 'manager')).rejects.toBeInstanceOf(PlanLimitException);
    await expect(make('starter').assertRoleAllowed('t', 'agent')).resolves.toBeUndefined();
    await expect(make('pro').assertRoleAllowed('t', 'viewer')).resolves.toBeUndefined();
  });

  it('write operations are refused with 402 once the trial is over', async () => {
    const s: any = svc();
    s.tenantModel = { findById: () => ({ lean: () => Promise.resolve(tenant('pro', { status: 'trialing' }, { trialEndsAt: inDays(-2) })) }) };
    await expect(s.assertTenantCanWrite('t')).rejects.toBeInstanceOf(PaymentRequiredException);
    await expect(s.assertCanAddConnectedAssets('t')).rejects.toBeInstanceOf(PaymentRequiredException);
  });

  it('downgrades are blocked while usage does not fit', async () => {
    const s: any = svc();
    s.getUsage = jest.fn().mockResolvedValue({
      users: 5, workspaces: 1, connectedAssets: { total: 8 }, automations: 2, conversationsThisMonth: 9999,
    });
    const conflicts = await s.findDowngradeConflicts('t', starter);
    expect(conflicts.map((c: any) => c.key).sort()).toEqual(['maxConnectedAssets', 'maxUsers']);
    // monthly counter never blocks a downgrade
    expect(conflicts.some((c: any) => c.key === 'maxConversationsMonthly')).toBe(false);
  });
});

describe('Stripe helpers', () => {
  const secret = 'whsec_test';
  const body = Buffer.from(JSON.stringify({ id: 'evt_1', type: 'x' }));
  const sign = (ts: number, s = secret) => `t=${ts},v1=${createHmac('sha256', s).update(`${ts}.${body.toString()}`).digest('hex')}`;
  const nowS = 1_800_000_000;

  it('accepts a valid signature', () => {
    expect(() => verifyStripeSignature(body, sign(nowS), secret, nowS)).not.toThrow();
  });
  it('rejects wrong secret, tampered body, old timestamp and missing header', () => {
    expect(() => verifyStripeSignature(body, sign(nowS, 'other'), secret, nowS)).toThrow();
    expect(() => verifyStripeSignature(Buffer.from('{"id":"evt_2"}'), sign(nowS), secret, nowS)).toThrow();
    expect(() => verifyStripeSignature(body, sign(nowS - 3600), secret, nowS)).toThrow();
    expect(() => verifyStripeSignature(body, undefined, secret, nowS)).toThrow();
    expect(() => verifyStripeSignature(body, sign(nowS), '', nowS)).toThrow();
  });
  it('encodes nested params in Stripe bracket notation', () => {
    const out = encodeForm({ mode: 'subscription', line_items: [{ price: 'p', quantity: 1 }], subscription_data: { metadata: { a: 'b' } }, skip: undefined });
    expect(out).toContain('mode=subscription');
    expect(out).toContain(encodeURIComponent('line_items[0][price]') + '=p');
    expect(out).toContain(encodeURIComponent('subscription_data[metadata][a]') + '=b');
    expect(out.join('&')).not.toContain('skip');
  });
});

describe('payments: nothing is activated without paying', () => {
  const stripeCfg = (configured: boolean, env = 'production') => ({
    isConfigured: configured,
    request: jest.fn(),
  });
  let saved: any;
  const make = (opts: { configured: boolean; env?: string; tenantDoc?: any; usageConflicts?: any[] }) => {
    saved = [];
    const doc: any = opts.tenantDoc || {
      _id: 'tid', name: 'Acme', plan: 'starter',
      subscription: { planKey: 'starter', status: 'trialing', billingCycle: 'monthly' },
      trialEndsAt: inDays(10),
      markModified: () => undefined,
      save: async function () { saved.push(JSON.parse(JSON.stringify(this))); return this; },
    };
    const stripe: any = stripeCfg(opts.configured);
    const billing: any = {
      planOf: (t: any) => getPlanDefinition(t.subscription?.planKey || t.plan),
      computeAccess: (t: any) => svc().computeAccess(t, new Date()),
      findDowngradeConflicts: jest.fn().mockResolvedValue(opts.usageConflicts || []),
      mapPlanKeyToTenantPlan: (k: string) => k,
      getTenantSubscription: jest.fn(),
    };
    const config: any = { get: (k: string) => ({ NODE_ENV: opts.env ?? 'production', FRONTEND_URL: 'https://app.test', STRIPE_SECRET_KEY: '' } as any)[k] };
    const model: any = { findById: async () => doc };
    const payments = new BillingPaymentsService(model, billing, stripe, config);
    return { payments, stripe, doc, billing };
  };

  it('production without a payment provider: paid plan is refused, never granted', async () => {
    const { payments, doc } = make({ configured: false });
    await expect(payments.changePlan('tid', {}, 'pro', 'monthly')).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(doc.subscription.planKey).toBe('starter');
  });

  it('development without a provider may self-activate (explicit, non-production only)', async () => {
    const { payments, doc } = make({ configured: false, env: 'development' });
    const res = await payments.changePlan('tid', {}, 'pro', 'monthly');
    expect(res.action).toBe('updated');
    expect(doc.subscription.planKey).toBe('pro');
  });

  it('with Stripe configured a paid plan returns a checkout url and does NOT change the plan', async () => {
    const { payments, stripe, doc } = make({ configured: true });
    stripe.request.mockImplementation(async (_m: string, path: string, params: any) => {
      if (path === '/customers') return { id: 'cus_1' };
      if (path === '/prices' && _m === 'GET') return { data: [{ id: 'price_1' }] };
      if (path === '/checkout/sessions') return { url: 'https://checkout.stripe.test/s', _params: params };
      throw new Error('unexpected ' + path);
    });

    const res: any = await payments.changePlan('tid', { email: 'a@b.c' }, 'pro', 'yearly');
    expect(res).toEqual({ action: 'checkout', url: 'https://checkout.stripe.test/s' });
    expect(doc.subscription.planKey).toBe('starter'); // untouched until Stripe confirms payment

    const checkoutCall = stripe.request.mock.calls.find((c: any[]) => c[1] === '/checkout/sessions');
    const params = checkoutCall[2];
    expect(params.mode).toBe('subscription');
    expect(params.client_reference_id).toBe('tid');
    expect(params.subscription_data.metadata).toMatchObject({ tenantId: 'tid', planKey: 'pro', cycle: 'yearly' });
    // the remaining free trial (10 days) is honoured: card is charged only when it ends
    expect(params.subscription_data.trial_end).toBeGreaterThan(Date.now() / 1000);
  });

  it('a trial about to end is not passed to Stripe (it would be rejected); charge happens at checkout', async () => {
    const { payments, stripe } = make({
      configured: true,
      tenantDoc: {
        _id: 'tid', name: 'Acme', plan: 'pro',
        subscription: { planKey: 'pro', status: 'trialing', providerCustomerId: 'cus_1' },
        trialEndsAt: new Date(Date.now() + 6 * 60 * 60 * 1000),
        markModified: () => undefined, save: async () => undefined,
      },
    });
    stripe.request.mockImplementation(async (m: string, path: string) =>
      path === '/prices' ? (m === 'GET' ? { data: [{ id: 'p' }] } : { id: 'p' }) : { url: 'u' });
    await payments.changePlan('tid', {}, 'pro', 'monthly');
    const params = stripe.request.mock.calls.find((c: any[]) => c[1] === '/checkout/sessions')[2];
    expect(params.subscription_data.trial_end).toBeUndefined();
  });

  it('downgrade that does not fit is refused with the reasons', async () => {
    const { payments } = make({
      configured: true,
      usageConflicts: [{ key: 'maxConnectedAssets', label: 'canales conectados', used: 9, limit: 3 }],
      tenantDoc: {
        _id: 'tid', name: 'A', plan: 'pro',
        subscription: { planKey: 'pro', status: 'active', providerSubscriptionId: 'sub_1' },
        markModified: () => undefined, save: async () => undefined,
      },
    });
    await expect(payments.changePlan('tid', {}, 'starter', 'monthly')).rejects.toBeInstanceOf(ConflictException);
  });

  it('webhook sync: Stripe is the source of truth and the result is idempotent', async () => {
    const tenantDoc: any = {
      _id: 'tid', name: 'A', plan: 'starter',
      subscription: { planKey: 'starter', status: 'trialing', provider: 'manual' },
      markModified: () => undefined, save: async () => undefined,
    };
    const { payments } = make({ configured: true, tenantDoc });
    (payments as any).tenantModel = { findById: async () => tenantDoc, findOne: async () => null };
    const sub = {
      id: 'sub_1', customer: 'cus_1', status: 'active', cancel_at_period_end: false,
      metadata: { tenantId: 'tid' },
      items: { data: [{ current_period_start: 1_800_000_000, current_period_end: 1_802_592_000, price: { id: 'price_1', metadata: { planKey: 'pro' }, recurring: { interval: 'month' } } }] },
    };
    await payments.syncSubscription(sub);
    const first = JSON.stringify(tenantDoc.subscription);
    await payments.syncSubscription(sub);
    expect(JSON.stringify(tenantDoc.subscription)).toBe(first);
    expect(tenantDoc.subscription).toMatchObject({ planKey: 'pro', status: 'active', provider: 'stripe', providerSubscriptionId: 'sub_1' });
    expect(tenantDoc.limits.maxUsers).toBe(10);
    expect(tenantDoc.status).toBe('active');

    // payment failure then deletion returns the account to Free
    await payments.syncSubscription({ ...sub, status: 'past_due' });
    expect(tenantDoc.subscription.status).toBe('past_due');
    expect(tenantDoc.subscription.pastDueSince).toBeDefined();
    await payments.syncSubscription({ ...sub, status: 'canceled' });
    expect(tenantDoc.subscription).toMatchObject({ planKey: 'free', status: 'active' });
    expect(tenantDoc.subscription.providerSubscriptionId).toBeUndefined();
  });
});

describe('notices', () => {
  const notices: any = new (BillingNoticesService as any)({}, {}, svc(), {}, {});

  it('chooses the right reminder from the clock', () => {
    const t = (days: number) => tenant('pro', { status: 'trialing' }, { trialEndsAt: inDays(days) });
    expect(notices.dueNotice(t(10), now)).toBeNull();
    expect(notices.dueNotice(t(3), now)?.kind).toBe('trial_3d');
    expect(notices.dueNotice(t(1), now)?.kind).toBe('trial_1d');
    expect(notices.dueNotice(t(-1), now)?.kind).toBe('trial_expired');
    expect(notices.dueNotice(tenant('pro', { status: 'past_due', pastDueSince: inDays(-1) }), now)?.kind).toBe('past_due');
    expect(notices.dueNotice(tenant('free', { status: 'active' }), now)).toBeNull();
  });

  it('notice keys are stable per trial so reminders are sent once', () => {
    const a = notices.dueNotice(tenant('pro', { status: 'trialing' }, { trialEndsAt: inDays(2) }), now);
    const b = notices.dueNotice(tenant('pro', { status: 'trialing' }, { trialEndsAt: inDays(2) }), new Date(now.getTime() + 3600_000));
    expect(a.key).toBe(b.key);
  });
});

describe('guards', () => {
  const ctx = (req: any, pub = false) => ({
    getType: () => 'http', getHandler: () => ({}), getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => req }),
    __pub: pub,
  }) as any;
  const reflector = (value: any) => ({ getAllAndOverride: jest.fn().mockReturnValue(value) }) as any;
  const user = { tenantId: 't1' };

  it('read-only mode blocks writes on company data but never reads, deletes, billing or webhooks', async () => {
    const billing: any = { assertTenantCanWrite: jest.fn().mockRejectedValue(new PaymentRequiredException('x')) };
    const guard = new SubscriptionGuard(reflector(false), billing);
    await expect(guard.canActivate(ctx({ method: 'POST', originalUrl: '/api/v1/contacts', user }))).rejects.toBeInstanceOf(PaymentRequiredException);
    await expect(guard.canActivate(ctx({ method: 'PATCH', originalUrl: '/api/v1/leads/1', user }))).rejects.toBeInstanceOf(PaymentRequiredException);
    await expect(guard.canActivate(ctx({ method: 'GET', originalUrl: '/api/v1/contacts', user }))).resolves.toBe(true);
    await expect(guard.canActivate(ctx({ method: 'DELETE', originalUrl: '/api/v1/contacts/1', user }))).resolves.toBe(true);
    await expect(guard.canActivate(ctx({ method: 'POST', originalUrl: '/api/v1/integrations/email/accounts/1/disconnect', user }))).resolves.toBe(true);
    await expect(guard.canActivate(ctx({ method: 'POST', originalUrl: '/api/v1/billing/change-plan', user }))).resolves.toBe(true);
    await expect(guard.canActivate(ctx({ method: 'POST', originalUrl: '/api/v1/auth/login', user }))).resolves.toBe(true);
  });

  it('feature guard only fires on annotated routes', async () => {
    const billing: any = { assertFeature: jest.fn().mockResolvedValue(undefined) };
    await new PlanFeatureGuard(reflector(undefined), billing).canActivate(ctx({ user }));
    expect(billing.assertFeature).not.toHaveBeenCalled();
    await new PlanFeatureGuard(reflector('deals'), billing).canActivate(ctx({ user }));
    expect(billing.assertFeature).toHaveBeenCalledWith('t1', 'deals');
  });
});
