import { ForbiddenException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Tenant, TenantDocument, SubscriptionStatus, TenantStatus, TenantPlan } from '../tenants/entities/tenant.entity';
import { User, UserDocument } from '../users/entities/user.entity';
import { Invitation, InvitationDocument, InvitationStatus } from '../users/entities/invitation.entity';
import { Workspace, WorkspaceDocument } from '../workspaces/entities/workspace.entity';
import { SocialAccount, SocialAccountDocument } from '../integrations/entities/social-account.entity';
import { EmailIntegration, EmailIntegrationDocument } from '../integrations/entities/email-integration.entity';
import { WidgetConfig, WidgetConfigDocument } from '../chat-widget/entities/widget-config.entity';
import { Automation, AutomationDocument } from '../automations/entities/automation.entity';
import { Conversation, ConversationDocument } from '../conversations/entities/conversation.entity';
import {
  BillingCycle,
  DEFAULT_PLAN_KEY,
  PlanDefinition,
  PlanFeatureKey,
  PlanLimitKey,
  PLAN_DEFINITIONS,
  getPlanDefinition,
  isUnlimited,
} from './plans';

/** Days a customer keeps full access after a failed payment while the card is retried. */
export const PAST_DUE_GRACE_DAYS = 3;
/** Days of courtesy trial given once to legacy tenants whose trial had already expired unnoticed. */
export const LEGACY_TRIAL_GRACE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export type AccessState =
  | 'free'
  | 'trialing'
  | 'trial_expired'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'unpaid'
  | 'locked';

export interface AccessInfo {
  state: AccessState;
  /** Writes (create / edit / send) are blocked */
  readOnly: boolean;
  /** The customer must pay to keep / regain full access */
  paymentRequired: boolean;
  trialEndsAt?: Date;
  /** Whole days left of the trial (0 when it ends today) */
  trialDaysLeft?: number;
  /** End of the grace period after a failed payment */
  graceEndsAt?: Date;
  /** Access ends at the end of the current period (user cancelled) */
  endsAt?: Date;
}

export interface UsageSnapshot {
  users: number;
  workspaces: number;
  connectedAssets: { total: number; socialAccounts: number; emailIntegrations: number; widgets: number };
  automations: number;
  conversationsThisMonth: number;
}

/** 403 for plan caps, 402 for payment problems. Both carry a machine readable `code`. */
export class PlanLimitException extends ForbiddenException {
  constructor(message: string, details: Record<string, any> = {}) {
    super({ message, code: 'PLAN_LIMIT_REACHED', details });
  }
}

export class PaymentRequiredException extends HttpException {
  constructor(message: string, code = 'SUBSCRIPTION_REQUIRED') {
    super({ message, code }, 402);
  }
}

@Injectable()
export class BillingService {
  constructor(
    @InjectModel(Tenant.name) private tenantModel: Model<TenantDocument>,
    @InjectModel(User.name) private userModel: Model<UserDocument>,
    @InjectModel(Invitation.name) private invitationModel: Model<InvitationDocument>,
    @InjectModel(Workspace.name) private workspaceModel: Model<WorkspaceDocument>,
    @InjectModel(SocialAccount.name) private socialAccountModel: Model<SocialAccountDocument>,
    @InjectModel(EmailIntegration.name) private emailIntegrationModel: Model<EmailIntegrationDocument>,
    @InjectModel(WidgetConfig.name) private widgetConfigModel: Model<WidgetConfigDocument>,
    @InjectModel(Automation.name) private automationModel: Model<AutomationDocument>,
    @InjectModel(Conversation.name) private conversationModel: Model<ConversationDocument>,
  ) {}

  listPlans() {
    return PLAN_DEFINITIONS;
  }

  // ─── Access state ───────────────────────────────────────────────────────────────

  /** Pure function of the stored tenant + the clock: no cron needed for correctness. */
  computeAccess(tenant: any, now = new Date()): AccessInfo {
    const sub = tenant.subscription || {};
    const planKey = sub.planKey || tenant.plan || DEFAULT_PLAN_KEY;
    const plan = getPlanDefinition(planKey);

    if (tenant.isActive === false || tenant.status === TenantStatus.LOCKED || tenant.status === TenantStatus.SUSPENDED) {
      return { state: 'locked', readOnly: true, paymentRequired: false };
    }
    if (plan.monthlyPrice === 0) return { state: 'free', readOnly: false, paymentRequired: false };
    if (sub.complimentary) return { state: 'active', readOnly: false, paymentRequired: false };

    const periodEnd: Date | undefined = sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd) : undefined;

    switch (sub.status) {
      case SubscriptionStatus.TRIALING: {
        const endsAt: Date | undefined = tenant.trialEndsAt ? new Date(tenant.trialEndsAt) : periodEnd;
        if (endsAt && endsAt.getTime() > now.getTime()) {
          return {
            state: 'trialing',
            readOnly: false,
            paymentRequired: false,
            trialEndsAt: endsAt,
            trialDaysLeft: Math.max(0, Math.ceil((endsAt.getTime() - now.getTime()) / DAY_MS)),
          };
        }
        return { state: 'trial_expired', readOnly: true, paymentRequired: true, trialEndsAt: endsAt, trialDaysLeft: 0 };
      }
      case SubscriptionStatus.PAST_DUE: {
        const since = sub.pastDueSince ? new Date(sub.pastDueSince) : now;
        const graceEndsAt = new Date(since.getTime() + PAST_DUE_GRACE_DAYS * DAY_MS);
        const inGrace = graceEndsAt.getTime() > now.getTime();
        return { state: 'past_due', readOnly: !inGrace, paymentRequired: true, graceEndsAt };
      }
      case SubscriptionStatus.UNPAID:
        return { state: 'unpaid', readOnly: true, paymentRequired: true };
      case SubscriptionStatus.PAUSED:
        return { state: 'locked', readOnly: true, paymentRequired: true };
      case SubscriptionStatus.CANCELED:
        return { state: 'canceled', readOnly: true, paymentRequired: true };
      case SubscriptionStatus.ACTIVE:
      default:
        return {
          state: 'active',
          readOnly: false,
          paymentRequired: false,
          endsAt: sub.cancelAtPeriodEnd ? periodEnd : undefined,
        };
    }
  }

  async getPlanLimits(tenantId: string) {
    return this.planOf(await this.loadTenant(tenantId)).limits;
  }

  /** Cheap check used by background jobs (automations) before doing any work for a tenant. */
  async canWrite(tenantId: string): Promise<boolean> {
    const tenant = await this.tenantModel.findById(tenantId).lean();
    return !!tenant && !this.computeAccess(tenant).readOnly;
  }

  /** The plan a tenant is effectively on (ignores payment state; see computeAccess). */
  planOf(tenant: any): PlanDefinition {
    return getPlanDefinition(tenant.subscription?.planKey || tenant.plan || DEFAULT_PLAN_KEY);
  }

  private async loadTenant(tenantId: string) {
    const tenant = await this.tenantModel.findById(tenantId).lean();
    if (!tenant) throw new NotFoundException('Tenant not found');
    return tenant;
  }

  // ─── Usage ──────────────────────────────────────────────────────────────────────

  async getConnectedAssetUsage(tenantId: string, workspaceId?: string) {
    const tenantObjectId = new Types.ObjectId(tenantId);
    const socialQuery: any = { tenantId: tenantObjectId, isActive: true };
    // Disconnected mailboxes do not consume plan capacity
    const emailQuery: any = { tenantId: tenantObjectId, status: { $ne: 'disconnected' } };
    const widgetQuery: any = { tenantId: tenantObjectId };

    if (workspaceId) {
      const ws = new Types.ObjectId(workspaceId);
      socialQuery.workspaceId = ws;
      emailQuery.workspaceId = ws;
      widgetQuery.workspaceId = ws;
    }

    const [socialAccounts, emailIntegrations, widgets] = await Promise.all([
      this.socialAccountModel.countDocuments(socialQuery),
      this.emailIntegrationModel.countDocuments(emailQuery),
      this.widgetConfigModel.countDocuments(widgetQuery),
    ]);

    return { socialAccounts, emailIntegrations, widgets, total: socialAccounts + emailIntegrations + widgets };
  }

  async getUsage(tenantId: string): Promise<UsageSnapshot> {
    const tenantObjectId = new Types.ObjectId(tenantId);
    const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));

    const [users, pendingInvites, workspaces, connectedAssets, automations, conversationsThisMonth] = await Promise.all([
      this.userModel.countDocuments({ tenantId: tenantObjectId, isActive: true }),
      this.invitationModel.countDocuments({
        tenantId: tenantObjectId,
        status: InvitationStatus.PENDING,
        expiresAt: { $gt: new Date() },
      }),
      this.workspaceModel.countDocuments({ tenantId: tenantObjectId, isActive: true }),
      this.getConnectedAssetUsage(tenantId),
      this.automationModel.countDocuments({ tenantId: tenantObjectId }),
      this.conversationModel.countDocuments({ tenantId: tenantObjectId, createdAt: { $gte: monthStart } }),
    ]);

    return { users: users + pendingInvites, workspaces, connectedAssets, automations, conversationsThisMonth };
  }

  /** Current usage expressed against a plan's limit keys. */
  usageByLimit(usage: UsageSnapshot): Record<PlanLimitKey, number> {
    return {
      maxUsers: usage.users,
      maxWorkspaces: usage.workspaces,
      maxConnectedAssets: usage.connectedAssets.total,
      maxAutomations: usage.automations,
      maxConversationsMonthly: usage.conversationsThisMonth,
    };
  }

  async getTenantSubscription(tenantId: string) {
    const tenant = await this.loadTenant(tenantId);
    const plan = this.planOf(tenant);
    const access = this.computeAccess(tenant);
    const usage = await this.getUsage(tenantId);
    const sub = tenant.subscription || null;

    return {
      tenantId,
      plan,
      subscription: sub
        ? {
            planKey: sub.planKey,
            status: sub.status,
            billingCycle: sub.billingCycle,
            currentPeriodStart: sub.currentPeriodStart,
            currentPeriodEnd: sub.currentPeriodEnd,
            cancelAtPeriodEnd: !!sub.cancelAtPeriodEnd,
            provider: sub.provider,
            complimentary: !!sub.complimentary,
            hasPaymentMethod: !!sub.providerSubscriptionId,
          }
        : null,
      status: tenant.status,
      trialEndsAt: tenant.trialEndsAt,
      access,
      isReadOnly: access.readOnly,
      usage: { ...usage, connectedAssets: usage.connectedAssets },
    };
  }

  // ─── Enforcement ────────────────────────────────────────────────────────────────

  async assertTenantCanWrite(tenantId: string) {
    const tenant = await this.loadTenant(tenantId);
    const access = this.computeAccess(tenant);
    if (!access.readOnly) return;

    const message =
      access.state === 'trial_expired'
        ? 'Tu período de prueba terminó. Activa tu suscripción para seguir trabajando.'
        : access.state === 'past_due' || access.state === 'unpaid'
          ? 'No pudimos cobrar tu suscripción. Actualiza tu método de pago para seguir trabajando.'
          : access.state === 'canceled'
            ? 'Tu suscripción terminó. Reactívala para seguir trabajando.'
            : 'Tu cuenta está en modo solo lectura.';
    throw new PaymentRequiredException(message);
  }

  private limitLabel(key: PlanLimitKey): string {
    return {
      maxUsers: 'usuarios',
      maxWorkspaces: 'empresas (workspaces)',
      maxConnectedAssets: 'canales conectados',
      maxAutomations: 'automatizaciones',
      maxConversationsMonthly: 'conversaciones al mes',
    }[key];
  }

  /** Throws when adding `amount` more would exceed the plan's cap for `key`. */
  private assertWithin(plan: PlanDefinition, key: PlanLimitKey, current: number, amount = 1) {
    const limit = plan.limits[key];
    if (isUnlimited(limit)) return;
    if (current + amount > limit) {
      const label = this.limitLabel(key);
      const message =
        limit === 0
          ? `El plan ${plan.name} no incluye ${label}. Mejora tu plan para usarlo.`
          : `Llegaste al límite de ${limit} ${label} del plan ${plan.name}. Mejora tu plan para agregar más.`;
      throw new PlanLimitException(message, { limitKey: key, limit, used: current, plan: plan.key });
    }
  }

  async assertFeature(tenantId: string, feature: PlanFeatureKey) {
    const tenant = await this.loadTenant(tenantId);
    const plan = this.planOf(tenant);
    if (!plan.features[feature]) {
      const names: Record<PlanFeatureKey, string> = {
        invoicing: 'Las cotizaciones y facturas',
        deals: 'El pipeline de deals',
        teamRoles: 'Los roles de equipo',
        removeBranding: 'Quitar la marca AXENTYC',
        prioritySupport: 'El soporte prioritario',
      };
      throw new PlanLimitException(`${names[feature]} no está incluido en el plan ${plan.name}. Mejora tu plan para usarlo.`, {
        feature,
        plan: plan.key,
      });
    }
  }

  async hasFeature(tenantId: string, feature: PlanFeatureKey): Promise<boolean> {
    return !!this.planOf(await this.loadTenant(tenantId)).features[feature];
  }

  async assertCanCreateWorkspace(tenantId: string) {
    await this.assertTenantCanWrite(tenantId);
    const tenant = await this.loadTenant(tenantId);
    const count = await this.workspaceModel.countDocuments({ tenantId: new Types.ObjectId(tenantId), isActive: true });
    this.assertWithin(this.planOf(tenant), 'maxWorkspaces', count);
  }

  async assertCanInviteUser(tenantId: string, role?: string) {
    await this.assertTenantCanWrite(tenantId);
    const tenant = await this.loadTenant(tenantId);
    const plan = this.planOf(tenant);
    const usage = await this.getUsage(tenantId);
    this.assertWithin(plan, 'maxUsers', usage.users);
    if (role) await this.assertRoleAllowed(tenantId, role);
  }

  /** Only the "agent" role is available on plans without team roles. */
  async assertRoleAllowed(tenantId: string, role: string) {
    if (!role || role === 'agent') return;
    await this.assertFeature(tenantId, 'teamRoles');
  }

  async assertCanConnectSocial(tenantId: string, workspaceId?: string) {
    await this.assertCanAddConnectedAssets(tenantId, 1, workspaceId);
  }

  async assertCanConnectEmail(tenantId: string, workspaceId?: string) {
    await this.assertCanAddConnectedAssets(tenantId, 1, workspaceId);
  }

  async assertCanCreateWidget(tenantId: string, workspaceId?: string) {
    await this.assertCanAddConnectedAssets(tenantId, 1, workspaceId);
  }

  async assertCanAddConnectedAssets(tenantId: string, amount = 1, _workspaceId?: string) {
    await this.assertTenantCanWrite(tenantId);
    const tenant = await this.loadTenant(tenantId);
    // The plan limit applies to the whole account, so usage is counted account-wide
    const usage = await this.getConnectedAssetUsage(tenantId);
    this.assertWithin(this.planOf(tenant), 'maxConnectedAssets', usage.total, amount);
  }

  async assertCanCreateAutomation(tenantId: string) {
    await this.assertTenantCanWrite(tenantId);
    const tenant = await this.loadTenant(tenantId);
    const count = await this.automationModel.countDocuments({ tenantId: new Types.ObjectId(tenantId) });
    this.assertWithin(this.planOf(tenant), 'maxAutomations', count);
  }

  /**
   * Replying counts against the monthly conversation quota. Inbound messages are always received
   * (never lose a lead), but once the quota is exhausted the team has to upgrade to answer.
   */
  async assertCanReply(tenantId: string) {
    await this.assertTenantCanWrite(tenantId);
    const tenant = await this.loadTenant(tenantId);
    const plan = this.planOf(tenant);
    const limit = plan.limits.maxConversationsMonthly;
    if (isUnlimited(limit)) return;
    const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
    const used = await this.conversationModel.countDocuments({
      tenantId: new Types.ObjectId(tenantId),
      createdAt: { $gte: monthStart },
    });
    if (used > limit) {
      throw new PlanLimitException(
        `Alcanzaste las ${limit.toLocaleString('en-US')} conversaciones del mes del plan ${plan.name}. Mejora tu plan para seguir respondiendo.`,
        { limitKey: 'maxConversationsMonthly', limit, used, plan: plan.key },
      );
    }
  }

  /** Whether the chat widget may hide the AXENTYC badge. */
  async canRemoveBranding(tenantId: string): Promise<boolean> {
    const tenant = await this.loadTenant(tenantId);
    return this.planOf(tenant).features.removeBranding && !this.computeAccess(tenant).readOnly;
  }

  /**
   * Which limits would be exceeded if the tenant moved to `target`. Used to block downgrades that
   * would leave the account with more than the new plan allows.
   */
  async findDowngradeConflicts(tenantId: string, target: PlanDefinition) {
    const usage = this.usageByLimit(await this.getUsage(tenantId));
    const conflicts: { key: PlanLimitKey; label: string; used: number; limit: number }[] = [];
    // The monthly conversation counter resets every month, so it never blocks a downgrade
    (['maxUsers', 'maxWorkspaces', 'maxConnectedAssets', 'maxAutomations'] as PlanLimitKey[]).forEach((key) => {
      const limit = target.limits[key];
      if (!isUnlimited(limit) && usage[key] > limit) {
        conflicts.push({ key, label: this.limitLabel(key), used: usage[key], limit });
      }
    });
    return conflicts;
  }

  // ─── Initial subscription (registration) ────────────────────────────────────────

  buildInitialSubscription(planKey = DEFAULT_PLAN_KEY, billingCycle: BillingCycle = 'monthly') {
    const plan = getPlanDefinition(planKey);
    const now = new Date();
    const paid = plan.monthlyPrice > 0;
    const trialEndsAt = paid && plan.trialDays > 0 ? new Date(now.getTime() + plan.trialDays * DAY_MS) : undefined;
    const status = trialEndsAt ? SubscriptionStatus.TRIALING : SubscriptionStatus.ACTIVE;

    return {
      plan,
      status,
      tenantStatus: trialEndsAt ? TenantStatus.TRIAL : TenantStatus.ACTIVE,
      trialEndsAt,
      subscription: {
        planKey: plan.key,
        status,
        billingCycle,
        currentPeriodStart: now,
        currentPeriodEnd: trialEndsAt || new Date(now.getTime() + 30 * DAY_MS),
        cancelAtPeriodEnd: false,
        provider: 'manual' as const,
      },
    };
  }

  mapPlanKeyToTenantPlan(planKey: string): TenantPlan {
    if (planKey === 'pro') return TenantPlan.PRO;
    if (planKey === 'agency') return TenantPlan.AGENCY;
    if (planKey === 'starter') return TenantPlan.STARTER;
    return TenantPlan.FREE;
  }
}
