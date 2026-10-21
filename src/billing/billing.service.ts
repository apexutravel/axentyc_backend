import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Tenant, TenantDocument, SubscriptionStatus, TenantStatus, TenantPlan } from '../tenants/entities/tenant.entity';
import { User, UserDocument } from '../users/entities/user.entity';
import { Workspace, WorkspaceDocument } from '../workspaces/entities/workspace.entity';
import { SocialAccount, SocialAccountDocument } from '../integrations/entities/social-account.entity';
import { EmailIntegration, EmailIntegrationDocument } from '../integrations/entities/email-integration.entity';
import { WidgetConfig, WidgetConfigDocument } from '../chat-widget/entities/widget-config.entity';
import { PLAN_DEFINITIONS, BillingCycle, getPlanDefinition } from './plans';

@Injectable()
export class BillingService {
  constructor(
    @InjectModel(Tenant.name)
    private tenantModel: Model<TenantDocument>,
    @InjectModel(User.name)
    private userModel: Model<UserDocument>,
    @InjectModel(Workspace.name)
    private workspaceModel: Model<WorkspaceDocument>,
    @InjectModel(SocialAccount.name)
    private socialAccountModel: Model<SocialAccountDocument>,
    @InjectModel(EmailIntegration.name)
    private emailIntegrationModel: Model<EmailIntegrationDocument>,
    @InjectModel(WidgetConfig.name)
    private widgetConfigModel: Model<WidgetConfigDocument>,
  ) {}

  listPlans() {
    return PLAN_DEFINITIONS;
  }

  async getConnectedAssetUsage(tenantId: string, workspaceId?: string) {
    const socialQuery: any = { tenantId: new Types.ObjectId(tenantId), isActive: true };
    // Disconnected mailboxes do not consume plan capacity
    const emailQuery: any = { tenantId: new Types.ObjectId(tenantId), status: { $ne: 'disconnected' } };
    const widgetQuery: any = { tenantId: new Types.ObjectId(tenantId) };

    if (workspaceId) {
      const workspaceObjectId = new Types.ObjectId(workspaceId);
      socialQuery.workspaceId = workspaceObjectId;
      emailQuery.workspaceId = workspaceObjectId;
      widgetQuery.workspaceId = workspaceObjectId;
    }

    const [socialAccounts, emailIntegrations, widgets] = await Promise.all([
      this.socialAccountModel.countDocuments(socialQuery),
      this.emailIntegrationModel.countDocuments(emailQuery),
      this.widgetConfigModel.countDocuments(widgetQuery),
    ]);

    return {
      socialAccounts,
      emailIntegrations,
      widgets,
      total: socialAccounts + emailIntegrations + widgets,
    };
  }

  async getTenantSubscription(tenantId: string) {
    const tenant = await this.tenantModel.findById(tenantId).lean();
    if (!tenant) throw new NotFoundException('Tenant not found');

    const planKey = tenant.subscription?.planKey || tenant.plan || 'starter';
    const plan = getPlanDefinition(planKey);
    const connectedAssets = await this.getConnectedAssetUsage(tenantId);

    return {
      tenantId,
      plan,
      subscription: tenant.subscription || null,
      status: tenant.status,
      trialEndsAt: tenant.trialEndsAt,
      isReadOnly: this.isReadOnlyTenant(tenant),
      usage: {
        connectedAssets,
      },
    };
  }

  buildInitialSubscription(planKey = 'starter', billingCycle: BillingCycle = 'monthly') {
    const plan = getPlanDefinition(planKey);
    const now = new Date();
    const trialEndsAt = plan.trialDays > 0
      ? new Date(now.getTime() + plan.trialDays * 24 * 60 * 60 * 1000)
      : undefined;

    return {
      plan,
      status: plan.trialDays > 0 ? SubscriptionStatus.TRIALING : SubscriptionStatus.ACTIVE,
      tenantStatus: plan.trialDays > 0 ? TenantStatus.TRIAL : TenantStatus.ACTIVE,
      trialEndsAt,
      subscription: {
        planKey: plan.key,
        status: plan.trialDays > 0 ? SubscriptionStatus.TRIALING : SubscriptionStatus.ACTIVE,
        billingCycle,
        currentPeriodStart: now,
        currentPeriodEnd: trialEndsAt || new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
        cancelAtPeriodEnd: false,
        provider: 'manual' as const,
      },
    };
  }

  async changePlan(tenantId: string, planKey: string, billingCycle: BillingCycle = 'monthly') {
    const plan = getPlanDefinition(planKey);
    const now = new Date();
    const currentPeriodEnd = new Date(now.getTime() + (billingCycle === 'yearly' ? 365 : 30) * 24 * 60 * 60 * 1000);

    const tenant = await this.tenantModel.findByIdAndUpdate(
      tenantId,
      {
        plan: this.mapPlanKeyToTenantPlan(plan.key),
        status: TenantStatus.ACTIVE,
        isActive: true,
        limits: plan.limits,
        subscription: {
          planKey: plan.key,
          status: SubscriptionStatus.ACTIVE,
          billingCycle,
          currentPeriodStart: now,
          currentPeriodEnd,
          cancelAtPeriodEnd: false,
          provider: 'manual',
        },
      },
      { returnDocument: 'after' },
    );

    if (!tenant) throw new NotFoundException('Tenant not found');
    return this.getTenantSubscription(tenantId);
  }

  async cancelAtPeriodEnd(tenantId: string) {
    const tenant = await this.tenantModel.findById(tenantId);
    if (!tenant) throw new NotFoundException('Tenant not found');

    tenant.subscription = {
      ...(tenant.subscription || this.buildInitialSubscription('free').subscription),
      cancelAtPeriodEnd: true,
      canceledAt: new Date(),
    } as any;
    await tenant.save();
    return this.getTenantSubscription(tenantId);
  }

  async reactivate(tenantId: string) {
    const tenant = await this.tenantModel.findById(tenantId);
    if (!tenant) throw new NotFoundException('Tenant not found');

    const plan = getPlanDefinition(tenant.subscription?.planKey || tenant.plan || 'starter');
    tenant.status = TenantStatus.ACTIVE;
    tenant.isActive = true;
    tenant.limits = plan.limits;
    tenant.subscription = {
      ...(tenant.subscription || this.buildInitialSubscription(plan.key).subscription),
      status: SubscriptionStatus.ACTIVE,
      cancelAtPeriodEnd: false,
      canceledAt: undefined,
    } as any;
    await tenant.save();
    return this.getTenantSubscription(tenantId);
  }

  async assertTenantCanWrite(tenantId: string) {
    const tenant = await this.tenantModel.findById(tenantId).lean();
    if (!tenant) throw new NotFoundException('Tenant not found');
    if (this.isReadOnlyTenant(tenant)) {
      throw new ForbiddenException('Subscription is not active. Reactivate the plan to continue.');
    }
  }

  async assertCanCreateWorkspace(tenantId: string) {
    await this.assertTenantCanWrite(tenantId);
    const plan = await this.getActivePlan(tenantId);
    const count = await this.workspaceModel.countDocuments({ tenantId: new Types.ObjectId(tenantId), isActive: true });
    if (count >= plan.limits.maxWorkspaces) {
      throw new ForbiddenException(`Plan limit reached: ${plan.limits.maxWorkspaces} workspaces`);
    }
  }

  async assertCanInviteUser(tenantId: string) {
    await this.assertTenantCanWrite(tenantId);
    const plan = await this.getActivePlan(tenantId);
    const count = await this.userModel.countDocuments({ tenantId: new Types.ObjectId(tenantId), isActive: true });
    if (count >= plan.limits.maxUsers) {
      throw new ForbiddenException(`Plan limit reached: ${plan.limits.maxUsers} users`);
    }
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

  async assertCanAddConnectedAssets(tenantId: string, amount = 1, workspaceId?: string) {
    await this.assertTenantCanWrite(tenantId);
    const plan = await this.getActivePlan(tenantId);
    // The plan limit applies to the whole account, so usage is counted account-wide
    const usage = await this.getConnectedAssetUsage(tenantId);
    const limit = plan.limits.maxConnectedAssets ?? plan.limits.maxSocialAccounts;

    if (usage.total + amount > limit) {
      const remaining = Math.max(limit - usage.total, 0);
      throw new ForbiddenException(
        `Plan limit reached: ${limit} connected assets. ${remaining} available.`,
      );
    }
  }

  private async getActivePlan(tenantId: string) {
    const tenant = await this.tenantModel.findById(tenantId).lean();
    if (!tenant) throw new NotFoundException('Tenant not found');
    return getPlanDefinition(tenant.subscription?.planKey || tenant.plan || 'starter');
  }

  private isReadOnlyTenant(tenant: any) {
    return (
      tenant.status === TenantStatus.CANCELLED ||
      tenant.status === TenantStatus.LOCKED ||
      tenant.subscription?.status === SubscriptionStatus.CANCELED ||
      tenant.subscription?.status === SubscriptionStatus.UNPAID ||
      tenant.subscription?.status === SubscriptionStatus.PAUSED
    );
  }

  private mapPlanKeyToTenantPlan(planKey: string): TenantPlan {
    if (planKey === 'pro') return TenantPlan.PRO;
    if (planKey === 'business') return TenantPlan.BUSINESS;
    if (planKey === 'agency') return TenantPlan.AGENCY;
    if (planKey === 'enterprise') return TenantPlan.ENTERPRISE;
    if (planKey === 'free') return TenantPlan.FREE;
    return TenantPlan.STARTER;
  }
}
