import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { MembershipsService } from './memberships.service';
import { SetWorkspaceAccessDto } from './dto/set-workspace-access.dto';

@ApiTags('memberships')
@ApiBearerAuth()
@Controller('memberships')
export class MembershipsController {
  constructor(private readonly membershipsService: MembershipsService) {}

  @Get('me/accounts')
  @ApiOperation({ summary: 'List accounts the current user belongs to' })
  myAccounts(@CurrentUser() user: any) {
    return this.membershipsService.findAccountsForUser(user._id || user.sub);
  }

  @Get('account/members')
  @ApiOperation({ summary: 'List active members for the current account' })
  async accountMembers(@CurrentUser() user: any) {
    await this.membershipsService.assertCanManageAccount(user.tenantId, user._id || user.sub);
    return this.membershipsService.findAccountMembers(user.tenantId);
  }

  @Get('me/workspaces')
  @ApiOperation({ summary: 'List workspaces the current user can access in this account' })
  myWorkspaces(@CurrentUser() user: any) {
    return this.membershipsService.findWorkspaceAccessForUser(user.tenantId, user._id || user.sub);
  }

  @Get('workspace/members')
  @ApiOperation({ summary: 'List workspace members for the current account' })
  async workspaceMembers(
    @CurrentUser() user: any,
    @Query('workspaceId') workspaceId?: string,
  ) {
    await this.membershipsService.assertCanManageAccount(user.tenantId, user._id || user.sub);
    return this.membershipsService.findWorkspaceMembers(user.tenantId, workspaceId);
  }

  @Post('workspace-access')
  @ApiOperation({ summary: 'Grant or update workspace access for a user' })
  async setWorkspaceAccess(@CurrentUser() user: any, @Body() dto: SetWorkspaceAccessDto) {
    await this.membershipsService.assertCanManageAccount(user.tenantId, user._id || user.sub);
    return this.membershipsService.setWorkspaceAccess({
      tenantId: user.tenantId,
      workspaceId: dto.workspaceId,
      userId: dto.userId,
      role: dto.role,
      permissions: dto.permissions,
    });
  }

  @Delete('workspace-access/:workspaceId/:userId')
  @ApiOperation({ summary: 'Revoke workspace access for a user without deleting the user account' })
  async revokeWorkspaceAccess(
    @CurrentUser() user: any,
    @Param('workspaceId') workspaceId: string,
    @Param('userId') userId: string,
  ) {
    await this.membershipsService.assertCanManageAccount(user.tenantId, user._id || user.sub);
    return this.membershipsService.revokeWorkspaceAccess(user.tenantId, workspaceId, userId);
  }
}
