import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDefined,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { TranslatableDto } from './translatable.dto';

/** Upper bound on specifications per product. See ReplaceProductSpecsAdminDto. */
export const MAX_PRODUCT_SPECS = 50;

/**
 * One specification row: a label and its value, both Translatable because both
 * are rendered to the customer (§3.2).
 *
 * `key`, `valueKey` and `sortOrder` are deliberately absent. All three are
 * derived server-side: the keys are the accent-folded forms behind
 * `@@unique([productId, key])` and the facet grouping, and `sortOrder` is the
 * row's position in the array. With `whitelist` + `forbidNonWhitelisted` on
 * (main.ts), a client that sends any of them gets a mechanical 400 rather than
 * a silent overwrite of the uniqueness key (§3.5).
 */
export class ProductSpecItemAdminDto {
  @IsDefined()
  @ValidateNested()
  @Type(() => TranslatableDto)
  label: TranslatableDto;

  @IsDefined()
  @ValidateNested()
  @Type(() => TranslatableDto)
  value: TranslatableDto;
}

/**
 * Whole-matrix replace. The array is the product's complete specification set
 * in display order; rows the payload omits are removed.
 *
 * Replace rather than per-row CRUD because the editor is a grid saved in one
 * action: a reorder would otherwise be N requests with no atomicity, and
 * renaming a label to one that already exists on the product would race
 * `@@unique([productId, key])` between the two calls.
 *
 * `@ArrayMaxSize` and not `@ArrayNotEmpty`: an empty array is the legal
 * clear-all, but the count needs a bound because the public spec-facets route
 * loads every spec row in the catalogue unpaginated.
 */
export class ReplaceProductSpecsAdminDto {
  @IsArray()
  @ArrayMaxSize(MAX_PRODUCT_SPECS)
  @ValidateNested({ each: true })
  @Type(() => ProductSpecItemAdminDto)
  specs: ProductSpecItemAdminDto[];
}

/** Query for the cross-catalogue label autocomplete. */
export class ListSpecLabelsAdminDto {
  /**
   * Free-text term. Named `search` to match every other admin list endpoint
   * and the `EntitySelectSource` contract the picker codes against; the server
   * folds it with the same `specKey` it folded the stored keys with, so the
   * match is accent-insensitive without a second normalisation.
   */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  pageSize?: number = 20;
}
