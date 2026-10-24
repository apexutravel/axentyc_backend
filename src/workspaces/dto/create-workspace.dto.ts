import { IsEnum, IsObject, IsOptional, IsString, IsNotEmpty, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { WorkspaceType } from '../entities/workspace.entity';

export class CreateWorkspaceDto {
  @ApiProperty({ example: 'Cliente A - Restaurante' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @ApiPropertyOptional({ example: 'cliente-a-restaurante' })
  @IsString()
  @IsOptional()
  @MaxLength(100)
  slug?: string;

  @ApiPropertyOptional({ example: 'Workspace para la marca o cliente Restaurante' })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({ example: '#2563eb' })
  @IsString()
  @IsOptional()
  color?: string;

  @ApiPropertyOptional({ example: 'building' })
  @IsString()
  @IsOptional()
  icon?: string;

  @ApiPropertyOptional({ example: 'https://example.com/logo.png' })
  @IsString()
  @IsOptional()
  logoUrl?: string;

  @ApiPropertyOptional({ example: 'sales@example.com' })
  @IsString()
  @IsOptional()
  businessEmail?: string;

  @ApiPropertyOptional({ example: '+1 555 123 4567' })
  @IsString()
  @IsOptional()
  phone?: string;

  @ApiPropertyOptional({ example: 'https://example.com' })
  @IsString()
  @IsOptional()
  website?: string;

  @ApiPropertyOptional({ example: 'Home services' })
  @IsString()
  @IsOptional()
  industry?: string;

  @ApiPropertyOptional({ example: 'USD' })
  @IsString()
  @IsOptional()
  currency?: string;

  @ApiPropertyOptional({ example: 'America/New_York' })
  @IsString()
  @IsOptional()
  timezone?: string;

  @ApiPropertyOptional({ example: { line1: '123 Main St', city: 'Miami', state: 'FL', postalCode: '33101', country: 'US' } })
  @IsObject()
  @IsOptional()
  address?: Record<string, string>;

  @ApiPropertyOptional({ example: { taxId: 'EIN 00-0000000', taxName: 'Sales Tax', taxRate: 7, taxIncluded: false } })
  @IsObject()
  @IsOptional()
  taxSettings?: {
    taxId?: string;
    taxName?: string;
    taxRate?: number;
    taxIncluded?: boolean;
  };

  @ApiPropertyOptional({ example: { quoteTerms: 'Valid for 15 days', invoiceTerms: 'Due upon receipt' } })
  @IsObject()
  @IsOptional()
  documentSettings?: Record<string, string>;

  @ApiPropertyOptional({ example: { enabled: true, timezone: 'America/New_York' } })
  @IsObject()
  @IsOptional()
  businessHours?: Record<string, any>;

  @ApiPropertyOptional({ enum: WorkspaceType, example: WorkspaceType.CLIENT })
  @IsEnum(WorkspaceType)
  @IsOptional()
  type?: WorkspaceType;
}
