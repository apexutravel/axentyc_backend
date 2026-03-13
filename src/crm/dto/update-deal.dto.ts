import { PartialType } from '@nestjs/swagger';
import { CreateDealDto } from './create-deal.dto';
import { IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateDealDto extends PartialType(CreateDealDto) {
  @ApiPropertyOptional({ example: 'Budget constraints' })
  @IsString()
  @IsOptional()
  lostReason?: string;
}
