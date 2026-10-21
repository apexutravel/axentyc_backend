import { ArrayUnique, IsArray, IsEnum, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AccountRole } from '../entities/account-member.entity';

export class SetWorkspaceAccessDto {
  @ApiProperty({ example: '507f1f77bcf86cd799439011' })
  @IsString()
  userId: string;

  @ApiProperty({ example: '507f1f77bcf86cd799439012' })
  @IsString()
  workspaceId: string;

  @ApiProperty({ enum: AccountRole, example: AccountRole.AGENT })
  @IsEnum(AccountRole)
  role: AccountRole;

  @ApiPropertyOptional({ example: ['conversations:reply', 'contacts:update'] })
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  @IsOptional()
  permissions?: string[];
}
