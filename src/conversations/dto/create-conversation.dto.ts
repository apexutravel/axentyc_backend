import { IsString, IsNotEmpty, IsOptional, IsEnum, IsArray } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ConversationChannel } from '../entities/conversation.entity';

export class CreateConversationDto {
  @ApiPropertyOptional({ example: '60d5f484f1a2c8b1f8e4e1a2' })
  @IsString()
  @IsOptional()
  contactId?: string;

  @ApiProperty({ enum: ConversationChannel })
  @IsEnum(ConversationChannel)
  @IsNotEmpty()
  channel: ConversationChannel;

  @ApiPropertyOptional({ example: 'Inquiry about pricing' })
  @IsString()
  @IsOptional()
  subject?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  assignedTo?: string;

  @ApiPropertyOptional({ example: ['support', 'priority'] })
  @IsArray()
  @IsOptional()
  tags?: string[];

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
