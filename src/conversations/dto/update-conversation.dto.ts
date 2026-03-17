import { IsString, IsOptional, IsEnum, IsArray, IsNumber } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { ConversationStatus } from '../entities/conversation.entity';

export class UpdateConversationDto {
  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  contactId?: string;

  @ApiPropertyOptional({ enum: ConversationStatus })
  @IsEnum(ConversationStatus)
  @IsOptional()
  status?: ConversationStatus;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  assignedTo?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  subject?: string;

  @ApiPropertyOptional({ example: ['vip', 'escalated'] })
  @IsArray()
  @IsOptional()
  tags?: string[];

  @ApiPropertyOptional()
  @IsNumber()
  @IsOptional()
  priority?: number;

  @ApiPropertyOptional()
  @IsOptional()
  metadata?: {
    externalId?: string;
    pageId?: string;
    threadId?: string;
    widgetId?: string;
    visitorId?: string;
    isGuest?: boolean;
    visitorData?: {
      name?: string;
      email?: string;
      phone?: string;
    };
  };
}
