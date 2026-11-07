import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDefined,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Min,
  ValidateNested,
} from 'class-validator';

/** Address snapshot supplied by the operator (separate from the storefront DTO). */
class AdminOrderAddressDto {
  @IsString()
  fullName!: string;

  @IsString()
  phone!: string;

  @IsString()
  addressLine1!: string;

  @IsOptional()
  @IsString()
  addressLine2?: string;

  @IsString()
  city!: string;

  @IsOptional()
  @IsString()
  state?: string;

  @IsOptional()
  @IsString()
  postalCode?: string;

  @IsString()
  @Matches(/^[A-Z]{2}$/)
  country!: string;
}

class AdminOrderItemDto {
  @IsString()
  variantId!: string;

  @IsInt()
  @Min(1)
  quantity!: number;
}

/**
 * Admin manual-order creation (phone / walk-in). Separate from the storefront
 * `CreateOrderDto`: items are supplied directly (not sourced from a cart), the
 * customer link is optional (guest orders), and `whitelist: true` strips any
 * field not declared here (§3.5). Shipping defaults to the destination zone's
 * default method when `shippingMethodId` is omitted.
 */
export class CreateAdminOrderDto {
  /** Optional existing customer to link. Omit for a guest / walk-in order. */
  @IsOptional()
  @IsString()
  userId?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => AdminOrderItemDto)
  items!: AdminOrderItemDto[];

  @IsDefined()
  @ValidateNested()
  @Type(() => AdminOrderAddressDto)
  shippingAddress!: AdminOrderAddressDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => AdminOrderAddressDto)
  billingAddress?: AdminOrderAddressDto;

  /** Defaults to the destination zone's default method when omitted. */
  @IsOptional()
  @IsString()
  shippingMethodId?: string;

  @IsOptional()
  @IsString()
  couponCode?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}
