import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsEnum,
  IsNumber,
  IsArray,
  IsDateString,
  IsObject,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { LeadStatus, LeadPriority } from '../entities/lead.entity';

export class CreateLeadDto {
  @ApiProperty({ example: '60d5f484f1a2c8b1f8e4e1a2' })
  @IsString()
  @IsNotEmpty()
  contactId: string;

  @ApiProperty({ example: 'New business opportunity' })
  @IsString()
  @IsNotEmpty()
  title: string;

  @ApiPropertyOptional({ example: 'Interested in premium plan' })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({ enum: LeadStatus })
  @IsEnum(LeadStatus)
  @IsOptional()
  status?: LeadStatus;

  @ApiPropertyOptional({ enum: LeadPriority })
  @IsEnum(LeadPriority)
  @IsOptional()
  priority?: LeadPriority;

  @ApiPropertyOptional({ example: 5000 })
  @IsNumber()
  @IsOptional()
  estimatedValue?: number;

  @ApiPropertyOptional({ example: 'USD' })
  @IsString()
  @IsOptional()
  currency?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  assignedTo?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  source?: string;

  @ApiPropertyOptional({ example: ['hot', 'enterprise'] })
  @IsArray()
  @IsOptional()
  tags?: string[];

  @ApiPropertyOptional()
  @IsObject()
  @IsOptional()
  customFields?: Record<string, any>;

  @ApiPropertyOptional()
  @IsDateString()
  @IsOptional()
  expectedCloseDate?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  notes?: string;
}
