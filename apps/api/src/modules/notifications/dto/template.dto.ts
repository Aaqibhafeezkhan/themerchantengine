import { IsEnabledLocaleValue } from '../../../common/dto/translatable-locale-keys.dto';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDefined,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { OptionalTranslatableBodyDto, TranslatableBodyDto } from './translatable-body.dto';
import { NOTIFICATION_CATEGORIES } from '../../mail/mail.constants';
import { MAIL_LOCALES, type MailLocale } from '../../mail/mail.types';

export const TEMPLATE_CHANNELS = ['email', 'sms', 'push'] as const;
export type TemplateChannel = (typeof TEMPLATE_CHANNELS)[number];

export class CreateNotificationTemplateDto {
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  @Matches(/^[a-z][a-z0-9_.]*$/, {
    message: 'code must be lowercase, dot- or underscore-separated',
  })
  code!: string;

  @ValidateNested()
  @Type(() => OptionalTranslatableBodyDto)
  @IsOptional()
  subject?: OptionalTranslatableBodyDto;

  @IsDefined()
  @ValidateNested()
  @Type(() => TranslatableBodyDto)
  body!: TranslatableBodyDto;

  @IsIn(TEMPLATE_CHANNELS)
  channel!: TemplateChannel;

  @IsString()
  @Matches(/^[a-z][a-z0-9_.]*$/)
  event!: string;

  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @IsOptional()
  variables?: string[];

  @IsBoolean()
  @IsOptional()
  isEnabled?: boolean;

  /** Per-flow kill-switch consulted by MailService.enqueue (NE1). */
  @IsBoolean()
  @IsOptional()
  sendEnabled?: boolean;

  /** Delivery class — drives the NE7 consent gate. */
  @IsIn(NOTIFICATION_CATEGORIES)
  @IsOptional()
  category?: (typeof NOTIFICATION_CATEGORIES)[number];
}

/**
 * Live-preview a DRAFT template (NE6). Renders the supplied subject/body for
 * every enabled locale through the genuine `renderDraft` pipeline + brand layout, with
 * sample-variable substitution. Nothing is persisted. Omitted fields fall back
 * to the saved row so the operator can preview a saved template without
 * resending its whole body.
 */
export class PreviewTemplateDto {
  @ValidateNested()
  @Type(() => OptionalTranslatableBodyDto)
  @IsOptional()
  subject?: OptionalTranslatableBodyDto;

  @ValidateNested()
  @Type(() => OptionalTranslatableBodyDto)
  @IsOptional()
  body?: OptionalTranslatableBodyDto;

  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @IsOptional()
  variables?: string[];

  /** Sample values keyed by variable name; missing tokens default to `[name]`. */
  @IsObject()
  @IsOptional()
  sampleVariables?: Record<string, string>;
}

/**
 * Send a test of this template to the requesting admin's own inbox (NE6).
 * Renders with sample variables and the chosen locale. Honest enqueue outcome
 * is returned (a disabled flow is reported `skipped`, a suppressed recipient
 * `suppressed`).
 */
export class SendTestTemplateDto {
  @IsIn(MAIL_LOCALES)
  @IsOptional()
  @IsEnabledLocaleValue()
  locale?: MailLocale;

  /** Sample values keyed by variable name; missing tokens default to `[name]`. */
  @IsObject()
  @IsOptional()
  variables?: Record<string, string>;
}

export class UpdateNotificationTemplateDto {
  @ValidateNested()
  @Type(() => OptionalTranslatableBodyDto)
  @IsOptional()
  subject?: OptionalTranslatableBodyDto;

  @ValidateNested()
  @Type(() => OptionalTranslatableBodyDto)
  @IsOptional()
  body?: OptionalTranslatableBodyDto;

  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @IsOptional()
  variables?: string[];

  @IsBoolean()
  @IsOptional()
  isEnabled?: boolean;

  /** Per-flow kill-switch consulted by MailService.enqueue (NE1). Disabling a
   *  locked (security/legal) flow is rejected by the service. */
  @IsBoolean()
  @IsOptional()
  sendEnabled?: boolean;

  /** Delivery class — drives the NE7 consent gate. */
  @IsIn(NOTIFICATION_CATEGORIES)
  @IsOptional()
  category?: (typeof NOTIFICATION_CATEGORIES)[number];
}
