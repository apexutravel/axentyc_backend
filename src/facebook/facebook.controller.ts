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
  Req,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { FacebookService } from './facebook.service';
import { SaveFacebookConfigDto } from './dto/save-facebook-config.dto';
import type { Response, Request } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
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
    this.logger.log(`Facebook webhook received: ${body?.object || 'unknown'} with ${Array.isArray(body?.entry) ? body.entry.length : 0} entr${Array.isArray(body?.entry) && body.entry.length === 1 ? 'y' : 'ies'}`);
    this.logger.debug(`Full webhook payload: ${JSON.stringify(body)}`);

    // Verify signature if app secret is configured (log warnings but always process)
    const appSecret = this.configService.get<string>('FACEBOOK_APP_SECRET');
    const signature256 = req.headers['x-hub-signature-256'] as string;
    const signatureSha1 = req.headers['x-hub-signature'] as string;

    if (appSecret) {
      if (!signature256 && !signatureSha1) {
        this.logger.warn('[Webhook] Missing signature headers - processing anyway');
      } else {
        const rawBodyBuf: any = (req as any).rawBody;
        const rawBody = rawBodyBuf ? rawBodyBuf : Buffer.from(JSON.stringify(body));
        
        if (signature256) {
          const expectedSig256 = 'sha256=' + createHmac('sha256', appSecret)
            .update(rawBody)
            .digest('hex');
          const received = Buffer.from(signature256);
          const expected = Buffer.from(expectedSig256);
          if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
            this.logger.warn(`[Webhook] Invalid sha256 signature - expected: ${expectedSig256}, received: ${signature256} - processing anyway`);
          } else {
            this.logger.log('[Webhook] Signature validated successfully (sha256)');
          }
        } else if (signatureSha1) {
          const expectedSigSha1 = 'sha1=' + createHmac('sha1', appSecret)
            .update(rawBody)
            .digest('hex');
          const received = Buffer.from(signatureSha1);
          const expected = Buffer.from(expectedSigSha1);
          if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
            this.logger.warn(`[Webhook] Invalid sha1 signature - expected: ${expectedSigSha1}, received: ${signatureSha1} - processing anyway`);
          } else {
            this.logger.log('[Webhook] Signature validated successfully (sha1)');
          }
        }
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
  @ApiOperation({ summary: 'Check if Facebook integration is available (global app config)' })
  async getFacebookConfig(@CurrentUser() user: any, @Req() req: Request) {
    // Check if global Facebook app is configured in environment
    const isConfigured = !!this.configService.get('FACEBOOK_APP_ID') && !!this.configService.get('FACEBOOK_APP_SECRET');
    
    if (!isConfigured) {
      return { 
        available: false,
        message: 'Facebook integration not configured by administrator'
      };
    }

    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    const host = req.headers['x-forwarded-host'] || req.get('host');
    const prefix = this.configService.get('API_PREFIX') || 'api/v1';
    const webhookUrl = `${protocol}://${host}/${prefix}/webhook/facebook`;

    return {
      available: true,
      webhookUrl,
      verifyToken: this.configService.get('FACEBOOK_VERIFY_TOKEN') || 'axentyc_fb_verify',
    };
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

    const selection = this.facebookService.createPendingPageSelection(user.tenantId, pages);

    return {
      expiresIn: longLived.expiresIn,
      selectionToken: selection.selectionToken,
      pages: selection.pages,
    };
  }

  @Post('integrations/facebook/connect-page')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Connect a Facebook page' })
  async connectPage(
    @CurrentUser() user: any,
    @Body() body: {
      pageId: string;
      selectionToken: string;
    },
  ) {
    const page = this.facebookService.consumePendingPageSelection(
      user.tenantId,
      body.selectionToken,
      body.pageId,
    );

    const account = await this.facebookService.connectPage(
      user.tenantId,
      page.id,
      page.name,
      page.accessToken,
      {
        picture: page.picture,
        category: page.category,
        fanCount: page.fanCount,
        instagramAccount: page.instagramAccount,
      },
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

  @Post('integrations/facebook/resubscribe')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Re-subscribe all connected pages to webhooks (to update subscription fields)' })
  async resubscribePages(@CurrentUser() user: any) {
    const result = await this.facebookService.resubscribeAllPages(user.tenantId);
    return result;
  }

  @Post('integrations/facebook/sync-comments')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Manually sync recent Facebook comments from Graph API (fallback when webhooks fail)' })
  async syncComments(
    @CurrentUser() user: any,
    @Body() body: { pageId?: string },
  ) {
    return this.facebookService.syncCommentsForTenant(user.tenantId, body?.pageId);
  }

  @Get('integrations/facebook/feed')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get recent Facebook page posts with comments (for UI listing)' })
  async getFeed(
    @CurrentUser() user: any,
    @Query('pageId') pageId: string,
    @Query('limit') limit?: string,
  ) {
    if (!pageId) {
      return { success: false, message: 'pageId is required' };
    }
    const lim = limit ? parseInt(limit) : 10;
    return this.facebookService.getPageFeed(user.tenantId, pageId, lim);
  }

  @Post('integrations/facebook/reply-comment')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Reply to a Facebook comment' })
  async replyToComment(
    @CurrentUser() user: any,
    @Body() body: { commentId: string; message: string; pageId?: string; postId?: string },
  ) {
    if (!body.commentId || !body.message) {
      return { success: false, message: 'commentId and message are required' };
    }
    return this.facebookService.replyToComment(
      user.tenantId,
      body.commentId,
      body.message,
      { pageId: body.pageId, postId: body.postId },
    );
  }

  @Post('integrations/facebook/react')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'React to a Facebook post or comment' })
  async reactToObject(
    @CurrentUser() user: any,
    @Body() body: { objectId: string; pageId: string; reactionType: string },
  ) {
    if (!body.objectId || !body.pageId) {
      return { success: false, message: 'objectId and pageId are required' };
    }
    return this.facebookService.reactToObject(
      user.tenantId,
      body.pageId,
      body.objectId,
      body.reactionType || 'LIKE',
    );
  }

  @Post('integrations/facebook/send-direct-message')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Send a direct Facebook Messenger message to a user' })
  async sendDirectMessage(
    @CurrentUser() user: any,
    @Body() body: { pageId: string; recipientPsid: string; message: string },
  ) {
    if (!body.pageId || !body.recipientPsid || !body.message) {
      return { success: false, message: 'pageId, recipientPsid and message are required' };
    }
    return this.facebookService.sendDirectMessage(
      user.tenantId,
      body.pageId,
      body.recipientPsid,
      body.message,
    );
  }

  @Get('integrations/facebook/diagnose-permissions')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Diagnose Facebook page token permissions' })
  async diagnosePermissions(
    @CurrentUser() user: any,
    @Query('pageId') pageId: string,
  ) {
    if (!pageId) {
      return { success: false, message: 'pageId is required' };
    }
    return this.facebookService.diagnoseTokenPermissions(user.tenantId, pageId);
  }

  @Post('integrations/facebook/hide-comment')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Hide/Unhide a Facebook comment' })
  async hideComment(
    @CurrentUser() user: any,
    @Body() body: { commentId: string; pageId: string; hide: boolean },
  ) {
    if (!body.commentId || !body.pageId) {
      return { success: false, message: 'commentId and pageId are required' };
    }
    return this.facebookService.hideComment(user.tenantId, body.pageId, body.commentId, !!body.hide);
  }

  @Post('integrations/facebook/delete-comment')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Delete a Facebook comment' })
  async deleteComment(
    @CurrentUser() user: any,
    @Body() body: { commentId: string; pageId: string },
  ) {
    if (!body.commentId || !body.pageId) {
      return { success: false, message: 'commentId and pageId are required' };
    }
    return this.facebookService.deleteComment(user.tenantId, body.pageId, body.commentId);
  }
}
