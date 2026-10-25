import { IsBoolean, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class TypingDto {
  /** Sent by the web app on every scoped request; the controller reads it, it is never stored. */
  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  workspaceId?: string;

  @ApiProperty({ description: 'The agent started (true) or stopped (false) typing' })
  @IsBoolean()
  isTyping: boolean;
}
