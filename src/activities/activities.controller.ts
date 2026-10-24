import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { MembershipsService } from '../memberships/memberships.service';
import { ActivitiesService } from './activities.service';
import { CreateNoteDto, CreateTaskDto, UpdateNoteDto, UpdateTaskDto, UpsertQuickReplyDto } from './dto/activities.dto';

@ApiTags('activities')
@ApiBearerAuth()
@Controller()
export class ActivitiesController {
  constructor(
    private readonly service: ActivitiesService,
    private readonly memberships: MembershipsService,
  ) {}

  private uid = (user: any): string => user._id || user.sub;
  private access = (user: any, workspaceId?: string) => this.memberships.assertCanAccessWorkspace(user.tenantId, this.uid(user), workspaceId);

  // Tasks
  @Post('tasks')
  @ApiOperation({ summary: 'Create a task' })
  async createTask(@CurrentUser() user: any, @Body() dto: CreateTaskDto) {
    await this.access(user, dto.workspaceId);
    return this.service.createTask(user.tenantId, this.uid(user), dto);
  }

  @Get('tasks')
  @ApiOperation({ summary: 'List tasks' })
  async listTasks(
    @CurrentUser() user: any,
    @Query('workspaceId') workspaceId?: string,
    @Query('status') status?: string,
    @Query('mine') mine?: string,
    @Query('overdue') overdue?: string,
    @Query('contactId') contactId?: string,
    @Query('leadId') leadId?: string,
    @Query('dealId') dealId?: string,
  ) {
    await this.access(user, workspaceId);
    return this.service.listTasks(user.tenantId, workspaceId, {
      status,
      mine: mine === 'true',
      overdue: overdue === 'true',
      userId: this.uid(user),
      contactId,
      leadId,
      dealId,
    });
  }

  @Patch('tasks/:id')
  async updateTask(@CurrentUser() user: any, @Param('id') id: string, @Body() dto: UpdateTaskDto) {
    await this.access(user, dto.workspaceId);
    return this.service.updateTask(user.tenantId, id, dto);
  }

  @Delete('tasks/:id')
  async removeTask(@CurrentUser() user: any, @Param('id') id: string, @Query('workspaceId') workspaceId?: string) {
    await this.access(user, workspaceId);
    await this.service.removeTask(user.tenantId, id, workspaceId);
    return { success: true };
  }

  // Notes
  @Post('notes')
  async createNote(@CurrentUser() user: any, @Body() dto: CreateNoteDto) {
    await this.access(user, dto.workspaceId);
    return this.service.createNote(user.tenantId, this.uid(user), dto);
  }

  @Get('notes')
  async listNotes(
    @CurrentUser() user: any,
    @Query('workspaceId') workspaceId?: string,
    @Query('contactId') contactId?: string,
    @Query('leadId') leadId?: string,
    @Query('dealId') dealId?: string,
    @Query('conversationId') conversationId?: string,
  ) {
    await this.access(user, workspaceId);
    return this.service.listNotes(user.tenantId, workspaceId, { contactId, leadId, dealId, conversationId });
  }

  @Patch('notes/:id')
  async updateNote(@CurrentUser() user: any, @Param('id') id: string, @Body() dto: UpdateNoteDto) {
    await this.access(user, dto.workspaceId);
    return this.service.updateNote(user.tenantId, id, dto);
  }

  @Delete('notes/:id')
  async removeNote(@CurrentUser() user: any, @Param('id') id: string, @Query('workspaceId') workspaceId?: string) {
    await this.access(user, workspaceId);
    await this.service.removeNote(user.tenantId, id, workspaceId);
    return { success: true };
  }

  // Quick replies
  @Get('quick-replies')
  async listQuickReplies(@CurrentUser() user: any, @Query('workspaceId') workspaceId?: string) {
    await this.access(user, workspaceId);
    return this.service.listQuickReplies(user.tenantId, workspaceId);
  }

  @Post('quick-replies')
  async createQuickReply(@CurrentUser() user: any, @Body() dto: UpsertQuickReplyDto) {
    await this.access(user, dto.workspaceId);
    return this.service.createQuickReply(user.tenantId, dto);
  }

  @Put('quick-replies/:id')
  async updateQuickReply(@CurrentUser() user: any, @Param('id') id: string, @Body() dto: UpsertQuickReplyDto) {
    await this.access(user, dto.workspaceId);
    return this.service.updateQuickReply(user.tenantId, id, dto);
  }

  @Delete('quick-replies/:id')
  async removeQuickReply(@CurrentUser() user: any, @Param('id') id: string, @Query('workspaceId') workspaceId?: string) {
    await this.access(user, workspaceId);
    await this.service.removeQuickReply(user.tenantId, id, workspaceId);
    return { success: true };
  }

  // Tags + timeline
  @Get('activities/tags')
  async tags(@CurrentUser() user: any, @Query('workspaceId') workspaceId?: string) {
    await this.access(user, workspaceId);
    return this.service.listTags(user.tenantId, workspaceId);
  }

  @Get('activities/timeline')
  @ApiOperation({ summary: 'Unified history of a contact' })
  async timeline(@CurrentUser() user: any, @Query('contactId') contactId: string, @Query('workspaceId') workspaceId?: string) {
    await this.access(user, workspaceId);
    return this.service.timeline(user.tenantId, workspaceId, contactId);
  }
}
