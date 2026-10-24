import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsMongoId,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { SalesDocStatus, SalesDocType } from '../entities/sales-document.entity';

export class LineDto {
  @IsString() @IsNotEmpty() @MaxLength(500) description: string;
  @IsNumber() @Min(0.0001) @Max(1_000_000) quantity: number;
  @IsInt() @Min(0) unitPriceCents: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100) discountPct?: number;
  @IsOptional() @IsBoolean() taxable?: boolean;
  @IsOptional() @IsMongoId() productId?: string;
}

class DocBase {
  @IsOptional() @IsString() workspaceId?: string;
  @IsOptional() @IsMongoId() dealId?: string;
  @IsOptional() @IsDateString() issueDate?: string;
  @IsOptional() @IsDateString() dueDate?: string;
  @IsOptional() @IsString() @MaxLength(3) currency?: string;
  @IsOptional() @IsIn(['es', 'en']) language?: 'es' | 'en';
  @IsOptional() @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => LineDto) lines?: LineDto[];
  @IsOptional() @IsNumber() @Min(0) @Max(100) discountPct?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100) taxRatePct?: number;
  @IsOptional() @IsString() @MaxLength(60) taxName?: string;
  @IsOptional() @IsBoolean() taxIncluded?: boolean;
  @IsOptional() @IsString() @MaxLength(3000) notes?: string;
  @IsOptional() @IsString() @MaxLength(3000) terms?: string;
}

export class CreateSalesDocDto extends DocBase {
  @IsEnum(SalesDocType) type: SalesDocType;
  @IsMongoId() contactId: string;
}

export class UpdateSalesDocDto extends DocBase {
  @IsOptional() @IsMongoId() contactId?: string;
}

export class SetStatusDto {
  @IsOptional() @IsString() workspaceId?: string;
  @IsEnum(SalesDocStatus) status: SalesDocStatus;
}

export class AddPaymentDto {
  @IsOptional() @IsString() workspaceId?: string;
  @IsInt() @Min(1) amountCents: number;
  @IsString() @IsIn(['cash', 'zelle', 'transfer', 'check', 'card', 'paypal', 'other']) method: string;
  @IsOptional() @IsDateString() date?: string;
  @IsOptional() @IsString() @MaxLength(100) reference?: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class SendDocDto {
  @IsOptional() @IsString() workspaceId?: string;
  @IsOptional() @IsMongoId() integrationId?: string;
  @IsOptional() @IsString() to?: string;
  @IsOptional() @IsString() @MaxLength(200) subject?: string;
  @IsOptional() @IsString() @MaxLength(3000) message?: string;
}

export class FromDealDto {
  @IsOptional() @IsString() workspaceId?: string;
  @IsEnum(SalesDocType) type: SalesDocType;
}

export class UpsertProductDto {
  @IsOptional() @IsString() workspaceId?: string;
  @IsString() @IsNotEmpty() @MaxLength(200) name: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @IsOptional() @IsString() @MaxLength(60) sku?: string;
  @IsInt() @Min(0) unitPriceCents: number;
  @IsOptional() @IsBoolean() taxable?: boolean;
  @IsOptional() @IsBoolean() isActive?: boolean;
}
