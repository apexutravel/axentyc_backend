import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { BillingService } from './billing.service';

@ApiTags('billing')
@Controller('billing')
export class BillingController {
  constructor(private readonly billingService: BillingService) {}

  @Public()
  @Get('plans')
  @ApiOperation({ summary: 'List available plans' })
  plans() {
    return this.billingService.listPlans();
  }

  @Get('subscription')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current tenant subscription' })
  subscription(@CurrentUser() user: any) {
    return this.billingService.getTenantSubscription(user.tenantId);
  }

  @Post('change-plan')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Change current tenant plan' })
  changePlan(
    @CurrentUser() user: any,
    @Body('planKey') planKey: string,
    @Body('billingCycle') billingCycle?: 'monthly' | 'yearly',
  ) {
    return this.billingService.changePlan(user.tenantId, planKey, billingCycle || 'monthly');
  }

  @Post('cancel')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Cancel subscription at period end' })
  cancel(@CurrentUser() user: any) {
    return this.billingService.cancelAtPeriodEnd(user.tenantId);
  }

  @Post('reactivate')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Reactivate current subscription' })
  reactivate(@CurrentUser() user: any) {
    return this.billingService.reactivate(user.tenantId);
  }
}
