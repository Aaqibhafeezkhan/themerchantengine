import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDefined,
  IsIn,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { TranslatableDto } from '../translatable.dto';

export const TRUST_PILLAR_KINDS = ['delivery', 'returns', 'authentic', 'support'] as const;
export type TrustPillarKind = (typeof TRUST_PILLAR_KINDS)[number];

/**
 * One pillar inside a `TRUST_SIGNALS` section. The `kind` selects the
 * inline-SVG glyph on the storefront via the existing `TrustIconComponent`
 * enum. Title + subtitle are `Translatable` JSONB per constitution §3.2.
 */
export class TrustSignalItemDto {
  @IsIn(TRUST_PILLAR_KINDS)
  kind: TrustPillarKind;

  @IsDefined()
  @ValidateNested()
  @Type(() => TranslatableDto)
  title: TranslatableDto;

  @IsDefined()
  @ValidateNested()
  @Type(() => TranslatableDto)
  subtitle: TranslatableDto;
}

/**
 * Per-type config for `SectionType.TRUST_SIGNALS`. Drives `TrustStripComponent`
 * per DR-05. Carries an ordered list of pillars; the storefront renders the
 * provided glyph + bilingual labels.
 *
 * Bounds: at least one pillar (an empty strip is rendered as a hidden
 * section by the storefront cache layer; we reject it at write time), at
 * most six (the strip layout breaks visual rhythm beyond six).
 */
export class TrustSignalsConfigDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(6)
  @ValidateNested({ each: true })
  @Type(() => TrustSignalItemDto)
  items: TrustSignalItemDto[];
}

/** JSON paths on `StorefrontSection.config` that hold `assetId` strings. */
export const TRUST_SIGNALS_ASSET_ID_PATHS: ReadonlyArray<readonly string[]> = [];
