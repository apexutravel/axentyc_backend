import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { MembershipsService } from '../memberships/memberships.service';
import { ReportsService } from './reports.service';
import { BillingService } from '../billing/billing.service';

@ApiTags('reports')
@ApiBearerAuth()
@Controller('reports')
export class ReportsController {
  constructor(
    private readonly service: ReportsService,
    private readonly memberships: MembershipsService,
    private readonly billing: BillingService,
  ) {}

  @Get('dashboard')
  @ApiOperation({ summary: 'What needs attention today in the workspace' })
  async dashboard(@CurrentUser() user: any, @Query('workspaceId') workspaceId?: string) {
    const userId = user._id || user.sub;
    await this.memberships.assertCanAccessWorkspace(user.tenantId, userId, workspaceId);
    const [invoicing, deals] = await Promise.all([this.billing.hasFeature(user.tenantId, 'invoicing'), this.billing.hasFeature(user.tenantId, 'deals')]);
    return this.service.dashboard(user.tenantId, workspaceId, userId, invoicing, deals);
  }

  @Get('overview')
  @ApiOperation({ summary: 'Response times, conversations, funnel and sales for the workspace' })
  async overview(@CurrentUser() user: any, @Query('workspaceId') workspaceId?: string, @Query('from') from?: string, @Query('to') to?: string) {
    await this.memberships.assertCanAccessWorkspace(user.tenantId, user._id || user.sub, workspaceId);
    return this.service.overview(user.tenantId, workspaceId, from, to);
  }
}
