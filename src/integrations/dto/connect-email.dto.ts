import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEmail, IsInt, IsNotEmpty, IsOptional, IsString, Max, Min } from 'class-validator';

export class ConnectEmailDto {
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
