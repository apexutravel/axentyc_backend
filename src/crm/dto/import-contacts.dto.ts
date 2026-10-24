import { ArrayMaxSize, ArrayMinSize, IsArray, IsObject, IsOptional, IsString } from 'class-validator';

export class ImportContactsDto {
  @IsOptional()
  @IsString()
  workspaceId?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(2000)
  @IsObject({ each: true })
  rows: Record<string, any>[];
}
