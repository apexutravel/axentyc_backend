import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsEmail,
  IsEnum,
  IsArray,
  IsObject,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ContactSource } from '../entities/contact.entity';

export class CreateContactDto {
  @ApiProperty({ example: 'John Doe' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiPropertyOptional({ example: 'john@example.com' })
  @IsEmail()
  @IsOptional()
  email?: string;

  @ApiPropertyOptional({ example: '+1234567890' })
  @IsString()
  @IsOptional()
  phone?: string;

  @ApiPropertyOptional({ example: 'Acme Corp' })
  @IsString()
  @IsOptional()
  company?: string;

  @ApiPropertyOptional({ example: 'https://example.com/avatar.png' })
  @IsString()
  @IsOptional()
  avatar?: string;

  @ApiPropertyOptional({ enum: ContactSource })
  @IsEnum(ContactSource)
  @IsOptional()
  source?: ContactSource;

  @ApiPropertyOptional()
  @IsObject()
  @IsOptional()
  socialProfiles?: any;

  @ApiPropertyOptional({ example: ['vip', 'hot-lead'] })
  @IsArray()
  @IsOptional()
  tags?: string[];

  @ApiPropertyOptional()
  @IsObject()
  @IsOptional()
  customFields?: Record<string, any>;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  notes?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  assignedTo?: string;
}
