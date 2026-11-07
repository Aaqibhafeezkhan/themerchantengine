import {
  IsBoolean,
  IsDefined,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { CmsPageType } from '@prisma/client';
import { TranslatableDto } from './translatable.dto';

export class CreatePageAdminDto {
  @IsString()
  @MaxLength(200)
  @Matches(/^(?:\/[a-z0-9-]+)+$/, {
    message:
      'slug must be one or more "/"-prefixed segments of lowercase letters, digits, and hyphens',
  })
  slug: string;

  @IsEnum(CmsPageType)
  type: CmsPageType;

  /** Translatable title: { default: string; [locale: string]: string } */
  @IsDefined()
  @ValidateNested()
  @Type(() => TranslatableDto)
  title: TranslatableDto;

  /** Translatable rich text content (should be sanitized on storage). */
  @IsDefined()
  @ValidateNested()
  @Type(() => TranslatableDto)
  content: TranslatableDto;

  @IsOptional()
  @IsBoolean()
  isPublished?: boolean;

  @IsOptional()
  @ValidateNested()
  @Type(() => TranslatableDto)
  metaTitle?: TranslatableDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => TranslatableDto)
  metaDescription?: TranslatableDto;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  showInNavigation?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  template?: string;
}
