import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsMongoId, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class ConnectEmailDto {
  @ApiPropertyOptional({ example: '507f1f77bcf86cd799439011' })
  @IsOptional()
  @IsString()
  workspaceId?: string;

  @ApiPropertyOptional({ description: 'Existing mailbox to update / test with stored passwords' })
  @IsOptional()
  @IsMongoId()
  integrationId?: string;

  @ApiPropertyOptional({ example: 'Ventas' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  label?: string;

  // SMTP
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  smtpHost: string;

  @ApiProperty()
  @IsInt()
  @Min(1)
  @Max(65535)
  smtpPort: number;

  @ApiProperty()
  @IsBoolean()
  smtpSecure: boolean;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  smtpUser: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  smtpPass?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  fromName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  fromAddress?: string;

  // IMAP
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  imapHost: string;

  @ApiProperty()
  @IsInt()
  @Min(1)
  @Max(65535)
  imapPort: number;

  @ApiProperty()
  @IsBoolean()
  imapSecure: boolean;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  imapUser: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  imapPass?: string;
}
