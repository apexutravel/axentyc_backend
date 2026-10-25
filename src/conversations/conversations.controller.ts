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
import { TypingDto } from './dto/typing.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { MembershipsService } from '../memberships/memberships.service';

@ApiTags('conversations')
@ApiBearerAuth()
@Controller('conversations')
export class ConversationsController {
  constructor(
    private readonly conversationsService: ConversationsService,
    private readonly membershipsService: MembershipsService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Create a new conversation' })
  async create(@CurrentUser() user: any, @Body() dto: CreateConversationDto) {
    await this.membershipsService.assertCanAccessWorkspace(user.tenantId, user._id || user.sub, dto.workspaceId);
    return this.conversationsService.create(user.tenantId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'Get all conversations (inbox)' })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'channel', required: false })
  @ApiQuery({ name: 'channels', required: false, description: 'Comma-separated list of channels' })
  @ApiQuery({ name: 'assignedTo', required: false })
  @ApiQuery({ name: 'workspaceId', required: false })
  async findAll(
    @CurrentUser() user: any,
    @Query('status') status?: string,
    @Query('channel') channel?: string,
    @Query('channels') channels?: string,
    @Query('assignedTo') assignedTo?: string,
    @Query('workspaceId') workspaceId?: string,
  ) {
    await this.membershipsService.assertCanAccessWorkspace(user.tenantId, user._id || user.sub, workspaceId);
    return this.conversationsService.findAll(user.tenantId, {
      status,
      channel,
      channels,
      assignedTo,
      workspaceId,
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a conversation by ID' })
  async findOne(@CurrentUser() user: any, @Param('id') id: string, @Query('workspaceId') workspaceId?: string) {
    await this.membershipsService.assertCanAccessWorkspace(user.tenantId, user._id || user.sub, workspaceId);
    return this.conversationsService.findOne(user.tenantId, id, workspaceId);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a conversation (status, assign, tags)' })
  async update(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() body: UpdateConversationDto,
    @Query('workspaceId') queryWorkspaceId?: string,
  ) {
    // workspaceId only scopes the request: it must never reach the $set of the conversation
    const { workspaceId: bodyWorkspaceId, ...dto } = body;
    const workspaceId = queryWorkspaceId || bodyWorkspaceId;
    await this.membershipsService.assertCanAccessWorkspace(user.tenantId, user._id || user.sub, workspaceId);
    return this.conversationsService.update(user.tenantId, id, dto, workspaceId);
  }

  @Post(':id/messages')
  @ApiOperation({ summary: 'Send a message in a conversation' })
  async sendMessage(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() body: SendMessageDto,
    @Query('workspaceId') queryWorkspaceId?: string,
  ) {
    const { workspaceId: bodyWorkspaceId, ...dto } = body;
    const workspaceId = queryWorkspaceId || bodyWorkspaceId;
    await this.membershipsService.assertCanAccessWorkspace(user.tenantId, user._id || user.sub, workspaceId);
    return this.conversationsService.sendMessage(
      user.tenantId,
      id,
      (user as any)._id,
      dto,
      workspaceId,
    );
  }

  @Get(':id/messages')
  @ApiOperation({ summary: 'Get messages for a conversation' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  async getMessages(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('workspaceId') workspaceId?: string,
  ) {
    await this.membershipsService.assertCanAccessWorkspace(user.tenantId, user._id || user.sub, workspaceId);
    return this.conversationsService.getMessages(
      user.tenantId,
      id,
      page ? parseInt(page) : 1,
      limit ? parseInt(limit) : 50,
      workspaceId,
    );
  }

  @Post(':id/typing')
  @ApiOperation({ summary: 'The agent is typing (shown to Messenger / Instagram customers)' })
  async typing(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() body: TypingDto,
    @Query('workspaceId') queryWorkspaceId?: string,
  ) {
    const workspaceId = queryWorkspaceId || body.workspaceId;
    await this.membershipsService.assertCanAccessWorkspace(user.tenantId, user._id || user.sub, workspaceId);
    return this.conversationsService.setAgentTyping(user.tenantId, id, !!body.isTyping, workspaceId);
  }

  @Post(':id/read')
  @ApiOperation({ summary: 'Mark conversation as read' })
  async markAsRead(@CurrentUser() user: any, @Param('id') id: string, @Query('workspaceId') workspaceId?: string) {
    await this.membershipsService.assertCanAccessWorkspace(user.tenantId, user._id || user.sub, workspaceId);
    return this.conversationsService.markAsRead(user.tenantId, id, workspaceId);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a conversation and its messages' })
  async remove(@CurrentUser() user: any, @Param('id') id: string, @Query('workspaceId') workspaceId?: string) {
    await this.membershipsService.assertCanAccessWorkspace(user.tenantId, user._id || user.sub, workspaceId);
    return this.conversationsService.remove(user.tenantId, id, workspaceId);
  }
}
