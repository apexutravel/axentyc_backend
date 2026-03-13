import { IsString, IsBoolean, IsOptional, IsArray, IsHexColor, IsIn } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateWidgetConfigDto {
  @ApiPropertyOptional({ default: 'Hola! ¿En qué podemos ayudarte?' })
  @IsOptional()
  @IsString()
  welcomeMessage?: string;

  @ApiPropertyOptional({ default: 'Chatea con nosotros' })
  @IsOptional()
  @IsString()
  title?: string;

  @ApiPropertyOptional({ default: 'Estamos aquí para ayudarte' })
  @IsOptional()
  @IsString()
  subtitle?: string;

  @ApiPropertyOptional({ default: '#0084FF' })
  @IsOptional()
  @IsHexColor()
  primaryColor?: string;

  @ApiPropertyOptional({ default: '#FFFFFF' })
  @IsOptional()
  @IsHexColor()
  textColor?: string;

  @ApiPropertyOptional({ enum: ['right', 'left'], default: 'right' })
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

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  showBranding?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  collectEmail?: boolean;

  @ApiPropertyOptional({ default: false })
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
