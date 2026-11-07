import {
  IsDefined,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { TranslatableDto } from '../translatable.dto';
import { CTA_HREF_SCHEME_REGEX, CTA_HREF_SCHEME_MESSAGE } from './cta-href.constants';

/**
 * Per-type config for `SectionType.HERO`. Drives `HeroBannerComponent` per
 * DR-05. Imagery is referenced by `assetId` (resolved server-side at
 * storefront read time per DR-04). User-facing strings are `Translatable`
 * JSONB per constitution §3.2; `ctaHref` is a path/URL string.
 */
export class HeroSectionConfigDto {
  /**
   * Any valid UUID (v1–v5). Production uploads generate v4; the e2e catalogue
   * seed pipeline uses v5 (namespace-derived) for stable reseed IDs. Both
   * are valid asset row identifiers — `@IsUUID()` without a version arg
   * accepts all RFC 4122 variants.
   */
  @IsUUID()
  assetId: string;

  @IsDefined()
  @ValidateNested()
  @Type(() => TranslatableDto)
  eyebrow: TranslatableDto;

  @IsDefined()
  @ValidateNested()
  @Type(() => TranslatableDto)
  headline: TranslatableDto;

  @IsDefined()
  @ValidateNested()
  @Type(() => TranslatableDto)
  body: TranslatableDto;

  @IsDefined()
  @ValidateNested()
  @Type(() => TranslatableDto)
  cta: TranslatableDto;

  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  @Matches(CTA_HREF_SCHEME_REGEX, { message: CTA_HREF_SCHEME_MESSAGE })
  ctaHref: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => TranslatableDto)
  imageAlt?: TranslatableDto;
}

/** JSON paths on `StorefrontSection.config` that hold `assetId` strings. */
export const HERO_ASSET_ID_PATHS: ReadonlyArray<readonly string[]> = [['assetId']];
