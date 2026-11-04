import {
  IsBoolean,
  IsIn,
  IsISO8601,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { TranslatableDto } from './translatable.dto';
import { ALLOWED_SECTION_TYPES, type AllowedSectionType } from './configs';

export class CreateSectionAdminDto {
  /**
   * pageSlug is injected by the controller from the URL path parameter
   * (`POST /v1/admin/storefront/pages/:pageSlug/sections`) — it must NOT
   * be present in the request body (docs/admin-api-reference.md §POST sections).
   * Marked optional so the global ValidationPipe does not reject requests
   * that omit it from the body.
   */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Matches(/^[a-z0-9-/]+$/, {
    message: 'pageSlug must be lowercase letters, digits, hyphens, and forward slashes only',
  })
  pageSlug?: string;

  @IsIn(ALLOWED_SECTION_TYPES)
  type: AllowedSectionType;

  /**
   * Translatable section title: { default: string; [locale: string]: string }
   */
  @IsOptional()
  @ValidateNested()
  @Type(() => TranslatableDto)
  title?: TranslatableDto;

  /**
   * Type-specific configuration. Validated against the per-type DTO selected
   * by the `type` discriminator (DR-04, DR-05). The shape depends on `type`:
   * see `dto/configs/*.dto.ts` for each variant. The service layer enforces
   * `whitelist + forbidNonWhitelisted` per constitution §3.5; unknown fields
   * are rejected, not stripped.
   */
  @IsObject()
  config: Record<string, unknown>;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  isVisible?: boolean;

  /** ISO-8601 datetime string — start of the visibility window. */
  @IsOptional()
  @IsISO8601()
  visibleFrom?: string;

  /** ISO-8601 datetime string — end of the visibility window (null = no expiry). */
  @IsOptional()
  @IsISO8601()
  visibleUntil?: string;
}
