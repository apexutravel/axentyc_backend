import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsEnum,
  IsNumber,
  IsArray,
  IsDateString,
  IsObject,
  Min,
  Max,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DealStage } from '../entities/deal.entity';

export class CreateDealDto {
  @ApiProperty({ example: '60d5f484f1a2c8b1f8e4e1a2' })
  @IsString()
  @IsNotEmpty()
  contactId: string;

  @ApiPropertyOptional({ example: '60d5f484f1a2c8b1f8e4e1a3' })
  @IsString()
  @IsOptional()
  leadId?: string;

  @ApiProperty({ example: 'Enterprise License Deal' })
  @IsString()
  @IsNotEmpty()
  title: string;

  @ApiPropertyOptional({ example: 'Annual enterprise license' })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({ enum: DealStage })
  @IsEnum(DealStage)
  @IsOptional()
  stage?: DealStage;

  @ApiProperty({ example: 10000 })
  @IsNumber()
  @IsNotEmpty()
  value: number;

  @ApiPropertyOptional({ example: 'USD' })
  @IsString()
  @IsOptional()
  currency?: string;

  @ApiPropertyOptional({ example: 50 })
  @IsNumber()
  @Min(0)
  @Max(100)
  @IsOptional()
  probability?: number;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  assignedTo?: string;

  @ApiPropertyOptional()
  @IsDateString()
  @IsOptional()
  expectedCloseDate?: string;

  @ApiPropertyOptional({ example: ['enterprise', 'q1-2026'] })
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
}
