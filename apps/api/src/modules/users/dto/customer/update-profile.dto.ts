import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { PHONE_RE, normalizePhone } from '@common/utils';
import { IsEnabledLocaleValue } from '../../../../common/dto/translatable-locale-keys.dto';

export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  firstName?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  lastName?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  // Grouping characters are stripped first, so `+216 71 000 000` and
  // `+21671000000` are the same number and only one form is stored.
  @Transform(({ value }) => normalizePhone(value))
  @Matches(PHONE_RE, { message: 'Invalid phone number format' })
  phone?: string;

  @IsOptional()
  @IsUrl()
  avatarUrl?: string;

  /** Required when email or newPassword is provided */
  @IsOptional()
  @IsString()
  currentPassword?: string;

  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/, {
    message:
      'Password must contain at least one uppercase letter, one lowercase letter, and one digit',
  })
  newPassword?: string;

  @IsOptional()
  @IsString()
  @IsEnabledLocaleValue()
  locale?: string;
}
