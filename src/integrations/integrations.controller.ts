import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Delete,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { IntegrationsService } from './integrations.service';
import { ConnectSocialDto } from './dto/connect-social.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { EmailIntegrationsService } from './email-integrations.service';
import { ConnectEmailDto } from './dto/connect-email.dto';

@ApiTags('integrations')
@ApiBearerAuth()
@Controller('integrations')
export class IntegrationsController {
  constructor(
    private readonly integrationsService: IntegrationsService,
    private readonly emailIntegrationsService: EmailIntegrationsService,
  ) {}

  @Post('connect')
  @ApiOperation({ summary: 'Connect a social media account' })
  connect(@CurrentUser() user: any, @Body() dto: ConnectSocialDto) {
    return this.integrationsService.connect(user.tenantId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'Get all connected social accounts' })
  findAll(@CurrentUser() user: any) {
    return this.integrationsService.findAll(user.tenantId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a social account by ID' })
  findOne(@CurrentUser() user: any, @Param('id') id: string) {
    return this.integrationsService.findOne(user.tenantId, id);
  }

  @Post(':id/disconnect')
  @ApiOperation({ summary: 'Disconnect a social media account' })
  disconnect(@CurrentUser() user: any, @Param('id') id: string) {
    return this.integrationsService.disconnect(user.tenantId, id);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Remove a social media account' })
  remove(@CurrentUser() user: any, @Param('id') id: string) {
    return this.integrationsService.remove(user.tenantId, id);
  }

  // --- Email Integration (Tenant-scoped) ---

  @Post('email/test')
  @ApiOperation({ summary: 'Test email connection (SMTP and IMAP)' })
  testEmail(@CurrentUser() user: any, @Body() dto: ConnectEmailDto) {
    return this.emailIntegrationsService.testConnection(user.tenantId, dto);
  }

  @Post('email/test-smtp')
  @ApiOperation({ summary: 'Test SMTP connection only' })
  async testSmtpOnly(@CurrentUser() user: any, @Body() dto: ConnectEmailDto) {
    const result = await this.emailIntegrationsService['testSmtp'](dto);
    return { smtp: result };
  }

  @Post('email/test-imap')
  @ApiOperation({ summary: 'Test IMAP connection only' })
  async testImapOnly(@CurrentUser() user: any, @Body() dto: ConnectEmailDto) {
    const result = await this.emailIntegrationsService['testImap'](dto);
    return { imap: result };
  }

  @Post('email/connect')
  @ApiOperation({ summary: 'Connect and save email integration (SMTP/IMAP) for tenant' })
  connectEmail(@CurrentUser() user: any, @Body() dto: ConnectEmailDto) {
    return this.emailIntegrationsService.connect(user.tenantId, dto);
  }

  @Get('email/status')
  @ApiOperation({ summary: 'Get email integration status' })
  getEmailStatus(@CurrentUser() user: any) {
    return this.emailIntegrationsService.status(user.tenantId);
  }

  @Get('email/debug')
  @ApiOperation({ summary: 'Debug email configuration (no passwords)' })
  async debugEmailConfig(@CurrentUser() user: any) {
    const { Types } = require('mongoose');
    const config = await this.emailIntegrationsService['emailModel'].findOne({
      tenantId: new Types.ObjectId(user.tenantId),
    });
    if (!config) {
      return { error: 'No email configuration found', tenantId: user.tenantId };
    }
    
    // Test password decryption
    let smtpPassDecrypted = false;
    let imapPassDecrypted = false;
    let smtpPassLength = 0;
    let imapPassLength = 0;
    
    try {
      const smtpPass = this.emailIntegrationsService['decryptSecret'](config.smtp?.passEnc);
      smtpPassDecrypted = true;
      smtpPassLength = smtpPass?.length || 0;
    } catch (e) {
      smtpPassDecrypted = false;
    }
    
    try {
      const imapPass = this.emailIntegrationsService['decryptSecret'](config.imap?.passEnc);
      imapPassDecrypted = true;
      imapPassLength = imapPass?.length || 0;
    } catch (e) {
      imapPassDecrypted = false;
    }
    
    return {
      smtp: {
        host: config.smtp?.host,
        port: config.smtp?.port,
        secure: config.smtp?.secure,
        user: config.smtp?.user,
        hasPassword: !!config.smtp?.passEnc,
        passwordDecrypts: smtpPassDecrypted,
        passwordLength: smtpPassLength,
      },
      imap: {
        host: config.imap?.host,
        port: config.imap?.port,
        secure: config.imap?.secure,
        user: config.imap?.user,
        hasPassword: !!config.imap?.passEnc,
        passwordDecrypts: imapPassDecrypted,
        passwordLength: imapPassLength,
      },
      status: config.status,
    };
  }

  @Post('email/disconnect')
  @ApiOperation({ summary: 'Disconnect email integration for tenant' })
  disconnectEmail(@CurrentUser() user: any) {
    return this.emailIntegrationsService.disconnect(user.tenantId);
  }
}
