import { Controller, Get, Post, Patch, Delete, Body, Param, Query, Req } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { EmailsService } from './emails.service';
import { SendEmailDto } from './dto/send-email.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { MembershipsService } from '../memberships/memberships.service';

/**
 * An agency can link several mailboxes. Most endpoints accept an optional `integrationId`
 * (the mailbox). Without it, listing endpoints return the unified view of all mailboxes and
 * send/sync use the default mailbox / every mailbox respectively.
 */
@ApiTags('emails')
@ApiBearerAuth()
@Controller('emails')
export class EmailsController {
  constructor(
    private readonly emailsService: EmailsService,
    private readonly membershipsService: MembershipsService,
  ) {}

  private async assertAccess(user: any, workspaceId?: string) {
    await this.membershipsService.assertCanAccessWorkspace(user.tenantId, user._id || user.sub, workspaceId);
  }

  @Post('send')
  @ApiOperation({ summary: 'Send an email via SMTP using the chosen (or default) mailbox' })
  async sendEmail(@CurrentUser() user: any, @Body() dto: SendEmailDto) {
    await this.assertAccess(user, dto.workspaceId);
    return this.emailsService.sendEmail(user.tenantId, dto);
  }

  @Post('sync')
  @ApiOperation({ summary: 'Sync emails from IMAP (one mailbox, or all mailboxes when integrationId is omitted)' })
  @ApiQuery({ name: 'integrationId', required: false })
  async syncEmails(
    @Req() req,
    @Query('folder') folder?: string,
    @Query('limit') limit?: number,
    @Query('workspaceId') queryWorkspaceId?: string,
    @Query('integrationId') integrationId?: string,
    @Body('workspaceId') bodyWorkspaceId?: string,
  ) {
    // The web client sends the active workspace in the body of POST requests
    const workspaceId = queryWorkspaceId || bodyWorkspaceId;
    await this.assertAccess(req.user, workspaceId);
    const tenantId = req.user.tenantId;
    const max = limit ? Number(limit) : 50;

    if (folder) {
      return this.emailsService.syncFolder(tenantId, folder, max, integrationId, workspaceId);
    }
    if (integrationId) {
      return this.emailsService.syncAllFolders(tenantId, max, integrationId, workspaceId);
    }
    return this.emailsService.syncAllAccounts(tenantId, max, workspaceId);
  }

  @Get('folders')
  @ApiOperation({ summary: 'Folders of a mailbox, or the unified inbox when integrationId is omitted' })
  @ApiQuery({ name: 'integrationId', required: false })
  async getFolders(
    @CurrentUser() user: any,
    @Query('workspaceId') workspaceId?: string,
    @Query('integrationId') integrationId?: string,
  ) {
    await this.assertAccess(user, workspaceId);
    return this.emailsService.getFolders(user.tenantId, workspaceId, integrationId);
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'Unread inbox emails (all mailboxes, or one with integrationId)' })
  @ApiQuery({ name: 'integrationId', required: false })
  async getUnreadCount(
    @CurrentUser() user: any,
    @Query('workspaceId') workspaceId?: string,
    @Query('integrationId') integrationId?: string,
  ) {
    await this.assertAccess(user, workspaceId);
    return this.emailsService.getUnreadCount(user.tenantId, workspaceId, integrationId);
  }

  @Get()
  @ApiOperation({ summary: 'List emails in a folder (one mailbox, or unified when integrationId is omitted)' })
  @ApiQuery({ name: 'integrationId', required: false })
  async listEmails(
    @CurrentUser() user: any,
    @Query('folder') folder?: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('workspaceId') workspaceId?: string,
    @Query('integrationId') integrationId?: string,
  ) {
    await this.assertAccess(user, workspaceId);
    return this.emailsService.listEmails(
      user.tenantId,
      folder || 'INBOX',
      page ? Number(page) : 1,
      limit ? Number(limit) : 50,
      workspaceId,
      integrationId,
    );
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single email by ID' })
  async getEmail(@CurrentUser() user: any, @Param('id') id: string, @Query('workspaceId') workspaceId?: string) {
    await this.assertAccess(user, workspaceId);
    return this.emailsService.getEmail(user.tenantId, id, workspaceId);
  }

  @Patch(':id/read')
  @ApiOperation({ summary: 'Mark email as read/unread' })
  async markAsRead(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body('isRead') isRead: boolean,
    @Body('workspaceId') workspaceId?: string,
  ) {
    await this.assertAccess(user, workspaceId);
    return this.emailsService.markAsRead(user.tenantId, id, isRead, workspaceId);
  }

  @Post('purge')
  @ApiOperation({ summary: 'Purge synced emails (one mailbox or all) to force a fresh re-sync' })
  async purgeEmails(
    @CurrentUser() user: any,
    @Body('workspaceId') workspaceId?: string,
    @Body('integrationId') integrationId?: string,
  ) {
    await this.assertAccess(user, workspaceId);
    return this.emailsService.purgeEmails(user.tenantId, workspaceId, integrationId);
  }

  @Post('bulk-delete')
  @ApiOperation({ summary: 'Delete multiple emails' })
  async bulkDelete(@CurrentUser() user: any, @Body() body: { ids: string[]; workspaceId?: string }) {
    await this.assertAccess(user, body.workspaceId);
    return this.emailsService.bulkDelete(user.tenantId, body.ids, body.workspaceId);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete an email' })
  async deleteEmail(@CurrentUser() user: any, @Param('id') id: string, @Query('workspaceId') workspaceId?: string) {
    await this.assertAccess(user, workspaceId);
    return this.emailsService.deleteEmail(user.tenantId, id, workspaceId);
  }
}
