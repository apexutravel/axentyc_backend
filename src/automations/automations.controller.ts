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
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AutomationsService } from './automations.service';
import { CreateAutomationDto } from './dto/create-automation.dto';
import { UpdateAutomationDto } from './dto/update-automation.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { MembershipsService } from '../memberships/memberships.service';

@ApiTags('automations')
@ApiBearerAuth()
@Controller('automations')
export class AutomationsController {
  constructor(
    private readonly automationsService: AutomationsService,
    private readonly membershipsService: MembershipsService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Create a new automation' })
  async create(@CurrentUser() user: any, @Body() dto: CreateAutomationDto) {
    await this.membershipsService.assertCanManageAccount(user.tenantId, user._id || user.sub);
    return this.automationsService.create(user.tenantId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'Get all automations for tenant' })
  async findAll(@CurrentUser() user: any, @Query('workspaceId') workspaceId?: string) {
    await this.membershipsService.assertCanAccessWorkspace(user.tenantId, user._id || user.sub, workspaceId);
    return this.automationsService.findAll(user.tenantId, workspaceId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get an automation by ID' })
  async findOne(@CurrentUser() user: any, @Param('id') id: string, @Query('workspaceId') workspaceId?: string) {
    await this.membershipsService.assertCanAccessWorkspace(user.tenantId, user._id || user.sub, workspaceId);
    return this.automationsService.findOne(user.tenantId, id, workspaceId);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update an automation' })
  async update(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() dto: UpdateAutomationDto,
    @Query('workspaceId') workspaceId?: string,
  ) {
    await this.membershipsService.assertCanManageAccount(user.tenantId, user._id || user.sub);
    return this.automationsService.update(user.tenantId, id, dto, workspaceId);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete an automation' })
  async remove(@CurrentUser() user: any, @Param('id') id: string, @Query('workspaceId') workspaceId?: string) {
    await this.membershipsService.assertCanManageAccount(user.tenantId, user._id || user.sub);
    return this.automationsService.remove(user.tenantId, id, workspaceId);
  }
}
