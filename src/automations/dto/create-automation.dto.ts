import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsEnum,
  IsArray,
  IsBoolean,
  IsObject,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { AutomationTrigger, AutomationAction } from '../entities/automation.entity';

class AutomationActionDto {
  @ApiProperty({ enum: AutomationAction })
  @IsEnum(AutomationAction)
  type: AutomationAction;

  @ApiProperty({ example: { message: 'Thanks for contacting us!' } })
  @IsObject()
  config: Record<string, any>;
}

export class CreateAutomationDto {
  @ApiProperty({ example: 'Auto-reply on new message' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiPropertyOptional({ example: 'Sends auto reply when message is received' })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({ enum: AutomationTrigger })
  @IsEnum(AutomationTrigger)
  @IsNotEmpty()
  trigger: AutomationTrigger;

  @ApiPropertyOptional()
  @IsObject()
  @IsOptional()
  conditions?: any;

  @ApiProperty({ type: [AutomationActionDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AutomationActionDto)
  actions: AutomationActionDto[];

  @ApiPropertyOptional({ default: true })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}
