import { IsString, IsBoolean, IsOptional, IsArray, IsHexColor, IsIn } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateWidgetConfigDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  welcomeMessage?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  subtitle?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsHexColor()
  primaryColor?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsHexColor()
  textColor?: string;

  @ApiPropertyOptional({ enum: ['right', 'left'] })
  @IsOptional()
  @IsIn(['right', 'left'])
  position?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  avatarUrl?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  allowedDomains?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  showBranding?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  showOnLanding?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  collectEmail?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  collectPhone?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  offlineMessage?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  customCSS?: string;
}
