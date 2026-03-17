import { IsString, IsNotEmpty, IsOptional, IsEmail, IsObject } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class WidgetMessageDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  widgetId: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  message: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  visitorId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  visitorName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail()
  visitorEmail?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  visitorPhone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  type?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  media?: {
    url: string;
    mimeType?: string;
    fileName?: string;
    fileSize?: number;
    thumbnailUrl?: string;
  };

  @ApiPropertyOptional()
  @IsOptional()
  metadata?: any;
}
