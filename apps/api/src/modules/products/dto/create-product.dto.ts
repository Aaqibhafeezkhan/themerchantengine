import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDefined,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ProductStatus } from '@prisma/client';
import { OptionalContentTranslatableDto, TranslatableDto } from './translatable.dto';
import { CreateProductVariantAdminDto } from './create-variant.dto';

export class CreateProductAdminDto {
  @IsDefined()
  @ValidateNested()
  @Type(() => TranslatableDto)
  name: TranslatableDto;

  /**
   * Optional explicit slug. When omitted the service auto-generates from name.default.
   */
  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: 'slug must be lowercase alphanumeric with optional hyphens',
  })
  slug?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => OptionalContentTranslatableDto)
  description?: OptionalContentTranslatableDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => OptionalContentTranslatableDto)
  shortDescription?: OptionalContentTranslatableDto;

  @IsOptional()
  @IsEnum(ProductStatus)
  status?: ProductStatus;

  @IsOptional()
  @IsString()
  productTypeId?: string;

  @IsOptional()
  @IsString()
  brand?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsBoolean()
  isFeatured?: boolean;

  @IsOptional()
  @IsBoolean()
  isDigital?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => OptionalContentTranslatableDto)
  metaTitle?: OptionalContentTranslatableDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => OptionalContentTranslatableDto)
  metaDescription?: OptionalContentTranslatableDto;

  /**
   * Category IDs to assign the product to.
   *
   * `@ArrayUnique` because the join is keyed `@@id([productId, categoryId])`,
   * so a repeated id is a unique-constraint violation rather than a no-op.
   * `@ArrayMaxSize` bounds a list that is written with `createMany` and read
   * back on every product detail response.
   */
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  categoryIds?: string[];

  /** Asset IDs to attach at creation time */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  assetIds?: string[];

  /** Variants to create together with the product */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateProductVariantAdminDto)
  variants?: CreateProductVariantAdminDto[];
}
