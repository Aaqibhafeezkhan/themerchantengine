import {
  IsBoolean,
  IsDefined,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { OptionalContentTranslatableDto, TranslatableDto } from './translatable.dto';

export class CreateCategoryAdminDto {
  @IsDefined()
  @ValidateNested()
  @Type(() => TranslatableDto)
  name: TranslatableDto;

  @IsString()
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: 'slug must be lowercase alphanumeric with optional hyphens',
  })
  slug: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => OptionalContentTranslatableDto)
  description?: OptionalContentTranslatableDto;

  @IsOptional()
  @IsString()
  parentId?: string;

  @IsOptional()
  @IsString()
  imageId?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  isVisible?: boolean;

  @IsOptional()
  @ValidateNested()
  @Type(() => OptionalContentTranslatableDto)
  metaTitle?: OptionalContentTranslatableDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => OptionalContentTranslatableDto)
  metaDescription?: OptionalContentTranslatableDto;
}
