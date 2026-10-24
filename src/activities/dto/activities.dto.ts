import { IsBoolean, IsDateString, IsEnum, IsMongoId, IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { TaskPriority, TaskStatus } from '../entities/task.entity';

class Links {
  @IsOptional() @IsMongoId() contactId?: string;
  @IsOptional() @IsMongoId() leadId?: string;
  @IsOptional() @IsMongoId() dealId?: string;
  @IsOptional() @IsMongoId() conversationId?: string;
  @IsOptional() @IsString() workspaceId?: string;
}

export class CreateTaskDto extends Links {
  @IsString() @IsNotEmpty() @MaxLength(200) title: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsDateString() dueAt?: string;
  @IsOptional() @IsEnum(TaskPriority) priority?: TaskPriority;
  @IsOptional() @IsMongoId() assignedTo?: string;
}

export class UpdateTaskDto {
  @IsOptional() @IsString() workspaceId?: string;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(200) title?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsDateString() dueAt?: string;
  @IsOptional() @IsEnum(TaskPriority) priority?: TaskPriority;
  @IsOptional() @IsEnum(TaskStatus) status?: TaskStatus;
  @IsOptional() @IsMongoId() assignedTo?: string;
}

export class CreateNoteDto extends Links {
  @IsString() @IsNotEmpty() @MaxLength(5000) body: string;
  @IsOptional() @IsBoolean() pinned?: boolean;
}

export class UpdateNoteDto {
  @IsOptional() @IsString() workspaceId?: string;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(5000) body?: string;
  @IsOptional() @IsBoolean() pinned?: boolean;
}

export class UpsertQuickReplyDto {
  @IsOptional() @IsString() workspaceId?: string;
  @IsString() @Matches(/^[a-z0-9_-]{1,30}$/, { message: 'El atajo solo admite minúsculas, números, - y _' }) shortcut: string;
  @IsString() @IsNotEmpty() @MaxLength(2000) body: string;
}
