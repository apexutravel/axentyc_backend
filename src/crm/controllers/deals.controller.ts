import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { DealsService } from '../services/deals.service';
import { CreateDealDto } from '../dto/create-deal.dto';
import { UpdateDealDto } from '../dto/update-deal.dto';
import { DealStage } from '../entities/deal.entity';
import { RequiresFeature } from '../../billing/billing.guards';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { MembershipsService } from '../../memberships/memberships.service';

@ApiTags('deals')
@ApiBearerAuth()
@RequiresFeature('deals')
@Controller('deals')
export class DealsController {
  constructor(
    private readonly dealsService: DealsService,
    private readonly membershipsService: MembershipsService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Create a new deal' })
  async create(@CurrentUser() user: any, @Body() createDealDto: CreateDealDto) {
    await this.membershipsService.assertCanAccessWorkspace(user.tenantId, user._id || user.sub, createDealDto.workspaceId);
    return this.dealsService.create(user.tenantId, createDealDto);
  }

  @Get()
  @ApiOperation({ summary: 'Get all deals for tenant' })
  @ApiQuery({ name: 'workspaceId', required: false })
  async findAll(@CurrentUser() user: any, @Query('workspaceId') workspaceId?: string) {
    await this.membershipsService.assertCanAccessWorkspace(user.tenantId, user._id || user.sub, workspaceId);
    return this.dealsService.findAll(user.tenantId, workspaceId);
  }

  @Get('pipeline/summary')
  @ApiOperation({ summary: 'Get pipeline summary with counts and values' })
  @ApiQuery({ name: 'workspaceId', required: false })
  async getPipelineSummary(@CurrentUser() user: any, @Query('workspaceId') workspaceId?: string) {
    await this.membershipsService.assertCanAccessWorkspace(user.tenantId, user._id || user.sub, workspaceId);
    return this.dealsService.getPipelineSummary(user.tenantId, workspaceId);
  }

  @Get('stage/:stage')
  @ApiOperation({ summary: 'Get deals by stage' })
  @ApiQuery({ name: 'stage', enum: DealStage })
  @ApiQuery({ name: 'workspaceId', required: false })
  async findByStage(
    @CurrentUser() user: any,
    @Param('stage') stage: DealStage,
    @Query('workspaceId') workspaceId?: string,
  ) {
    await this.membershipsService.assertCanAccessWorkspace(user.tenantId, user._id || user.sub, workspaceId);
    return this.dealsService.findByStage(user.tenantId, stage, workspaceId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a deal by ID' })
  async findOne(@CurrentUser() user: any, @Param('id') id: string, @Query('workspaceId') workspaceId?: string) {
    await this.membershipsService.assertCanAccessWorkspace(user.tenantId, user._id || user.sub, workspaceId);
    return this.dealsService.findOne(user.tenantId, id, workspaceId);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a deal' })
  async update(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() updateDealDto: UpdateDealDto,
    @Query('workspaceId') workspaceId?: string,
  ) {
    await this.membershipsService.assertCanAccessWorkspace(user.tenantId, user._id || user.sub, workspaceId);
    return this.dealsService.update(user.tenantId, id, updateDealDto, workspaceId);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a deal' })
  async remove(@CurrentUser() user: any, @Param('id') id: string, @Query('workspaceId') workspaceId?: string) {
    await this.membershipsService.assertCanAccessWorkspace(user.tenantId, user._id || user.sub, workspaceId);
    return this.dealsService.remove(user.tenantId, id, workspaceId);
  }
}
