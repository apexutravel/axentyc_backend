import { IsString, IsNotEmpty, IsOptional, IsEnum, IsObject } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MessageType } from '../entities/message.entity';

export class SendMessageDto {
  @ApiProperty({ example: 'Hello, how can I help you?' })
  @IsString()
  @IsNotEmpty()
  content: string;

  /** Sent by the web app on every scoped request; the controller reads it, it is never stored. */
  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  workspaceId?: string;

  @ApiPropertyOptional({ enum: MessageType })
  @IsEnum(MessageType)
  @IsOptional()
  type?: MessageType;

  @ApiPropertyOptional()
  @IsObject()
  @IsOptional()
  media?: {
    url: string;
    mimeType?: string;
    fileName?: string;
    fileSize?: number;
  };
}
