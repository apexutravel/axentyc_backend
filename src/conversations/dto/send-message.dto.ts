import { IsString, IsNotEmpty, IsOptional, IsEnum, IsObject } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MessageType } from '../entities/message.entity';

export class SendMessageDto {
  @ApiProperty({ example: 'Hello, how can I help you?' })
  @IsString()
  @IsNotEmpty()
  content: string;

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
