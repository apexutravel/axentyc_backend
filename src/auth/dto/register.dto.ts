import { IsString, IsNotEmpty, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CreateUserDto } from '../../users/dto/create-user.dto';

export class RegisterDto extends CreateUserDto {
  @ApiProperty({ example: 'Acme Corporation' })
  @IsString()
  @IsNotEmpty()
  companyName: string;

  @ApiPropertyOptional({ example: 'acme-corp' })
  @IsString()
  @IsOptional()
  companySlug?: string;

  @ApiPropertyOptional({ example: 'starter' })
  @IsString()
  @IsOptional()
  planKey?: string;

  @ApiPropertyOptional({ example: 'monthly' })
  @IsString()
  @IsOptional()
  billingCycle?: 'monthly' | 'yearly';
}
