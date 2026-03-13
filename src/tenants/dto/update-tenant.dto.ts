import { PartialType } from '@nestjs/swagger';
import { CreateTenantDto } from './create-tenant.dto';
import { IsBoolean, IsOptional, IsObject, IsEnum } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { TenantStatus } from '../entities/tenant.entity';

export class UpdateTenantDto extends PartialType(CreateTenantDto) {
  @ApiPropertyOptional({ enum: TenantStatus })
  @IsEnum(TenantStatus)
  @IsOptional()
  status?: TenantStatus;

  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  @ApiPropertyOptional()
  @IsObject()
  @IsOptional()
  settings?: any;

  @ApiPropertyOptional()
  @IsObject()
  @IsOptional()
  integrations?: any;
}
