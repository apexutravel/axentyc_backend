import { Controller, Get, Post, Put, Body, Param, Query, Req } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import type { Request } from 'express';
import { ChatWidgetService } from './chat-widget.service';
import { UpdateWidgetConfigDto } from './dto/update-widget-config.dto';
import { WidgetMessageDto } from './dto/widget-message.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';

@ApiTags('chat-widget')
@Controller('chat-widget')
export class ChatWidgetController {
  constructor(private readonly chatWidgetService: ChatWidgetService) {}

  @Get()
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get widget configuration (returns null if not configured)' })
  async getConfig(@CurrentUser() user: any) {
    const config = await this.chatWidgetService.getWidgetConfigOrNull(user.tenantId);
    if (!config) return { exists: false };
    
    const plain = (config as any).toObject ? (config as any).toObject() : config;
    const { _id, __v, createdAt, updatedAt, tenantId, ...cleanConfig } = plain;
    
    return { 
      exists: true,
      ...cleanConfig
    };
  }

  @Post('save')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create or update widget configuration' })
  async save(
    @CurrentUser() user: any,
    @Body() dto: UpdateWidgetConfigDto,
  ) {
    return this.chatWidgetService.saveWidgetConfig(user.tenantId, dto);
  }

  @Post('regenerate')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Regenerate widget ID' })
  regenerate(@CurrentUser() user: any) {
    return this.chatWidgetService.regenerateWidgetId(user.tenantId);
  }

  @Get('script')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get widget embed script' })
  async getScript(@CurrentUser() user: any) {
    const config = await this.chatWidgetService.getWidgetConfigOrNull(user.tenantId);
    if (!config) {
      return { script: null, widgetId: null };
    }
    
    return {
      script: this.chatWidgetService.getWidgetScript(config.widgetId),
      widgetId: config.widgetId,
    };
  }

  @Public()
  @Get('config/:widgetId')
  @ApiOperation({ summary: 'Get public widget configuration' })
  async getPublicConfig(@Param('widgetId') widgetId: string) {
    const config = await this.chatWidgetService.getWidgetConfigByWidgetId(widgetId);
    
    const response = {
      widgetId: config.widgetId,
      enabled: config.enabled,
      welcomeMessage: config.welcomeMessage,
      title: config.title,
      subtitle: config.subtitle,
      primaryColor: config.primaryColor,
      textColor: config.textColor,
      position: config.position,
      avatarUrl: config.avatarUrl,
      showBranding: config.showBranding,
      collectEmail: config.collectEmail,
      collectPhone: config.collectPhone,
      offlineMessage: config.offlineMessage,
      customCSS: config.customCSS,
    };
    
    return response;
  }

  @Public()
  @Post('message')
  @ApiOperation({ summary: 'Send message from widget' })
  async sendMessage(@Body() messageDto: WidgetMessageDto) {
    return this.chatWidgetService.handleWidgetMessage(
      messageDto.widgetId,
      messageDto.message,
      messageDto.visitorId || `visitor_${Date.now()}`,
      messageDto.type,
      messageDto.media,
      {
        name: messageDto.visitorName,
        email: messageDto.visitorEmail,
        phone: messageDto.visitorPhone,
        metadata: messageDto.metadata,
      },
    );
  }

  @Public()
  @Get('messages/:widgetId')
  @ApiOperation({ summary: 'Get widget conversation messages' })
  async getMessages(
    @Param('widgetId') widgetId: string,
    @Query('visitorId') visitorId: string,
    @Req() req: Request,
  ) {
    const messages = await this.chatWidgetService.getWidgetConversationMessages(widgetId, visitorId);
    const host = (req.get('x-forwarded-host') || req.get('host')) as string;
    const protocol = ((req.get('x-forwarded-proto') as string) || req.protocol || 'http') as string;
    const baseUrl = host ? `${protocol}://${host}` : '';

    return messages.map(msg => {
      if (msg.media?.url && !msg.media.url.startsWith('http')) {
        return {
          ...msg,
          media: {
            ...msg.media,
            url: `${baseUrl}${msg.media.url}`,
          },
        };
      }
      return msg;
    });
  }

  @Public()
  @Post('messages/read')
  @ApiOperation({ summary: 'Mark outbound messages as read by visitor' })
  markAsRead(@Body() body: { widgetId: string; visitorId: string }) {
    return this.chatWidgetService.markMessagesAsRead(body.widgetId, body.visitorId);
  }
}
