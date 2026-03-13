import { IsString, IsOptional, IsEnum, IsArray, IsNumber } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { ConversationStatus } from '../entities/conversation.entity';

export class UpdateConversationDto {
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
}
