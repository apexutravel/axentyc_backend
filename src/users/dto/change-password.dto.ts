import { IsString, IsNotEmpty, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ChangePasswordDto {
  @ApiProperty({ example: 'user123' })
  @IsString()
  @IsNotEmpty()
  userId: string;

  @ApiProperty({ example: 'NewSecurePassword123!' })
  @IsString()
  @IsNotEmpty()
  @MinLength(8)
  newPassword: string;
}
