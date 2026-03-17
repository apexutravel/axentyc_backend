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

@ApiTags('users')
@ApiBearerAuth()
@Controller('users')
@UseInterceptors(ClassSerializerInterceptor)
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly invitationsService: InvitationsService,
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
  getInvitations(@CurrentUser() user: any) {
    return this.invitationsService.findAllByTenant(user.tenantId);
  }

  @Post('invite')
  @ApiOperation({ summary: 'Invite a new user to the tenant' })
  invite(@CurrentUser() user: any, @Body() inviteDto: InviteUserDto) {
    return this.invitationsService.create(user.tenantId, user.sub, inviteDto);
  }

  @Delete('invitations/:id')
  @ApiOperation({ summary: 'Cancel an invitation' })
  cancelInvitation(@CurrentUser() user: any, @Param('id') id: string) {
    return this.invitationsService.cancel(user.tenantId, id);
  }

  @Post(':id/change-password')
  @ApiOperation({ summary: 'Change user password (admin only)' })
  changePassword(@Param('id') id: string, @Body() dto: ChangePasswordDto) {
    return this.usersService.changePassword(id, dto.newPassword);
  }

  @Patch(':id/role')
  @ApiOperation({ summary: 'Change user role (admin only)' })
  changeRole(@CurrentUser() user: any, @Param('id') id: string, @Body() dto: ChangeRoleDto) {
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
    await this.usersService.addFCMToken(user.sub, token);
    return { success: true };
  }

  @Delete('fcm-token')
  @ApiOperation({ summary: 'Unregister FCM token' })
  async unregisterFCMToken(@CurrentUser() user: any, @Body('token') token: string) {
    await this.usersService.removeFCMToken(user.sub, token);
    return { success: true };
  }
}
