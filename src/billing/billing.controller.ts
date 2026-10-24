import { SkipThrottle } from '@nestjs/throttler';
import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { MembershipsService } from '../memberships/memberships.service';
import { BillingService } from './billing.service';
import { BillingPaymentsService } from './billing-payments.service';
import { StripeClient, verifyStripeSignature } from './stripe.client';

@ApiTags('billing')
@Controller('billing')
export class BillingController {
  constructor(
    private readonly billingService: BillingService,
    private readonly payments: BillingPaymentsService,
    private readonly stripe: StripeClient,
    private readonly memberships: MembershipsService,
  ) {}

  private manage(user: any) {
    return this.memberships.assertCanManageAccount(user.tenantId, user._id || user.sub);
  }

  @Public()
  @Get('plans')
  @ApiOperation({ summary: 'List available plans (source of truth for /pricing)' })
  plans() {
    return this.billingService.listPlans();
  }

  @Get('payment-config')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Which payment capabilities are available' })
  paymentConfig() {
    return this.payments.getPaymentConfig();
  }

  @Get('subscription')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Current plan, access state (trial / payment) and usage' })
  subscription(@CurrentUser() user: any) {
    return this.billingService.getTenantSubscription(user.tenantId);
  }

  @Post('change-plan')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Choose a plan. Paid plans return a checkout URL; nothing is activated without payment.' })
  async changePlan(
    @CurrentUser() user: any,
    @Body('planKey') planKey: string,
    @Body('billingCycle') billingCycle?: 'monthly' | 'yearly',
  ) {
    await this.manage(user);
    return this.payments.changePlan(user.tenantId, user, planKey, billingCycle || 'monthly');
  }

  @Post('portal')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Stripe customer portal: payment method, invoices, receipts' })
  async portal(@CurrentUser() user: any) {
    await this.manage(user);
    return { url: await this.payments.createPortalUrl(user.tenantId) };
  }

  @Post('cancel')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Cancel subscription at period end' })
  async cancel(@CurrentUser() user: any) {
    await this.manage(user);
    return this.payments.cancelAtPeriodEnd(user.tenantId);
  }

  @Post('reactivate')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Undo a scheduled cancellation' })
  async reactivate(@CurrentUser() user: any) {
    await this.manage(user);
    return this.payments.reactivate(user.tenantId);
  }

  @Public()
  @SkipThrottle()
  @Post('webhook/stripe')
  @HttpCode(200)
  @ApiOperation({ summary: 'Stripe webhook (signature verified)' })
  async stripeWebhook(@Req() req: Request) {
    const rawBody: Buffer | undefined = (req as any).rawBody;
    if (!rawBody) throw new Error('Raw body not captured for Stripe webhook');
    verifyStripeSignature(rawBody, req.headers['stripe-signature'] as string, this.stripe.webhookSecret);
    await this.payments.handleStripeEvent(JSON.parse(rawBody.toString('utf8')));
    return { received: true };
  }
}
