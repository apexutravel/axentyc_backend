import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../common/decorators/public.decorator';
import { scopedSegment } from '../workspaces/workspace-scope.guard';
import { BillingService } from './billing.service';
import { PlanFeatureKey } from './plans';

export const REQUIRES_FEATURE_KEY = 'requiresFeature';
/** Blocks the route (or whole controller) unless the tenant's plan includes the feature. */
export const RequiresFeature = (feature: PlanFeatureKey) => SetMetadata(REQUIRES_FEATURE_KEY, feature);

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Read-only mode: when the trial ended or payment failed, company data can still be read,
 * exported and deleted, but nothing can be created, edited or sent. Billing and auth routes
 * stay open so the customer can pay. Webhooks are public and keep ingesting messages.
 */
@Injectable()
export class SubscriptionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly billing: BillingService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()])) return true;

    const req = context.switchToHttp().getRequest();
    if (SAFE_METHODS.has(req.method)) return true;

    const url: string = req.originalUrl || req.url || '';
    const prefix = process.env.API_PREFIX || 'api/v1';
    if (!scopedSegment(url, prefix)) return true;

    // Cleaning up (deleting / disconnecting) must always be possible, e.g. to fit a smaller plan
    if (req.method === 'DELETE' || url.split('?')[0].endsWith('/disconnect')) return true;
    if (!req.user?.tenantId) return true; // JwtAuthGuard decides

    await this.billing.assertTenantCanWrite(req.user.tenantId);
    return true;
  }
}

@Injectable()
export class PlanFeatureGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly billing: BillingService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const feature = this.reflector.getAllAndOverride<PlanFeatureKey>(REQUIRES_FEATURE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!feature) return true;

    const user = context.switchToHttp().getRequest().user;
    if (!user?.tenantId) return true;
    await this.billing.assertFeature(user.tenantId, feature);
    return true;
  }
}
