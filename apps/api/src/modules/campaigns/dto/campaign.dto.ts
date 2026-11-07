import { IsEnabledLocaleValue } from '../../../common/dto/translatable-locale-keys.dto';
import { Type } from 'class-transformer';
import {
  IsDefined,
  IsISO8601,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { CAMPAIGN_KINDS, CAMPAIGN_SEGMENTS, CAMPAIGN_STATUSES } from '../campaigns.constants';
import { MAIL_LOCALES, type MailLocale } from '../../mail/mail.types';
import { TranslatableLocaleKeysDto } from '../../../common/dto/translatable-locale-keys.dto';

/**
 * Campaign subject and body: `default` plus one decorated key per catalogue
 * locale, each gated on the store's enabled set by the shared base.
 */
export class CampaignTranslatableDto extends TranslatableLocaleKeysDto {
  @IsString()
  @IsOptional()
  default?: string;
}

export class CreateCampaignDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsDefined()
  @ValidateNested()
  @Type(() => CampaignTranslatableDto)
  subject!: CampaignTranslatableDto;

  @IsDefined()
  @ValidateNested()
  @Type(() => CampaignTranslatableDto)
  body!: CampaignTranslatableDto;

  @IsIn(CAMPAIGN_SEGMENTS)
  segment!: (typeof CAMPAIGN_SEGMENTS)[number];

  @IsString()
  @MaxLength(100)
  @IsOptional()
  couponCode?: string | null;

  @IsISO8601()
  @IsOptional()
  scheduledAt?: string | null;
}

export class UpdateCampaignDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  @IsOptional()
  name?: string;

  @ValidateNested()
  @Type(() => CampaignTranslatableDto)
  @IsOptional()
  subject?: CampaignTranslatableDto;

  @ValidateNested()
  @Type(() => CampaignTranslatableDto)
  @IsOptional()
  body?: CampaignTranslatableDto;

  @IsIn(CAMPAIGN_SEGMENTS)
  @IsOptional()
  segment?: (typeof CAMPAIGN_SEGMENTS)[number];

  @IsString()
  @MaxLength(100)
  @IsOptional()
  couponCode?: string | null;

  @IsISO8601()
  @IsOptional()
  scheduledAt?: string | null;
}

export class SendTestCampaignDto {
  @IsIn(MAIL_LOCALES)
  @IsOptional()
  @IsEnabledLocaleValue()
  locale?: MailLocale;
}

export class PreviewCampaignDto {
  @ValidateNested()
  @Type(() => CampaignTranslatableDto)
  @IsOptional()
  subject?: CampaignTranslatableDto;

  @ValidateNested()
  @Type(() => CampaignTranslatableDto)
  @IsOptional()
  body?: CampaignTranslatableDto;

  @IsObject()
  @IsOptional()
  sampleVariables?: Record<string, string>;
}

export class ListCampaignsDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  page?: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  pageSize?: number;

  @IsIn(CAMPAIGN_STATUSES)
  @IsOptional()
  status?: (typeof CAMPAIGN_STATUSES)[number];

  @IsIn(CAMPAIGN_KINDS)
  @IsOptional()
  kind?: (typeof CAMPAIGN_KINDS)[number];
}
