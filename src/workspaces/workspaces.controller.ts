import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { WorkspacesService } from './workspaces.service';
import { CreateWorkspaceDto } from './dto/create-workspace.dto';
import { UpdateWorkspaceDto } from './dto/update-workspace.dto';
import { MembershipsService } from '../memberships/memberships.service';
import { AccountRole } from '../memberships/entities/account-member.entity';

@ApiTags('workspaces')
@ApiBearerAuth()
@Controller('workspaces')
export class WorkspacesController {
  constructor(
    private readonly workspacesService: WorkspacesService,
    private readonly membershipsService: MembershipsService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Create a workspace inside the current account' })
  async create(@CurrentUser() user: any, @Body() dto: CreateWorkspaceDto) {
    await this.membershipsService.assertCanManageAccount(user.tenantId, user._id || user.sub);
    const workspace: any = await this.workspacesService.create(user.tenantId, dto);
    // The creator can always operate the workspace they just created
    await this.membershipsService.setWorkspaceAccess({
      tenantId: user.tenantId,
      workspaceId: workspace._id.toString(),
      userId: user._id || user.sub,
      role: AccountRole.OWNER,
      permissions: ['*'],
    });
    return workspace;
  }

  @Get()
  @ApiOperation({ summary: 'List workspaces for the current account' })
  async findAll(@CurrentUser() user: any) {
    return this.workspacesService.findAccessible(user.tenantId, user._id || user.sub);
  }

  @Post('backfill-default')
  @ApiOperation({ summary: 'Assign existing tenant records without workspace to the default workspace' })
  async backfillDefault(@CurrentUser() user: any) {
    await this.membershipsService.assertCanManageAccount(user.tenantId, user._id || user.sub);
    return this.workspacesService.backfillDefaultWorkspace(user.tenantId);
  }

  @Get('availability')
  @ApiOperation({ summary: 'Check whether a workspace name and slug are available' })
  async availability(
    @CurrentUser() user: any,
    @Query('name') name?: string,
    @Query('slug') slug?: string,
    @Query('excludeId') excludeId?: string,
  ) {
    await this.membershipsService.assertCanManageAccount(user.tenantId, user._id || user.sub);
    return this.workspacesService.checkAvailability(user.tenantId, name, slug, excludeId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a workspace by ID' })
  async findOne(@CurrentUser() user: any, @Param('id') id: string) {
    await this.workspacesService.assertUsable(user.tenantId, user._id || user.sub, id);
    return this.workspacesService.findOne(user.tenantId, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a workspace' })
  async update(@CurrentUser() user: any, @Param('id') id: string, @Body() dto: UpdateWorkspaceDto) {
    await this.membershipsService.assertCanManageAccount(user.tenantId, user._id || user.sub);
    return this.workspacesService.update(user.tenantId, id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Deactivate a workspace' })
  async remove(@CurrentUser() user: any, @Param('id') id: string) {
    await this.membershipsService.assertCanManageAccount(user.tenantId, user._id || user.sub);
    return this.workspacesService.remove(user.tenantId, id);
  }
}
