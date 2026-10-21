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
import { LeadsService } from '../services/leads.service';
import { CreateLeadDto } from '../dto/create-lead.dto';
import { UpdateLeadDto } from '../dto/update-lead.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { MembershipsService } from '../../memberships/memberships.service';

@ApiTags('leads')
@ApiBearerAuth()
@Controller('leads')
export class LeadsController {
  constructor(
    private readonly leadsService: LeadsService,
    private readonly membershipsService: MembershipsService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Create a new lead' })
  async create(@CurrentUser() user: any, @Body() createLeadDto: CreateLeadDto) {
    await this.membershipsService.assertCanAccessWorkspace(user.tenantId, user._id || user.sub, createLeadDto.workspaceId);
    return this.leadsService.create(user.tenantId, createLeadDto);
  }

  @Post('bulk-delete')
  @ApiOperation({ summary: 'Delete multiple leads' })
  async bulkDelete(@CurrentUser() user: any, @Body() body: { ids: string[]; workspaceId?: string }) {
    await this.membershipsService.assertCanAccessWorkspace(user.tenantId, user._id || user.sub, body.workspaceId);
    return this.leadsService.bulkDelete(user.tenantId, body.ids, body.workspaceId);
  }

  @Get()
  @ApiOperation({ summary: 'Get all leads for tenant' })
  @ApiQuery({ name: 'workspaceId', required: false })
  async findAll(@CurrentUser() user: any, @Query('workspaceId') workspaceId?: string) {
    await this.membershipsService.assertCanAccessWorkspace(user.tenantId, user._id || user.sub, workspaceId);
    return this.leadsService.findAll(user.tenantId, workspaceId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a lead by ID' })
  async findOne(@CurrentUser() user: any, @Param('id') id: string, @Query('workspaceId') workspaceId?: string) {
    await this.membershipsService.assertCanAccessWorkspace(user.tenantId, user._id || user.sub, workspaceId);
    return this.leadsService.findOne(user.tenantId, id, workspaceId);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a lead' })
  async update(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() updateLeadDto: UpdateLeadDto,
    @Query('workspaceId') workspaceId?: string,
  ) {
    await this.membershipsService.assertCanAccessWorkspace(user.tenantId, user._id || user.sub, workspaceId);
    return this.leadsService.update(user.tenantId, id, updateLeadDto, workspaceId);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a lead' })
  async remove(@CurrentUser() user: any, @Param('id') id: string, @Query('workspaceId') workspaceId?: string) {
    await this.membershipsService.assertCanAccessWorkspace(user.tenantId, user._id || user.sub, workspaceId);
    return this.leadsService.remove(user.tenantId, id, workspaceId);
  }

  @Post(':id/convert')
  @ApiOperation({ summary: 'Convert lead to deal' })
  async convertToDeal(@CurrentUser() user: any, @Param('id') id: string, @Query('workspaceId') workspaceId?: string) {
    await this.membershipsService.assertCanAccessWorkspace(user.tenantId, user._id || user.sub, workspaceId);
    return this.leadsService.convertToDeal(user.tenantId, id, workspaceId);
  }
}
