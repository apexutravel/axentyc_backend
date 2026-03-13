import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { ConversationsService } from './conversations.service';
import { CreateConversationDto } from './dto/create-conversation.dto';
import { UpdateConversationDto } from './dto/update-conversation.dto';
import { SendMessageDto } from './dto/send-message.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@ApiTags('conversations')
@ApiBearerAuth()
@Controller('conversations')
export class ConversationsController {
  constructor(private readonly conversationsService: ConversationsService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new conversation' })
  create(@CurrentUser() user: any, @Body() dto: CreateConversationDto) {
    return this.conversationsService.create(user.tenantId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'Get all conversations (inbox)' })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'channel', required: false })
  @ApiQuery({ name: 'assignedTo', required: false })
  findAll(
    @CurrentUser() user: any,
    @Query('status') status?: string,
    @Query('channel') channel?: string,
    @Query('assignedTo') assignedTo?: string,
  ) {
    return this.conversationsService.findAll(user.tenantId, {
      status,
      channel,
      assignedTo,
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a conversation by ID' })
  findOne(@CurrentUser() user: any, @Param('id') id: string) {
    return this.conversationsService.findOne(user.tenantId, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a conversation (status, assign, tags)' })
  update(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() dto: UpdateConversationDto,
  ) {
    return this.conversationsService.update(user.tenantId, id, dto);
  }

  @Post(':id/messages')
  @ApiOperation({ summary: 'Send a message in a conversation' })
  sendMessage(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() dto: SendMessageDto,
  ) {
    return this.conversationsService.sendMessage(
      user.tenantId,
      id,
      (user as any)._id,
      dto,
    );
  }

  @Get(':id/messages')
  @ApiOperation({ summary: 'Get messages for a conversation' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  getMessages(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.conversationsService.getMessages(
      user.tenantId,
      id,
      page ? parseInt(page) : 1,
      limit ? parseInt(limit) : 50,
    );
  }

  @Post(':id/read')
  @ApiOperation({ summary: 'Mark conversation as read' })
  markAsRead(@CurrentUser() user: any, @Param('id') id: string) {
    return this.conversationsService.markAsRead(user.tenantId, id);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a conversation and its messages' })
  remove(@CurrentUser() user: any, @Param('id') id: string) {
    return this.conversationsService.remove(user.tenantId, id);
  }
}
