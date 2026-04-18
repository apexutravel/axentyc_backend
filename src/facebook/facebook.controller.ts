import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Query,
  Param,
  Res,
  HttpCode,
  Logger,
  RawBodyRequest,
  Req,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { FacebookService } from './facebook.service';
import { SaveFacebookConfigDto } from './dto/save-facebook-config.dto';
import type { Response, Request } from 'express';
import { createHmac } from 'crypto';
import { ConfigService } from '@nestjs/config';

@ApiTags('facebook')
@Controller()
export class FacebookController {
  private readonly logger = new Logger(FacebookController.name);

  constructor(
    private readonly facebookService: FacebookService,
    private readonly configService: ConfigService,
  ) {}

  // ═══════════════ PUBLIC WEBHOOK ENDPOINTS ═══════════════

  @Public()
  @Get('webhook/facebook')
  @ApiOperation({ summary: 'Facebook webhook verification (GET challenge)' })
  async verifyWebhook(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
    @Res() res: Response,
  ) {
    try {
      const result = await this.facebookService.verifyWebhook(mode, token, challenge);
      return res.status(200).send(result);
    } catch {
      return res.status(403).send('Verification failed');
    }
  }

  @Public()
  @Post('webhook/facebook')
  @HttpCode(200)
  @ApiOperation({ summary: 'Facebook webhook handler (receive messages)' })
  async handleWebhook(
    @Body() body: any,
    @Req() req: Request,
  ) {
    // Verify signature if app secret is configured
    const appSecret = this.configService.get<string>('FACEBOOK_APP_SECRET');
    const signature = req.headers['x-hub-signature-256'] as string;

    if (appSecret && signature) {
      const rawBody = JSON.stringify(body);
      const expectedSig = 'sha256=' + createHmac('sha256', appSecret)
        .update(rawBody)
        .digest('hex');

      if (signature !== expectedSig) {
        this.logger.warn('Invalid webhook signature');
        return { status: 'invalid_signature' };
      }
    }

    // Process async to not block the response
    this.facebookService.handleWebhook(body).catch((err) => {
      this.logger.error('Error handling Facebook webhook:', err);
    });

    return { status: 'ok' };
  }

  // ═══════════════ AUTHENTICATED INTEGRATION ENDPOINTS ═══════════════

  @Post('integrations/facebook/config')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Save Facebook App credentials' })
  async saveFacebookConfig(
    @CurrentUser() user: any,
    @Body() dto: SaveFacebookConfigDto,
  ) {
    const config = await this.facebookService.saveFacebookConfig(
      user.tenantId,
      dto.appId,
      dto.appSecret,
      dto.verifyToken,
    );
    return { success: true, config: { appId: config.appId, verifyToken: config.verifyToken } };
  }

  @Get('integrations/facebook/config')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get Facebook App configuration' })
  async getFacebookConfig(@CurrentUser() user: any, @Req() req: Request) {
    const config = await this.facebookService.getFacebookConfig(user.tenantId);
    if (!config) {
      return { exists: false };
    }

    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    const host = req.headers['x-forwarded-host'] || req.get('host');
    const prefix = this.configService.get('API_PREFIX') || 'api/v1';
    const webhookUrl = `${protocol}://${host}/${prefix}/webhook/facebook`;

    return {
      exists: true,
      appId: config.appId,
      verifyToken: config.verifyToken,
      webhookUrl,
    };
  }

  @Get('integrations/facebook/debug-config')
  @ApiBearerAuth()
  @ApiOperation({ summary: '[DEBUG] Check stored Facebook config (remove in production)' })
  async debugFacebookConfig(@CurrentUser() user: any) {
    const config = await this.facebookService.getFacebookConfig(user.tenantId);
    if (!config) {
      return { exists: false };
    }
    const secret = config.appSecret || '';
    return {
      exists: true,
      appId: config.appId,
      secretLength: secret.length,
      secretFull: secret,
      secretHasBullets: secret.includes('•'),
      verifyToken: config.verifyToken,
      isActive: config.isActive,
    };
  }

  @Get('integrations/facebook/test-pages')
  @ApiBearerAuth()
  @ApiOperation({ summary: '[DEBUG] Test fetching pages with a user token' })
  async testFetchPages(@CurrentUser() user: any, @Query('token') userToken: string) {
    if (!userToken) {
      return { error: 'Provide ?token=YOUR_USER_ACCESS_TOKEN' };
    }

    try {
      const pages = await this.facebookService.getUserPages(userToken);
      return {
        success: true,
        pagesCount: pages.length,
        pages,
        message: pages.length === 0 
          ? 'Facebook returned 0 pages. The user may not be admin of any page, or pages were not selected during OAuth.'
          : `Found ${pages.length} page(s)`,
      };
    } catch (e: any) {
      return {
        success: false,
        error: e.message,
        details: e.response?.data || e,
      };
    }
  }

  @Delete('integrations/facebook/config')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Delete Facebook App configuration' })
  async deleteFacebookConfig(@CurrentUser() user: any) {
    await this.facebookService.deleteFacebookConfig(user.tenantId);
    return { success: true };
  }

  @Get('integrations/facebook/oauth-url')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get Facebook OAuth URL' })
  async getOAuthUrl(
    @CurrentUser() user: any,
    @Query('redirect_uri') redirectUri: string,
  ) {
    if (!redirectUri) {
      return { error: 'redirect_uri is required' };
    }
    const url = await this.facebookService.getOAuthUrl(user.tenantId, redirectUri);
    if (!url) {
      return { error: 'Facebook App not configured. Please add your App ID and Secret first.' };
    }
    return { url };
  }

  @Post('integrations/facebook/exchange-token')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Exchange OAuth code for access token' })
  async exchangeToken(
    @CurrentUser() user: any,
    @Body() body: { code: string; redirectUri: string },
  ) {
    const { accessToken } = await this.facebookService.exchangeCodeForToken(
      user.tenantId,
      body.code,
      body.redirectUri,
    );

    // Get long-lived token
    const longLived = await this.facebookService.getLongLivedToken(user.tenantId, accessToken);

    // Get pages
    const pages = await this.facebookService.getUserPages(longLived.accessToken);

    return {
      userAccessToken: longLived.accessToken,
      expiresIn: longLived.expiresIn,
      pages,
    };
  }

  @Post('integrations/facebook/connect-page')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Connect a Facebook page' })
  async connectPage(
    @CurrentUser() user: any,
    @Body() body: {
      pageId: string;
      pageName: string;
      pageAccessToken: string;
      picture?: string;
      category?: string;
    },
  ) {
    const account = await this.facebookService.connectPage(
      user.tenantId,
      body.pageId,
      body.pageName,
      body.pageAccessToken,
      { picture: body.picture, category: body.category },
    );

    return { success: true, account };
  }

  @Get('integrations/facebook/status')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get Facebook integration status' })
  async getStatus(@CurrentUser() user: any) {
    return this.facebookService.getStatus(user.tenantId);
  }

  @Post('integrations/facebook/disconnect/:id')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Disconnect a Facebook page' })
  async disconnect(
    @CurrentUser() user: any,
    @Param('id') id: string,
  ) {
    await this.facebookService.disconnect(user.tenantId, id);
    return { success: true };
  }

  @Post('integrations/facebook/send-message')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Send a message via Facebook Messenger' })
  async sendMessage(
    @CurrentUser() user: any,
    @Body() body: {
      conversationId: string;
      content: string;
      media?: { url: string; mimeType?: string };
    },
  ) {
    const sent = await this.facebookService.sendMessage(
      user.tenantId,
      body.conversationId,
      body.content,
      body.media,
    );

    return { success: sent };
  }
}
