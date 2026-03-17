import { IsString, IsNotEmpty, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class SaveFacebookConfigDto {
  @ApiProperty({ description: 'Facebook App ID' })
  @IsString()
  @IsNotEmpty()
  appId: string;

  @ApiProperty({ description: 'Facebook App Secret' })
  @IsString()
  @IsNotEmpty()
  appSecret: string;

  @ApiProperty({ description: 'Webhook Verify Token', required: false })
  @IsString()
  @IsOptional()
  verifyToken?: string;
}
