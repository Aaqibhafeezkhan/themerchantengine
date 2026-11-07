import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDefined,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { REGISTERED_PAYMENT_PROVIDER_IDS } from '../payment-providers';
import { OptionalTranslatableDto, PaymentTranslatableDto } from './translatable.dto';

/**
 * Gateways an operator may already configure although no provider runs them
 * yet. Each one leaves this list when its provider joins the module array.
 */
const UNREGISTERED_PAYMENT_PROVIDER_IDS = ['paypal', 'gift_card'] as const;

/**
 * Provider allow-list, locked server-side so operators can't enable an
 * unknown provider. Registering a provider adds it here.
 */
export const PAYMENT_PROVIDER_IDS = [
  ...REGISTERED_PAYMENT_PROVIDER_IDS,
  ...UNREGISTERED_PAYMENT_PROVIDER_IDS,
] as const;
export type PaymentProviderId = (typeof PAYMENT_PROVIDER_IDS)[number];

export class CreatePaymentMethodDto {
  /** Operator-facing short identifier: lowercase, digits, underscores. */
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  @Matches(/^[a-z0-9_]+$/, {
    message: 'code must be lowercase letters, digits, or underscores',
  })
  code!: string;

  @IsDefined()
  @ValidateNested()
  @Type(() => PaymentTranslatableDto)
  name!: PaymentTranslatableDto;

  @ValidateNested()
  @Type(() => OptionalTranslatableDto)
  @IsOptional()
  description?: OptionalTranslatableDto;

  @IsIn(PAYMENT_PROVIDER_IDS)
  provider!: PaymentProviderId;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  @IsBoolean()
  @IsOptional()
  isTestMode?: boolean;

  @IsInt()
  @Min(0)
  @IsOptional()
  sortOrder?: number;

  /** Free-form provider config. Secrets are masked on GET. */
  @IsObject()
  @IsOptional()
  config?: Record<string, unknown>;
}
