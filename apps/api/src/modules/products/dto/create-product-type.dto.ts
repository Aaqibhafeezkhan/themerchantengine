import { IsDefined, IsOptional, IsString, Matches, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { TranslatableDto } from './translatable.dto';

export class CreateProductTypeAdminDto {
  @IsDefined()
  @ValidateNested()
  @Type(() => TranslatableDto)
  name: TranslatableDto;

  @IsString()
  @Matches(/^[a-z0-9]+(?:[_-][a-z0-9]+)*$/, {
    message: 'code must be lowercase alphanumeric with optional hyphens or underscores',
  })
  code: string;

  @IsOptional()
  @IsString()
  taxClassId?: string;
}
