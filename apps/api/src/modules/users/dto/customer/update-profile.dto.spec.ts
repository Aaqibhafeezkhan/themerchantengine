import 'reflect-metadata';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  FR_EN_LOCALE_SET,
  NEUTRAL_LOCALE_SET,
  registerScratchLocale,
  storeLocales,
} from '@common/locale';

import { UpdateProfileDto } from './update-profile.dto';

async function errorsFor(payload: object): Promise<string[]> {
  const errors = await validate(plainToInstance(UpdateProfileDto, payload));
  return errors.map((e) => e.property);
}

describe('UpdateProfileDto names', () => {
  it('rejects a blank first or last name', async () => {
    expect(await errorsFor({ firstName: '' })).toEqual(['firstName']);
    expect(await errorsFor({ lastName: '' })).toEqual(['lastName']);
  });

  it('accepts a normal name', async () => {
    expect(await errorsFor({ firstName: 'Sam', lastName: 'Lee' })).toEqual([]);
  });
});

describe('UpdateProfileDto locale', () => {
  afterEach(() => storeLocales.set(NEUTRAL_LOCALE_SET));

  it('accepts an enabled locale', async () => {
    storeLocales.set(FR_EN_LOCALE_SET);
    expect(await errorsFor({ locale: 'en' })).toEqual([]);
  });

  it('rejects a well formed locale the store has not enabled', async () => {
    storeLocales.set(FR_EN_LOCALE_SET);
    expect(await errorsFor({ locale: 'ar' })).toEqual(['locale']);
  });

  it('rejects an unknown locale', async () => {
    storeLocales.set(FR_EN_LOCALE_SET);
    expect(await errorsFor({ locale: 'xx' })).toEqual(['locale']);
  });

  it('accepts a registry locale beyond fr, en and ar once enabled', async () => {
    const remove = registerScratchLocale('de');
    try {
      storeLocales.set({
        supportedLocales: ['fr', 'de'],
        defaultLocale: 'fr',
        rtlLocales: [],
        timezone: 'UTC',
      });
      expect(await errorsFor({ locale: 'de' })).toEqual([]);
    } finally {
      remove();
    }
  });

  it('leaves the field optional', async () => {
    expect(await errorsFor({})).toEqual([]);
  });
});
