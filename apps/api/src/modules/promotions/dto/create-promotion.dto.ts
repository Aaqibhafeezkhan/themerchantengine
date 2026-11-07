import {
  IsArray,
  IsBoolean,
  IsDateString,
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
import { PromotionApplicationMethod, PromotionType } from '@prisma/client';
import { TranslatableDto } from './translatable.dto';

export class CreatePromotionAdminDto {
  @IsDefined()
  @ValidateNested()
  @Type(() => TranslatableDto)
  name: TranslatableDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => TranslatableDto)
  description?: TranslatableDto;

  @IsEnum(PromotionType)
  type: PromotionType;

  @IsEnum(PromotionApplicationMethod)
  applicationMethod: PromotionApplicationMethod;

  /** Required when applicationMethod = COUPON. */
  @IsOptional()
  @IsString()
  couponCode?: string;

  /**
   * Percentage (0–100) for PERCENTAGE type; fixed amount for others.
   * Must be >= 0.
   */
  @IsNumber()
  @Min(0)
  value: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  minimumOrderAmount?: number;

  /** Maximum discount amount cap (optional). */
  @IsOptional()
  @IsNumber()
  @Min(0)
  maximumDiscount?: number;

  /** Total usage limit across all users. */
  @IsOptional()
  @IsInt()
  @Min(1)
  usageLimit?: number;

  /** Per-user usage limit. */
  @IsOptional()
  @IsInt()
  @Min(1)
  usageLimitPerUser?: number;

  /** When true, this promotion cannot stack with any other promotion. */
  @IsOptional()
  @IsBoolean()
  isExclusive?: boolean;

  /** Lower number = higher priority. Used for conflict resolution. */
  @IsOptional()
  @IsInt()
  @Min(0)
  priority?: number;

  /** For BUY_X_GET_Y: number of items the customer must buy. */
  @IsOptional()
  @IsInt()
  @Min(1)
  buyQuantity?: number;

  /** For BUY_X_GET_Y: number of items given free. */
  @IsOptional()
  @IsInt()
  @Min(1)
  getQuantity?: number;

  /**
   * For VOLUME_DISCOUNT: [{minQty, maxQty, discountPercent}]
   * For TIERED_PRICE:    [{minQty, maxQty, unitPrice}]
   */
  @IsOptional()
  tierConfig?: unknown;

  @IsOptional()
  @IsDateString()
  startsAt?: string;

  @IsOptional()
  @IsDateString()
  endsAt?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  /** Product IDs that are eligible for this promotion (empty = all products). */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  eligibleProductIds?: string[];

  /** Category IDs that are eligible for this promotion (empty = all categories). */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  eligibleCategoryIds?: string[];
}
