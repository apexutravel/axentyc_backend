import { IsEnum, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { UserRole } from '../entities/user.entity';

export class ChangeRoleDto {
  @ApiProperty({ enum: UserRole, example: UserRole.AGENT })
  @IsEnum(UserRole)
  @IsNotEmpty()
  role: UserRole;
}
