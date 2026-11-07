import {
  IsDefined,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { TranslatableDto } from './translatable.dto';

export class CreateAttributeAdminDto {
  @IsString()
  productTypeId: string;

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
  @IsInt()
  @Min(0)
  sortOrder?: number;
}
