import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsEmail, IsNotEmpty, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

class EmailRecipient {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  name?: string;

  @ApiProperty()
  @IsEmail()
  address: string;
}

export class SendEmailDto {
  @ApiProperty({ type: [EmailRecipient] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => EmailRecipient)
  to: EmailRecipient[];

  @ApiPropertyOptional({ type: [EmailRecipient] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => EmailRecipient)
  cc?: EmailRecipient[];

  @ApiPropertyOptional({ type: [EmailRecipient] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => EmailRecipient)
  bcc?: EmailRecipient[];

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  subject: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  textBody?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  htmlBody?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  inReplyTo?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  references?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  attachments?: Array<{
    filename: string;
    content: string; // base64
    contentType: string;
  }>;
}
