import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Param,
  Delete,
  Query,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { IntegrationsService } from './integrations.service';
import { ConnectSocialDto } from './dto/connect-social.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { EmailIntegrationsService } from './email-integrations.service';
import { ConnectEmailDto } from './dto/connect-email.dto';
import { MembershipsService } from '../memberships/memberships.service';

@ApiTags('integrations')
@ApiBearerAuth()
@Controller('integrations')
export class IntegrationsController {
  constructor(
    private readonly integrationsService: IntegrationsService,
    private readonly emailIntegrationsService: EmailIntegrationsService,
    private readonly membershipsService: MembershipsService,
  ) {}

  @Post('connect')
  @ApiOperation({ summary: 'Connect a social media account' })
  async connect(@CurrentUser() user: any, @Body() dto: ConnectSocialDto) {
    await this.membershipsService.assertCanManageAccount(user.tenantId, user._id || user.sub);
    return this.integrationsService.connect(user.tenantId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'Get all connected social accounts' })
  @ApiQuery({ name: 'workspaceId', required: false })
  async findAll(@CurrentUser() user: any, @Query('workspaceId') workspaceId?: string) {
    await this.membershipsService.assertCanAccessWorkspace(user.tenantId, user._id || user.sub, workspaceId);
    return this.integrationsService.findAll(user.tenantId, workspaceId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a social account by ID' })
  async findOne(@CurrentUser() user: any, @Param('id') id: string) {
    await this.membershipsService.assertCanManageAccount(user.tenantId, user._id || user.sub);
    return this.integrationsService.findOne(user.tenantId, id);
  }

  @Post(':id/disconnect')
  @ApiOperation({ summary: 'Disconnect a social media account' })
  async disconnect(@CurrentUser() user: any, @Param('id') id: string) {
    await this.membershipsService.assertCanManageAccount(user.tenantId, user._id || user.sub);
    return this.integrationsService.disconnect(user.tenantId, id);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Remove a social media account' })
  async remove(@CurrentUser() user: any, @Param('id') id: string) {
    await this.membershipsService.assertCanManageAccount(user.tenantId, user._id || user.sub);
    return this.integrationsService.remove(user.tenantId, id);
  }

  // --- Email Integration: multiple mailboxes per agency (tenant) ---
  // NOTE: the segment count of every `email/...` route differs from the generic `:id` routes
  // above (`:id`, `:id/disconnect`), so they never shadow each other.

  @Post('email/test')
  @ApiOperation({ summary: 'Test email connection (SMTP and IMAP)' })
  async testEmail(@CurrentUser() user: any, @Body() dto: ConnectEmailDto) {
    await this.membershipsService.assertCanManageAccount(user.tenantId, user._id || user.sub);
    return this.emailIntegrationsService.testConnection(user.tenantId, dto);
  }

  @Post('email/test-smtp')
  @ApiOperation({ summary: 'Test SMTP connection only' })
  async testSmtpOnly(@CurrentUser() user: any, @Body() dto: ConnectEmailDto) {
    await this.membershipsService.assertCanManageAccount(user.tenantId, user._id || user.sub);
    return this.emailIntegrationsService.testSmtpOnly(user.tenantId, dto);
  }

  @Post('email/test-imap')
  @ApiOperation({ summary: 'Test IMAP connection only' })
  async testImapOnly(@CurrentUser() user: any, @Body() dto: ConnectEmailDto) {
    await this.membershipsService.assertCanManageAccount(user.tenantId, user._id || user.sub);
    return this.emailIntegrationsService.testImapOnly(user.tenantId, dto);
  }

  @Get('email/accounts')
  @ApiOperation({ summary: 'List the mailboxes linked to the agency' })
  @ApiQuery({ name: 'workspaceId', required: false })
  async listEmailAccounts(@CurrentUser() user: any, @Query('workspaceId') workspaceId?: string) {
    await this.membershipsService.assertCanAccessWorkspace(user.tenantId, user._id || user.sub, workspaceId);
    return this.emailIntegrationsService.list(user.tenantId, workspaceId);
  }

  @Post('email/accounts')
  @ApiOperation({ summary: 'Link a new mailbox (SMTP/IMAP) to the agency' })
  async createEmailAccount(@CurrentUser() user: any, @Body() dto: ConnectEmailDto) {
    await this.membershipsService.assertCanManageAccount(user.tenantId, user._id || user.sub);
    return this.emailIntegrationsService.connect(user.tenantId, { ...dto, integrationId: undefined });
  }

  @Put('email/accounts/:id')
  @ApiOperation({ summary: 'Update (and re-verify) a linked mailbox' })
  async updateEmailAccount(@CurrentUser() user: any, @Param('id') id: string, @Body() dto: ConnectEmailDto) {
    await this.membershipsService.assertCanManageAccount(user.tenantId, user._id || user.sub);
    return this.emailIntegrationsService.connect(user.tenantId, { ...dto, integrationId: id });
  }

  @Post('email/accounts/:id/test')
  @ApiOperation({ summary: 'Test a saved mailbox with its stored credentials' })
  async testEmailAccount(@CurrentUser() user: any, @Param('id') id: string, @Body('workspaceId') workspaceId?: string) {
    await this.membershipsService.assertCanManageAccount(user.tenantId, user._id || user.sub);
    return this.emailIntegrationsService.testStored(user.tenantId, id, workspaceId);
  }

  @Post('email/accounts/:id/default')
  @ApiOperation({ summary: 'Set a mailbox as the default sender / inbox' })
  async setDefaultEmailAccount(@CurrentUser() user: any, @Param('id') id: string, @Body('workspaceId') workspaceId?: string) {
    await this.membershipsService.assertCanManageAccount(user.tenantId, user._id || user.sub);
    return this.emailIntegrationsService.setDefault(user.tenantId, id, workspaceId);
  }

  @Post('email/accounts/:id/disconnect')
  @ApiOperation({ summary: 'Disconnect a mailbox (keeps its settings and cached mail)' })
  async disconnectEmailAccount(@CurrentUser() user: any, @Param('id') id: string, @Body('workspaceId') workspaceId?: string) {
    await this.membershipsService.assertCanManageAccount(user.tenantId, user._id || user.sub);
    return this.emailIntegrationsService.disconnect(user.tenantId, id, workspaceId);
  }

  @Delete('email/accounts/:id')
  @ApiOperation({ summary: 'Remove a mailbox and its cached messages' })
  async removeEmailAccount(@CurrentUser() user: any, @Param('id') id: string, @Query('workspaceId') workspaceId?: string) {
    await this.membershipsService.assertCanManageAccount(user.tenantId, user._id || user.sub);
    return this.emailIntegrationsService.remove(user.tenantId, id, workspaceId);
  }
}
