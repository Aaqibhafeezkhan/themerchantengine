import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';

import {
  fixtureMoney,
  fixtureRuntimeConfig,
  provideFixtureStoreConfig,
} from '../../test-support/store-config-fixtures';
import { PriceComponent } from './price.component';
import { assertAxeClean, renderComponent } from './testing';
import { getChromeStrings } from '../../i18n';

/**
 * Every money assertion here anchors the WHOLE rendered string.
 *
 * The previous generation used fragments, and a fragment match on a money
 * string survives every wrong intermediate, because the correct output
 * contains the fragment. It could never have gone red.
 *
 * The strings come from the `maghreb-ltr` scenario fixture, which
 * `renderComponent` provides by default: a three-decimal currency whose group
 * separator is U+202F. Nothing here states a currency of its own, because a
 * component that states one is the defect this ticket removes.
 */
const MONEY = fixtureMoney('maghreb-ltr');
const SYMBOL = MONEY.symbol;

// Written as escapes on purpose. These two characters are invisible in a
// source file and an editor or a tool that normalises whitespace turns them
// into U+0020 without changing how the line looks, which silently converts
// every assertion below into one that passes on the wrong string.
const NNBSP = '\u202F';
const NBSP = '\u00A0';

describe('PriceComponent', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => TestBed.resetTestingModule());

  it('renders the amount in its own .amount element, at millime precision', async () => {
    const fixture = await renderComponent(PriceComponent, {
      amount: 199.99,
      taxMention: 'none',
      localeOverride: 'en',
    });
    const amount = fixture.nativeElement.querySelector('span.amount');
    expect(amount).not.toBeNull();
    expect(amount?.textContent?.trim()).toBe(`199,990${NBSP}${SYMBOL}`);
  });

  it('renders the configured format: NNBSP groups, comma decimal, symbol after', async () => {
    const fixture = await renderComponent(PriceComponent, {
      amount: 1990,
      taxMention: 'none',
      localeOverride: 'fr',
    });
    const amount = fixture.nativeElement.querySelector('span.amount');
    expect(amount?.textContent?.trim()).toBe(`1${NNBSP}990,000${NBSP}${SYMBOL}`);
  });

  it('renders one format for the store, not one per reader locale', async () => {
    // The money format belongs to the store, not to whoever is reading. Under
    // `Intl` the same amount rendered `50,000` for one locale and `50.000` for
    // another, and an Arabic reader would additionally have got Arabic-Indic
    // digits for a price the shop quotes in western ones.
    const rendered: string[] = [];
    for (const localeOverride of ['fr', 'en'] as const) {
      TestBed.resetTestingModule();
      const fixture = await renderComponent(PriceComponent, {
        amount: 50,
        taxMention: 'none',
        localeOverride,
      });
      rendered.push(fixture.nativeElement.querySelector('span.amount')?.textContent?.trim() ?? '');
    }
    expect(rendered[0]).toBe(`50,000${NBSP}${SYMBOL}`);
    expect(rendered[1]).toBe(rendered[0]);
    expect(rendered[0]).not.toContain(MONEY.currencyCode);
  });

  it('never renders a price with exactly two fraction digits', async () => {
    for (const localeOverride of ['fr', 'en'] as const) {
      TestBed.resetTestingModule();
      const fixture = await renderComponent(PriceComponent, {
        amount: 1990,
        taxMention: 'none',
        localeOverride,
      });
      const amount = fixture.nativeElement.querySelector('span.amount');
      expect(amount?.textContent).not.toMatch(/[.,]\d{2}(?!\d)/);
    }
  });

  it('renders the HT mention when the price is tax-exclusive', async () => {
    const fixture = await renderComponent(PriceComponent, {
      amount: 1240,
      taxMention: 'excluded',
      localeOverride: 'fr',
    });
    expect(fixture.nativeElement.querySelector('.tax-mention')?.textContent?.trim()).toBe('HT');
    expect(fixture.nativeElement.textContent?.replace(/\s+/g, ' ')).toContain('HT');
  });

  it('renders the TTC mention when the price is tax-inclusive, in both locales', async () => {
    for (const localeOverride of ['fr', 'en'] as const) {
      TestBed.resetTestingModule();
      const fixture = await renderComponent(PriceComponent, {
        amount: 1240,
        taxMention: 'included',
        localeOverride,
      });
      expect(fixture.nativeElement.querySelector('.tax-mention')?.textContent?.trim()).toBe('TTC');
    }
  });

  it('renders no mention element when none is asked for', async () => {
    const fixture = await renderComponent(PriceComponent, {
      amount: 1240,
      taxMention: 'none',
      localeOverride: 'fr',
    });
    expect(fixture.nativeElement.querySelector('.tax-mention')).toBeNull();
  });

  it('renders compare-at strike-through + discount badge when compareAt > amount', async () => {
    const fixture = await renderComponent(PriceComponent, {
      amount: 80,
      compareAt: 100,
      taxMention: 'none',
      localeOverride: 'en',
    });
    expect(fixture.nativeElement.querySelector('.compare-at')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.discount-badge')?.textContent).toContain('20');
    expect(fixture.nativeElement.querySelector('.amount')?.classList.contains('discounted')).toBe(
      true,
    );
  });

  it('grounds the discount badge off the accent token, per agent_docs/storefront/brand-tokens.md', async () => {
    // The badge survives the rebrand but must not sit on `--brand-accent`,
    // which has no counterpart in the generated palette, nor on a state colour, which
    // agent_docs/storefront/brand-tokens.md forbids on a promotion.
    const styles = (PriceComponent as unknown as { ɵcmp: { styles: string[] } }).ɵcmp.styles
      .join('\n')
      .replace(/%NS%/g, '');
    const badgeRule = styles.slice(styles.indexOf('.discount-badge'));
    expect(badgeRule).toContain('var(--brand-primary-dark)');
    expect(badgeRule).not.toContain('--brand-accent');
    expect(badgeRule).not.toContain('--brand-success');
    expect(badgeRule).not.toContain('--brand-warning');
    expect(badgeRule).not.toContain('--brand-error');
  });

  it('carries tabular-nums, which agent_docs/storefront/brand-tokens.md makes mandatory', async () => {
    const styles = (PriceComponent as unknown as { ɵcmp: { styles: string[] } }).ɵcmp.styles
      .join('\n')
      .replace(/%NS%/g, '');
    expect(styles).toContain('font-variant-numeric: tabular-nums');
  });

  it('omits compare-at + discount when compareAt is null', async () => {
    const fixture = await renderComponent(PriceComponent, {
      amount: 80,
      taxMention: 'none',
      localeOverride: 'en',
    });
    expect(fixture.nativeElement.querySelector('.compare-at')).toBeNull();
    expect(fixture.nativeElement.querySelector('.discount-badge')).toBeNull();
  });

  it('renders a row carrying its own historical currency at that precision', async () => {
    // An order placed before the cutover keeps the currency it was written in,
    // and a two-decimal currency must not be forced to three.
    const fixture = await renderComponent(PriceComponent, {
      amount: 1240,
      currency: 'EUR',
      taxMention: 'none',
      localeOverride: 'fr',
    });
    expect(fixture.nativeElement.querySelector('span.amount')?.textContent?.trim()).toBe(
      `1${NNBSP}240,00${NBSP}EUR`,
    );
  });

  it('passes axe', async () => {
    const fixture = await renderComponent(PriceComponent, {
      amount: 50,
      taxMention: 'excluded',
      localeOverride: 'en',
    });
    await assertAxeClean(fixture.nativeElement);
  });

  describe('money source', () => {
    it('labels with the configured store currency when the caller passes none', async () => {
      // The defect this closed: the storefront labelled every amount from a
      // baked constant, so the admin currency editor changed nothing a
      // customer could see. The constant is gone; the config is the source.
      const fixture = await renderComponent(
        PriceComponent,
        { amount: 12, taxMention: 'none', localeOverride: 'en' },
        [provideFixtureStoreConfig('gulf-rtl')],
      );
      const gulf = fixtureMoney('gulf-rtl');
      expect(fixture.nativeElement.querySelector('span.amount')?.textContent?.trim()).toBe(
        `${gulf.symbol}${NBSP}12.00`,
      );
    });

    it('lets an explicit currency win, so a historical order keeps its own', async () => {
      const fixture = await renderComponent(
        PriceComponent,
        { amount: 12, currency: 'EUR', taxMention: 'none', localeOverride: 'en' },
        [provideFixtureStoreConfig('gulf-rtl')],
      );
      expect(fixture.nativeElement.querySelector('span.amount')?.textContent?.trim()).toBe(
        `EUR${NBSP}12.00`,
      );
    });

    it('takes the fraction digits from the configured display precision', async () => {
      // The store decides how many digits its own prices show; a three-decimal
      // currency that rendered two would round a real price away. ISO applies
      // only to a row carrying a currency the store does not trade in.
      const fixture = await renderComponent(PriceComponent, {
        amount: 12.345,
        taxMention: 'none',
        localeOverride: 'en',
      });
      expect(MONEY.displayPrecision).toBe(3);
      expect(fixture.nativeElement.querySelector('span.amount')?.textContent?.trim()).toBe(
        `12,345${NBSP}${SYMBOL}`,
      );
    });
  });

  describe('tax mention source', () => {
    // The gate reviewer caught that `money.taxDisplay` had no production
    // reader at all: the call site's word went straight to the screen, so a
    // tax-inclusive store still labelled its catalogue HT and a store that
    // shows no mention got one anyway.
    async function mentionFor(fixture: 'demo' | 'gulf-rtl' | 'maghreb-ltr', kind: string) {
      TestBed.resetTestingModule();
      const fixtureRef = await renderComponent(
        PriceComponent,
        { amount: 12, taxMention: kind, localeOverride: 'en' },
        [provideFixtureStoreConfig(fixture)],
      );
      return fixtureRef.nativeElement.querySelector('.tax-mention')?.textContent?.trim() ?? null;
    }

    it('labels a catalogue price the way the store displays its catalogue', async () => {
      // maghreb-ltr quotes pre-tax, demo quotes tax-inclusive.
      expect(fixtureRuntimeConfig('maghreb-ltr').money.taxDisplay).toBe('HT');
      expect(await mentionFor('maghreb-ltr', 'excluded')).toBe(
        getChromeStrings('en').generic.taxExcluded,
      );

      expect(fixtureRuntimeConfig('demo').money.taxDisplay).toBe('TTC');
      expect(await mentionFor('demo', 'excluded')).toBe(getChromeStrings('en').generic.taxIncluded);
    });

    it('renders no mention at all for a store that displays none', async () => {
      expect(fixtureRuntimeConfig('gulf-rtl').money.taxDisplay).toBe('none');
      expect(await mentionFor('gulf-rtl', 'excluded')).toBeNull();
      expect(await mentionFor('gulf-rtl', 'included')).toBeNull();
    });

    it('labels a charged total tax-inclusive whatever the catalogue quotes', async () => {
      // The figure the customer pays includes tax even where the catalogue
      // quotes without it.
      expect(await mentionFor('maghreb-ltr', 'included')).toBe(
        getChromeStrings('en').generic.taxIncluded,
      );
    });

    it('renders nothing for a breakdown row, whatever the store displays', async () => {
      expect(await mentionFor('demo', 'none')).toBeNull();
      expect(await mentionFor('maghreb-ltr', 'none')).toBeNull();
    });
  });
});
