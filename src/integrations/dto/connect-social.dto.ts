import { IsString, IsNotEmpty, IsOptional, IsEnum } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SocialPlatform } from '../entities/social-account.entity';

export class ConnectSocialDto {
  @ApiProperty({ enum: SocialPlatform })
  @IsEnum(SocialPlatform)
  @IsNotEmpty()
  platform: SocialPlatform;

  @ApiProperty({ example: 'My Business Page' })
  @IsString()
  @IsNotEmpty()
  accountName: string;

  @ApiPropertyOptional({ example: '123456789' })
  @IsString()
  @IsOptional()
  accountId?: string;

  @ApiPropertyOptional({ example: '987654321' })
  @IsString()
  @IsOptional()
  pageId?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  accessToken?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  refreshToken?: string;
}
