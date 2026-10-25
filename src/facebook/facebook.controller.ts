import { SkipThrottle } from '@nestjs/throttler';
import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  Param,
  Res,
  HttpCode,
  Logger,
  Req,
  ForbiddenException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { FacebookService } from './facebook.service';
import type { Response, Request } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { MetaDataDeletionService } from './meta-data-deletion.service';
import { MembershipsService } from '../memberships/memberships.service';

@ApiTags('facebook')
@Controller()
export class FacebookController {
  private readonly logger = new Logger(FacebookController.name);

  constructor(
    private readonly facebookService: FacebookService,
    private readonly configService: ConfigService,
    private readonly membershipsService: MembershipsService,
    private readonly dataDeletion: MetaDataDeletionService,
  ) {}

  private async assertCanManage(user: any): Promise<void> {
    await this.membershipsService.assertCanManageAccount(
      user.tenantId,
      user._id || user.sub,
    );
  }

  private stripSecrets(account: any) {
    const obj = account?.toObject ? account.toObject() : { ...account };
    delete obj.accessToken;
    delete obj.refreshToken;
    delete obj.webhookSecret;
    return obj;
  }

  // ═══════════════ PUBLIC WEBHOOK ENDPOINTS ═══════════════

  @Public()
  @SkipThrottle()
  @Get('webhook/facebook')
  @ApiOperation({ summary: 'Facebook webhook verification (GET challenge)' })
  async verifyWebhook(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
    @Res() res: Response,
  ) {
    try {
      const result = await this.facebookService.verifyWebhook(
        mode,
        token,
        challenge,
      );
      return res.status(200).send(result);
    } catch {
      return res.status(403).send('Verification failed');
    }
  }

  @Public()
  @Post('webhook/facebook/data-deletion')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Meta Data Deletion Request Callback (signed_request)',
  })
  async metaDataDeletion(@Body('signed_request') signedRequest: string) {
    return this.dataDeletion.handleCallback(signedRequest);
  }

  @Public()
  @Get('webhook/facebook/data-deletion/:code')
  @ApiOperation({ summary: 'Status of a data deletion request' })
  async metaDataDeletionStatus(@Param('code') code: string) {
    return this.dataDeletion.status(code);
  }

  @Public()
  @SkipThrottle()
  @Post('webhook/facebook')
  @HttpCode(200)
  @ApiOperation({ summary: 'Facebook webhook handler (receive messages)' })
  async handleWebhook(@Body() body: any, @Req() req: Request) {
    // Signature verification is mandatory: reject anything not signed by Meta with our app secret
    const appSecret = this.configService.get<string>('FACEBOOK_APP_SECRET');
    if (!appSecret) {
      this.logger.error(
        '[Webhook] FACEBOOK_APP_SECRET is not configured - rejecting webhook',
      );
      throw new ForbiddenException('Webhook not configured');
    }

    const signature256 = req.headers['x-hub-signature-256'] as
      | string
      | undefined;
    const signatureSha1 = req.headers['x-hub-signature'] as string | undefined;
    const rawBody: Buffer | undefined = (req as any).rawBody;

    if (!rawBody || (!signature256 && !signatureSha1)) {
      this.logger.warn('[Webhook] Missing signature or raw body - rejecting');
      throw new ForbiddenException('Invalid signature');
    }

    const algo = signature256 ? 'sha256' : 'sha1';
    const received = (signature256 || signatureSha1) as string;
    const expected =
      `${algo}=` + createHmac(algo, appSecret).update(rawBody).digest('hex');
    const receivedBuf = Buffer.from(received);
    const expectedBuf = Buffer.from(expected);
    if (
      receivedBuf.length !== expectedBuf.length ||
      !timingSafeEqual(receivedBuf, expectedBuf)
    ) {
      this.logger.warn(`[Webhook] Invalid ${algo} signature - rejecting`);
      throw new ForbiddenException('Invalid signature');
    }

    this.logger.log(
      `Facebook webhook received: ${body?.object || 'unknown'} with ${Array.isArray(body?.entry) ? body.entry.length : 0} entr${Array.isArray(body?.entry) && body.entry.length === 1 ? 'y' : 'ies'}`,
    );
    this.logger.debug(`Full webhook payload: ${JSON.stringify(body)}`);

    // Process async to not block the response
    this.facebookService.handleWebhook(body).catch((err) => {
      this.logger.error('Error handling Facebook webhook:', err);
    });

    return { status: 'ok' };
  }

  // ═══════════════ AUTHENTICATED INTEGRATION ENDPOINTS ═══════════════

  @Get('integrations/facebook/config')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Check if Facebook integration is available (global app config)',
  })
  async getFacebookConfig(@CurrentUser() user: any, @Req() req: Request) {
    // Check if global Facebook app is configured in environment
    const isConfigured =
      !!this.configService.get('FACEBOOK_APP_ID') &&
      !!this.configService.get('FACEBOOK_APP_SECRET');

    if (!isConfigured) {
      return {
        available: false,
        message: 'Facebook integration not configured by administrator',
      };
    }

    const protocol =
      req.headers['x-forwarded-proto'] || req.protocol || 'https';
    const host = req.headers['x-forwarded-host'] || req.get('host');
    const prefix = this.configService.get('API_PREFIX') || 'api/v1';
    const webhookUrl = `${protocol}://${host}/${prefix}/webhook/facebook`;

    return {
      available: true,
      webhookUrl,
    };
  }

  @Get('integrations/facebook/oauth-url')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get Facebook OAuth URL' })
  async getOAuthUrl(
    @CurrentUser() user: any,
    @Query('redirect_uri') redirectUri: string,
  ) {
    await this.assertCanManage(user);
    if (!redirectUri) {
      return { error: 'redirect_uri is required' };
    }
    const url = await this.facebookService.getOAuthUrl(
      user.tenantId,
      user._id || user.sub,
      redirectUri,
    );
    if (!url) {
      return {
        error:
          'Facebook App not configured. Please add your App ID and Secret first.',
      };
    }
    return { url };
  }

  @Post('integrations/facebook/exchange-token')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Exchange OAuth code for access token' })
  async exchangeToken(
    @CurrentUser() user: any,
    @Body() body: { code: string; redirectUri: string; state?: string },
  ) {
    await this.assertCanManage(user);
    this.facebookService.verifyOAuthState(
      body.state,
      user.tenantId,
      user._id || user.sub,
    );

    const { accessToken } = await this.facebookService.exchangeCodeForToken(
      user.tenantId,
      body.code,
      body.redirectUri,
    );

    // Get long-lived token
    const longLived = await this.facebookService.getLongLivedToken(
      user.tenantId,
      accessToken,
    );

    // Get pages
    const pages = await this.facebookService.getUserPages(
      longLived.accessToken,
    );

    const selection = this.facebookService.createPendingPageSelection(
      user.tenantId,
      pages,
    );

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
    @Body()
    body: {
      pageId: string;
      selectionToken: string;
      workspaceId?: string;
    },
  ) {
    await this.assertCanManage(user);
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
        fbUserId: page.fbUserId,
      },
      body.workspaceId,
    );
    this.facebookService.discardPendingPageSelection(body.selectionToken);

    const instagram = await this.facebookService.getInstagramLinkStatus(
      user.tenantId,
      page.instagramAccount?.id,
    );

    return { success: true, account: this.stripSecrets(account), instagram };
  }

  @Get('integrations/facebook/status')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get Facebook integration status' })
  async getStatus(
    @CurrentUser() user: any,
    @Query('workspaceId') workspaceId?: string,
  ) {
    return this.facebookService.getStatus(user.tenantId, workspaceId);
  }

  @Post('integrations/facebook/disconnect/:id')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Disconnect a Facebook page' })
  async disconnect(@CurrentUser() user: any, @Param('id') id: string) {
    await this.assertCanManage(user);
    await this.facebookService.disconnect(user.tenantId, id);
    return { success: true };
  }

  @Post('integrations/facebook/send-message')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Send a message via Facebook Messenger' })
  async sendMessage(
    @CurrentUser() user: any,
    @Body()
    body: {
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
  @ApiOperation({
    summary:
      'Re-subscribe all connected pages to webhooks (to update subscription fields)',
  })
  async resubscribePages(@CurrentUser() user: any) {
    await this.assertCanManage(user);
    const result = await this.facebookService.resubscribeAllPages(
      user.tenantId,
    );
    return result;
  }

  @Post('integrations/facebook/sync-comments')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Manually sync recent Facebook comments from Graph API (fallback when webhooks fail)',
  })
  async syncComments(
    @CurrentUser() user: any,
    @Body() body: { pageId?: string },
  ) {
    return this.facebookService.syncCommentsForTenant(
      user.tenantId,
      body?.pageId,
    );
  }

  @Get('integrations/facebook/feed')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get recent Facebook page posts with comments (for UI listing)',
  })
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
    @Body()
    body: {
      commentId: string;
      message: string;
      pageId?: string;
      postId?: string;
    },
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
  @ApiOperation({
    summary: 'Send a direct Facebook Messenger message to a user',
  })
  async sendDirectMessage(
    @CurrentUser() user: any,
    @Body() body: { pageId: string; recipientPsid: string; message: string },
  ) {
    if (!body.pageId || !body.recipientPsid || !body.message) {
      return {
        success: false,
        message: 'pageId, recipientPsid and message are required',
      };
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
    return this.facebookService.hideComment(
      user.tenantId,
      body.pageId,
      body.commentId,
      !!body.hide,
    );
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
    return this.facebookService.deleteComment(
      user.tenantId,
      body.pageId,
      body.commentId,
    );
  }

  @Get('integrations/instagram/feed')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Recent Instagram posts with their comments (live from Graph API)',
  })
  async getInstagramFeed(
    @CurrentUser() user: any,
    @Query('accountId') accountId: string,
    @Query('limit') limit?: string,
  ) {
    if (!accountId) return { success: false, message: 'accountId is required' };
    const parsed = limit ? parseInt(limit, 10) : 20;
    return this.facebookService.getInstagramFeed(
      user.tenantId,
      accountId,
      Number.isFinite(parsed) ? parsed : 20,
    );
  }

  @Post('integrations/instagram/reply-comment')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Reply to an Instagram comment, or comment on a post (mediaId)',
  })
  async replyInstagramComment(
    @CurrentUser() user: any,
    @Body()
    body: {
      accountId: string;
      message: string;
      commentId?: string;
      mediaId?: string;
    },
  ) {
    if (!body?.accountId || !body?.message) {
      return { success: false, message: 'accountId and message are required' };
    }
    return this.facebookService.replyToInstagramComment(
      user.tenantId,
      body.accountId,
      body.message,
      { commentId: body.commentId, mediaId: body.mediaId },
    );
  }

  @Post('integrations/instagram/hide-comment')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Hide/unhide an Instagram comment' })
  async hideInstagramComment(
    @CurrentUser() user: any,
    @Body() body: { accountId: string; commentId: string; hide: boolean },
  ) {
    if (!body?.accountId || !body?.commentId) {
      return { success: false, message: 'accountId and commentId are required' };
    }
    return this.facebookService.hideInstagramComment(
      user.tenantId,
      body.accountId,
      body.commentId,
      !!body.hide,
    );
  }

  @Post('integrations/instagram/delete-comment')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Delete an Instagram comment' })
  async deleteInstagramComment(
    @CurrentUser() user: any,
    @Body() body: { accountId: string; commentId: string },
  ) {
    if (!body?.accountId || !body?.commentId) {
      return { success: false, message: 'accountId and commentId are required' };
    }
    return this.facebookService.deleteInstagramComment(
      user.tenantId,
      body.accountId,
      body.commentId,
    );
  }

  @Get('integrations/instagram/diagnose')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Diagnose Instagram connection status' })
  async diagnoseInstagram(@CurrentUser() user: any) {
    await this.assertCanManage(user);
    return this.facebookService.diagnoseInstagram(user.tenantId);
  }

  @Post('integrations/instagram/sync-messages')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Sync Instagram DMs from Graph API (polling fallback)',
  })
  async syncInstagramMessages(@CurrentUser() user: any) {
    const result = await this.facebookService.syncInstagramMessages(
      user.tenantId,
    );
    return { success: true, ...result };
  }

  @Post('integrations/instagram/resubscribe-webhook')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Re-subscribe Instagram account to webhooks' })
  async resubscribeInstagramWebhook(@CurrentUser() user: any) {
    await this.assertCanManage(user);
    return this.facebookService.resubscribeInstagramWebhook(user.tenantId);
  }
}
