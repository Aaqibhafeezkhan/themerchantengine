import {
  IsArray,
  IsBoolean,
  IsDefined,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ShippingMethodType } from '@prisma/client';
import { TranslatableDto } from './translatable.dto';
import { MONEY_DECIMAL_PLACES } from '@common/money';

/** One weight band of a WEIGHT_BASED shipping method. */
export class WeightRangeDto {
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  @Type(() => Number)
  minKg: number;

  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  @Type(() => Number)
  maxKg: number;

  @IsNumber({ maxDecimalPlaces: MONEY_DECIMAL_PLACES })
  @Min(0)
  @Type(() => Number)
  price: number;
}

/** One subtotal band of a PRICE_BASED shipping method. */
export class PriceRangeDto {
  @IsNumber({ maxDecimalPlaces: MONEY_DECIMAL_PLACES })
  @Min(0)
  @Type(() => Number)
  minAmount: number;

  @IsNumber({ maxDecimalPlaces: MONEY_DECIMAL_PLACES })
  @Min(0)
  @Type(() => Number)
  maxAmount: number;

  @IsNumber({ maxDecimalPlaces: MONEY_DECIMAL_PLACES })
  @Min(0)
  @Type(() => Number)
  price: number;
}

export class CreateShippingMethodAdminDto {
  @IsString()
  zoneId: string;

  @IsDefined()
  @ValidateNested()
  @Type(() => TranslatableDto)
  name: TranslatableDto;

  @IsEnum(ShippingMethodType)
  type: ShippingMethodType;

  @IsOptional()
  @IsNumber()
  @Min(0)
  price?: number;

  /**
   * JSON array: [{minKg, maxKg, price}].
   *
   * Validated element-wise. Before D4 these two properties carried
   * `@IsOptional()` and nothing else — no `@IsArray`, no `@ValidateNested`,
   * no `@Type` — so under the global `whitelist: true` pipe the property was
   * kept and its contents checked by nothing at all. A string, a negative, or
   * an arbitrary-scale number landed in the Json column and was then returned
   * by `resolveMethodPrice` as the shipping charge on a live order. These are
   * money in JSON, which no Decimal migration can reach, so the DTO is the
   * only place their scale can be enforced.
   */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WeightRangeDto)
  weightRanges?: WeightRangeDto[];

  /** JSON array: [{minAmount, maxAmount, price}]. Same caveat as weightRanges. */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PriceRangeDto)
  priceRanges?: PriceRangeDto[];

  @IsOptional()
  @IsNumber()
  @Min(0)
  freeAbove?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  estimatedDaysMin?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  estimatedDaysMax?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  /**
   * Marks this method as the zone's preselected standard method. At most one
   * default per zone (partial-unique DB index); the service clears any sibling
   * default in the same zone when this is set. Drives checkout auto-pick + admin
   * order-create preselection.
   */
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}
