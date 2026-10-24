import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Tenant, TenantDocument, SubscriptionStatus, TenantStatus } from '../tenants/entities/tenant.entity';
import { User, UserDocument, UserRole } from '../users/entities/user.entity';
import { BillingService, LEGACY_TRIAL_GRACE_DAYS } from './billing.service';
import { SystemMailerService } from './system-mailer.service';
import { getPlanDefinition, normalizePlanKey } from './plans';

const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class BillingNoticesService implements OnModuleInit {
  private readonly logger = new Logger(BillingNoticesService.name);

  constructor(
    @InjectModel(Tenant.name) private tenantModel: Model<TenantDocument>,
    @InjectModel(User.name) private userModel: Model<UserDocument>,
    private readonly billing: BillingService,
    private readonly mailer: SystemMailerService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    // Never block start-up
    setTimeout(() => {
      this.migrateLegacyTenants()
        .then(() => this.runDailyChecks())
        .catch((e) => this.logger.error(`Billing bootstrap failed: ${e?.message || e}`));
    }, 10000);
  }

  // ─── One-time migration of tenants created before real billing existed ──────────

  /**
   * - Aligns stored plan keys / limits with the current catalog (business -> agency, new limit names).
   * - Free tenants stop being "in trial".
   * - Paid plans that were switched on without any payment keep working as courtesy accounts.
   * - Trials that expired unnoticed (nothing used to enforce them) get ONE short grace so nobody is
   *   locked out the day billing goes live.
   */
  async migrateLegacyTenants() {
    const tenants = await this.tenantModel.find({ 'billingNotices.legacy_migrated': { $exists: false } });
    for (const tenant of tenants) {
      const sub: any = { ...(tenant.subscription || {}) };
      const plan = getPlanDefinition(sub.planKey || tenant.plan);
      const now = new Date();
      const notes: string[] = [];

      sub.planKey = plan.key;
      tenant.plan = this.billing.mapPlanKeyToTenantPlan(plan.key);
      tenant.limits = { ...plan.limits };

      if (plan.monthlyPrice === 0) {
        sub.status = SubscriptionStatus.ACTIVE;
        sub.provider = sub.provider || 'manual';
        sub.billingCycle = sub.billingCycle || 'monthly';
        tenant.status = TenantStatus.ACTIVE;
        tenant.trialEndsAt = undefined;
        notes.push('free');
      } else if (sub.provider !== 'stripe') {
        if (sub.status === SubscriptionStatus.TRIALING || !sub.status) {
          const endsAt = tenant.trialEndsAt ? new Date(tenant.trialEndsAt) : undefined;
          if (!endsAt || endsAt.getTime() < now.getTime()) {
            const graceEnd = new Date(now.getTime() + LEGACY_TRIAL_GRACE_DAYS * DAY_MS);
            tenant.trialEndsAt = graceEnd;
            sub.currentPeriodEnd = graceEnd;
            notes.push(`trial grace until ${graceEnd.toISOString()}`);
          }
          sub.status = SubscriptionStatus.TRIALING;
          tenant.status = TenantStatus.TRIAL;
        } else if (sub.status === SubscriptionStatus.ACTIVE) {
          sub.complimentary = true;
          notes.push('complimentary');
        }
      }

      tenant.subscription = sub;
      tenant.markModified('subscription');
      tenant.billingNotices = { ...(tenant.billingNotices || {}), legacy_migrated: now };
      tenant.markModified('billingNotices');
      await tenant.save();
      this.logger.log(`[Billing migration] ${tenant.name}: ${plan.key} (${notes.join(', ') || 'aligned'})`);
    }
    return tenants.length;
  }

  // ─── Reminders ──────────────────────────────────────────────────────────────────

  @Cron('0 9 * * *')
  async runDailyChecks() {
    const tenants = await this.tenantModel.find({
      'subscription.status': { $in: [SubscriptionStatus.TRIALING, SubscriptionStatus.PAST_DUE] },
    });
    for (const tenant of tenants) {
      try {
        await this.checkTenant(tenant);
      } catch (e: any) {
        this.logger.error(`Billing check failed for ${tenant.name}: ${e?.message || e}`);
      }
    }
  }

  /** Which notice (if any) is due right now. Pure, so it is easy to test. */
  dueNotice(tenant: any, now = new Date()): { key: string; kind: 'trial_3d' | 'trial_1d' | 'trial_expired' | 'past_due' } | null {
    const access = this.billing.computeAccess(tenant, now);
    if (access.state === 'trialing' && access.trialEndsAt) {
      const stamp = access.trialEndsAt.toISOString().slice(0, 10);
      const left = access.trialDaysLeft ?? 99;
      if (left <= 1) return { key: `trial_1d:${stamp}`, kind: 'trial_1d' };
      if (left <= 3) return { key: `trial_3d:${stamp}`, kind: 'trial_3d' };
    }
    if (access.state === 'trial_expired') {
      return { key: `trial_expired:${(access.trialEndsAt || now).toISOString().slice(0, 10)}`, kind: 'trial_expired' };
    }
    if (access.state === 'past_due') {
      const since = (tenant.subscription?.pastDueSince ? new Date(tenant.subscription.pastDueSince) : now).toISOString().slice(0, 10);
      return { key: `past_due:${since}`, kind: 'past_due' };
    }
    return null;
  }

  private async checkTenant(tenant: TenantDocument) {
    const due = this.dueNotice(tenant);
    if (!due || tenant.billingNotices?.[due.key]) return;

    const plan = this.billing.planOf(tenant);
    const link = `${(this.config.get<string>('FRONTEND_URL') || this.config.get<string>('CORS_ORIGIN') || '').replace(/\/+$/, '')}/account?tab=billing`;
    const copy = {
      trial_3d: [`Tu prueba de AXENTYC ${plan.name} termina en pocos días`, 'Activa tu suscripción para no perder el acceso.'],
      trial_1d: [`Tu prueba de AXENTYC ${plan.name} termina mañana`, 'Activa tu suscripción hoy para seguir trabajando sin interrupciones.'],
      trial_expired: [`Tu prueba de AXENTYC ${plan.name} terminó`, 'Tu cuenta está en modo solo lectura. Activa tu suscripción para recuperar el acceso completo.'],
      past_due: ['No pudimos cobrar tu suscripción de AXENTYC', 'Actualiza tu método de pago para evitar que tu cuenta pase a modo solo lectura.'],
    }[due.kind];

    const admins = await this.userModel.find({ tenantId: tenant._id, role: UserRole.ADMIN, isActive: true }).select('email firstName');
    let sent = 0;
    for (const admin of admins) {
      const html = `<div style="font-family:Arial,sans-serif;max-width:520px"><h2>${copy[0]}</h2><p>Hola ${admin.firstName || ''},</p><p>${copy[1]}</p><p><a href="${link}" style="background:#2563eb;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">Ir a facturación</a></p><p style="color:#888;font-size:12px">Cuenta: ${tenant.name}</p></div>`;
      if (await this.mailer.send(admin.email, copy[0], html)) sent++;
    }

    // Recorded even when e-mail is not configured, so the log is not spammed every day
    tenant.billingNotices = { ...(tenant.billingNotices || {}), [due.key]: new Date() };
    tenant.markModified('billingNotices');
    await tenant.save();
    this.logger.log(`[Billing notice] ${tenant.name}: ${due.kind} (${sent}/${admins.length} e-mails)`);
  }
}
