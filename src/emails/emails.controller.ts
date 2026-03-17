import { Controller, Get, Post, Patch, Delete, Body, Param, Query, Req } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { EmailsService } from './emails.service';
import { SendEmailDto } from './dto/send-email.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@ApiTags('emails')
@ApiBearerAuth()
@Controller('emails')
export class EmailsController {
  constructor(private readonly emailsService: EmailsService) {}

  @Post('send')
  @ApiOperation({ summary: 'Send an email via SMTP' })
  sendEmail(@CurrentUser() user: any, @Body() dto: SendEmailDto) {
    return this.emailsService.sendEmail(user.tenantId, dto);
  }

  @Post('sync')
  @ApiOperation({ summary: 'Sync emails from IMAP server (all folders or a specific one)' })
  async syncEmails(
    @Req() req,
    @Query('folder') folder?: string,
    @Query('limit') limit?: number,
  ) {
    try {
      if (folder) {
        console.log(`[Sync Endpoint] Syncing folder ${folder} for tenant ${req.user.tenantId}`);
        const result = await this.emailsService.syncFolder(req.user.tenantId, folder, limit || 50);
        console.log(`[Sync Endpoint] Success: ${result.synced} emails synced in ${folder}`);
        return result;
      } else {
        console.log(`[Sync Endpoint] Syncing ALL folders for tenant ${req.user.tenantId}`);
        const result = await this.emailsService.syncAllFolders(req.user.tenantId, limit || 50);
        console.log(`[Sync Endpoint] Success: ${result.totalSynced} emails synced across ${result.folders.length} folders`);
        return result;
      }
    } catch (error: any) {
      console.error('[Sync Endpoint] Error:', error.message);
      throw error;
    }
  }

  @Get('folders')
  @ApiOperation({ summary: 'Get all email folders with counts' })
  getFolders(@CurrentUser() user: any) {
    return this.emailsService.getFolders(user.tenantId);
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'Get unread email count for inbox' })
  getUnreadCount(@CurrentUser() user: any) {
    return this.emailsService.getUnreadCount(user.tenantId);
  }

  @Get()
  @ApiOperation({ summary: 'List emails in a folder' })
  listEmails(
    @CurrentUser() user: any,
    @Query('folder') folder?: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.emailsService.listEmails(
      user.tenantId,
      folder || 'INBOX',
      page ? Number(page) : 1,
      limit ? Number(limit) : 50,
    );
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single email by ID' })
  getEmail(@CurrentUser() user: any, @Param('id') id: string) {
    return this.emailsService.getEmail(user.tenantId, id);
  }

  @Patch(':id/read')
  @ApiOperation({ summary: 'Mark email as read/unread' })
  markAsRead(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body('isRead') isRead: boolean,
  ) {
    return this.emailsService.markAsRead(user.tenantId, id, isRead);
  }

  @Post('purge')
  @ApiOperation({ summary: 'Purge all synced emails (forces fresh re-sync)' })
  purgeEmails(@CurrentUser() user: any) {
    return this.emailsService.purgeEmails(user.tenantId);
  }

  @Post('bulk-delete')
  @ApiOperation({ summary: 'Delete multiple emails' })
  bulkDelete(@CurrentUser() user: any, @Body() body: { ids: string[] }) {
    return this.emailsService.bulkDelete(user.tenantId, body.ids);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete an email' })
  deleteEmail(@CurrentUser() user: any, @Param('id') id: string) {
    return this.emailsService.deleteEmail(user.tenantId, id);
  }
}
