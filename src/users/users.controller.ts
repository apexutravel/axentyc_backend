import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseInterceptors,
  ClassSerializerInterceptor,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { UsersService } from './users.service';
import { InvitationsService } from './invitations.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { InviteUserDto } from './dto/invite-user.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { ChangeRoleDto } from './dto/change-role.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { MembershipsService } from '../memberships/memberships.service';

@ApiTags('users')
@ApiBearerAuth()
@Controller('users')
@UseInterceptors(ClassSerializerInterceptor)
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly invitationsService: InvitationsService,
    private readonly membershipsService: MembershipsService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Create a new user' })
  create(@Body() createUserDto: CreateUserDto) {
    return this.usersService.create(createUserDto);
  }

  @Get()
  @ApiOperation({ summary: 'Get all users in tenant' })
  findAll(@CurrentUser() user: any) {
    return this.usersService.findByTenant(user.tenantId);
  }

  @Get('invitations')
  @ApiOperation({ summary: 'Get all invitations for tenant' })
  async getInvitations(@CurrentUser() user: any) {
    await this.membershipsService.assertCanManageAccount(user.tenantId, user._id || user.sub);
    return this.invitationsService.findAllByTenant(user.tenantId);
  }

  @Post('invite')
  @ApiOperation({ summary: 'Invite a new user to the tenant' })
  async invite(@CurrentUser() user: any, @Body() inviteDto: InviteUserDto) {
    await this.membershipsService.assertCanManageAccount(user.tenantId, user._id || user.sub);
    return this.invitationsService.create(user.tenantId, user._id || user.sub, inviteDto);
  }

  @Delete('invitations/:id')
  @ApiOperation({ summary: 'Cancel an invitation' })
  async cancelInvitation(@CurrentUser() user: any, @Param('id') id: string) {
    await this.membershipsService.assertCanManageAccount(user.tenantId, user._id || user.sub);
    return this.invitationsService.cancel(user.tenantId, id);
  }

  @Post(':id/change-password')
  @ApiOperation({ summary: 'Change user password (admin only)' })
  async changePassword(@CurrentUser() user: any, @Param('id') id: string, @Body() dto: ChangePasswordDto) {
    await this.membershipsService.assertCanManageAccount(user.tenantId, user._id || user.sub);
    return this.usersService.changePassword(id, dto.newPassword);
  }

  @Patch(':id/role')
  @ApiOperation({ summary: 'Change user role (admin only)' })
  async changeRole(@CurrentUser() user: any, @Param('id') id: string, @Body() dto: ChangeRoleDto) {
    await this.membershipsService.assertCanManageAccount(user.tenantId, user._id || user.sub);
    return this.usersService.changeRole(id, user.tenantId, dto.role);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a user by ID' })
  findOne(@Param('id') id: string) {
    return this.usersService.findOne(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a user' })
  update(@Param('id') id: string, @Body() updateUserDto: UpdateUserDto) {
    return this.usersService.update(id, updateUserDto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a user' })
  remove(@Param('id') id: string) {
    return this.usersService.remove(id);
  }

  @Post('fcm-token')
  @ApiOperation({ summary: 'Register FCM token for push notifications' })
  async registerFCMToken(@CurrentUser() user: any, @Body('token') token: string) {
    await this.usersService.addFCMToken(user._id || user.sub, token);
    return { success: true };
  }

  @Delete('fcm-token')
  @ApiOperation({ summary: 'Unregister FCM token' })
  async unregisterFCMToken(@CurrentUser() user: any, @Body('token') token: string) {
    await this.usersService.removeFCMToken(user._id || user.sub, token);
    return { success: true };
  }
}
