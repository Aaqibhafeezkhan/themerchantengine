import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
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
import { CarrierTranslatableDto } from './translatable.dto';

export const CARRIER_PROVIDERS = ['dhl', 'fedex', 'ups', 'aramex', 'manual'] as const;
export type CarrierProvider = (typeof CARRIER_PROVIDERS)[number];

export class CreateCarrierDto {
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  @Matches(/^[a-z0-9_]+$/)
  code!: string;

  @IsDefined()
  @ValidateNested()
  @Type(() => CarrierTranslatableDto)
  name!: CarrierTranslatableDto;

  @IsIn(CARRIER_PROVIDERS)
  provider!: CarrierProvider;

  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @IsOptional()
  services?: string[];

  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(250)
  @IsString({ each: true })
  @Matches(/^[A-Z]{2}$/, { each: true })
  @IsOptional()
  zones?: string[];

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  @IsInt()
  @Min(0)
  @IsOptional()
  sortOrder?: number;

  @IsObject()
  @IsOptional()
  config?: Record<string, unknown>;
}
