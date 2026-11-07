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
 * Per-type config for `SectionType.PROMOTIONAL_BANNER`. Drives
 * `MidCampaignBannerComponent` per DR-05. Imagery is referenced by `assetId`
 * (resolved server-side at storefront read time). The CTA pair is optional —
 * a banner can ship without a click target during a soft-launch phase.
 */
export class PromotionalBannerConfigDto {
  /**
   * Any valid UUID (v1–v5). Same rationale as HeroSectionConfigDto — seed
   * uses v5 for deterministic IDs, production uploads generate v4.
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

  @IsOptional()
  @ValidateNested()
  @Type(() => TranslatableDto)
  cta?: TranslatableDto;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  @Matches(CTA_HREF_SCHEME_REGEX, { message: CTA_HREF_SCHEME_MESSAGE })
  ctaHref?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => TranslatableDto)
  imageAlt?: TranslatableDto;
}

/** JSON paths on `StorefrontSection.config` that hold `assetId` strings. */
export const PROMOTIONAL_BANNER_ASSET_ID_PATHS: ReadonlyArray<readonly string[]> = [['assetId']];
