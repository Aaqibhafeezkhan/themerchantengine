import * as fs from 'fs';
import * as path from 'path';
import { Test } from '@nestjs/testing';
import PDFDocument from 'pdfkit';
import { SettingsService } from '../settings/settings.service';
import {
  InvoicePdfService,
  InvoicePdfSnapshot,
  InvoicePdfOrderRef,
  InvoiceLocale,
  invoiceLocaleOf,
  invoiceLocales,
  composeSellerLines,
  buildTotalsBlock,
  deriveVatRate,
  drawPartyBlock,
  formatInvoiceDate,
  formatVatRate,
  LABELS,
  MONTHS,
  pickTranslatable,
  registerInvoiceFonts,
  invoiceFontFiles,
  isRtlLocale,
  mirrorX,
  textEdge,
  printable,
  shapeMixedRuns,
} from './invoice-pdf.service';
import { storeMoney } from '@common/money';
import {
  NEUTRAL_LOCALE_SET,
  fontKitCoversLocale,
  registryLocaleCodes,
  storeLocales,
} from '@common/locale';
import { MoneyFormatterService } from '../currencies/money-formatter.service';
import { ConfigService } from '@nestjs/config';

// Seeded business/general blocks, exercises the full seller header (not the
// degraded tradingName-only path).
const BUSINESS = {
  tradingName: { default: 'Atlas Supplies', fr: 'Atlas Supplies', en: 'Atlas Supplies' },
  legalName: {
    default: 'Atlas Supplies SARL',
    fr: 'Atlas Supplies SARL',
    en: 'Atlas Supplies SARL',
  },
  taxRegistrationNumber: '1234567/A/M/000',
  streetAddress: {
    default: '12 rue de Marseille',
    fr: '12 rue de Marseille',
    en: '12 rue de Marseille',
  },
  addressLocality: 'Tripoli',
  addressCountry: 'LY',
  telephone: '+218 21 000 000',
};
const GENERAL = { contactEmail: 'contact@atlas.example', phone: '' };

function settingsMock(): Pick<SettingsService, 'getGroup'> {
  return {
    getGroup: jest.fn(async (group: string) =>
      group === 'business' ? BUSINESS : group === 'general' ? GENERAL : {},
    ),
  } as unknown as SettingsService;
}

const ORDER: InvoicePdfOrderRef = { orderNumber: 'ORD-2026-000001', currency: 'LYD' };

function invoiceFixture(locale: InvoiceLocale): InvoicePdfSnapshot {
  const names = {
    fr: ['Composite photopolymérisable A2', 'Fraise diamantée turbine', 'Gants nitrile taille M'],
    en: ['Light-cure composite A2', 'Diamond turbine bur', 'Nitrile gloves size M'],
    ar: ['راتنج ضوئي التصلب A2', 'سنبلة ماسية للتوربين', 'قفازات نيتريل مقاس M'],
  }[locale];
  const shippingMethodName = {
    fr: 'Livraison standard',
    en: 'Standard shipping',
    ar: 'شحن عادي',
  }[locale];
  const billingAddress = {
    fr: {
      fullName: 'Dr Amine Ben Salah',
      phone: '+216 98 000 000',
      addressLine1: '5 avenue Habib Bourguiba',
      city: 'Sfax',
      country: 'TN',
    },
    en: {
      fullName: 'Dr Amine Ben Salah',
      phone: '+216 98 000 000',
      addressLine1: '5 Habib Bourguiba Avenue',
      city: 'Sfax',
      country: 'TN',
    },
    ar: {
      fullName: 'د. أمين بن صالح',
      phone: '+216 98 000 000',
      addressLine1: '5 شارع الحبيب بورقيبة',
      city: 'صفاقس',
      country: 'TN',
    },
  }[locale];
  return {
    invoiceNumber: 'INV-2026-000001',
    items: [
      { productName: names[0], sku: 'COMP-A2-4G', unitPrice: 120.5, quantity: 1, total: 120.5 },
      { productName: names[1], sku: 'FRA-DIA-012', unitPrice: 45.75, quantity: 2, total: 91.5 },
      { productName: names[2], sku: 'GAN-NIT-M', unitPrice: 15.125, quantity: 3, total: 45.375 },
    ],
    subtotal: 257.375,
    discountAmount: 6,
    shippingAmount: 10,
    taxAmount: 47.761,
    total: 309.136,
    shippingMethodName,
    billingAddress,
    issuedAt: new Date('2026-08-24T09:30:00.000Z'),
  };
}

/**
 * Page objects survive in the PDF as plain dictionaries (pdfkit compresses
 * content streams, not the object table), so the file itself is the evidence
 * for how many sheets the invoice ran to.
 */
function pageCount(buf: Buffer): number {
  return (buf.toString('latin1').match(/\/Type \/Page\n/g) ?? []).length;
}

/**
 * A repeat order the size a dental practice actually places: one line per
 * consumable, well past what a single A4 sheet holds.
 */
function longInvoiceFixture(locale: InvoiceLocale, count: number): InvoicePdfSnapshot {
  const base = invoiceFixture(locale);
  const name = {
    fr: 'Gants nitrile taille M, boîte de 100',
    en: 'Nitrile gloves M, box 100',
    ar: 'قفازات نيتريل، علبة من 100',
  }[locale];
  const items = Array.from({ length: count }, (_, i) => ({
    productName: `${name} (${i + 1})`,
    sku: `GAN-NIT-M-${String(i + 1).padStart(3, '0')}`,
    unitPrice: 15.125,
    quantity: 2,
    total: 30.25,
  }));
  const subtotal = 30.25 * count;
  const tax = Math.round(subtotal * 0.19 * 1000) / 1000;
  return {
    ...base,
    items,
    subtotal,
    discountAmount: 0,
    shippingAmount: 10,
    taxAmount: tax,
    total: subtotal + 10 + tax,
  };
}

/** The money formatter over the process snapshot, so amounts follow `storeMoney`. */
function moneyFormatterMock() {
  return {
    format: (value: unknown, code?: string | null) => storeMoney.format(value as never, code),
    currencyCode: () => storeMoney.currencyCode(),
    taxLabel: () => storeMoney.taxLabel(),
    config: () => storeMoney.current(),
  };
}

describe('InvoicePdfService', () => {
  let service: InvoicePdfService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        InvoicePdfService,
        { provide: SettingsService, useValue: settingsMock() },
        { provide: MoneyFormatterService, useValue: moneyFormatterMock() },
        { provide: ConfigService, useValue: { get: () => undefined } },
      ],
    }).compile();
    service = moduleRef.get(InvoicePdfService);
  });

  const dumpDir = process.env.INVOICE_PDF_DUMP_DIR;
  const dump = (name: string, buf: Buffer) => {
    if (!dumpDir) return;
    fs.mkdirSync(dumpDir, { recursive: true });
    fs.writeFileSync(path.join(dumpDir, name), buf);
  };

  it.each([...invoiceLocales()])('renders a valid, non-empty PDF (%s)', async (locale) => {
    const buf = await service.render({ invoice: invoiceFixture(locale), order: ORDER, locale });
    dump(`invoice-${locale}.pdf`, buf);

    expect(Buffer.isBuffer(buf)).toBe(true);
    // %PDF magic + EOF marker → structurally a PDF.
    expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(buf.subarray(-1024).toString('latin1')).toContain('%%EOF');
    // Real content (rules, table, totals, four embedded font subsets), a blank
    // page is ~1-2 KB.
    expect(buf.length).toBeGreaterThan(8000);
  });

  it('embeds the four brand faces and none of the retired ones', async () => {
    const buf = await service.render({ invoice: invoiceFixture('fr'), order: ORDER, locale: 'fr' });
    const raw = buf.toString('latin1');
    // Subset font names survive in the PDF's font descriptors, so the document
    // itself is the evidence that the brand faces are the ones embedded.
    for (const face of ['Inter', 'Baloo', 'JetBrains']) {
      expect(raw).toContain(face);
    }
    expect(raw).not.toContain('Tajawal');
  });

  it('produces locale-distinct output (fr ≠ en)', async () => {
    const fr = await service.render({ invoice: invoiceFixture('fr'), order: ORDER, locale: 'fr' });
    const en = await service.render({ invoice: invoiceFixture('en'), order: ORDER, locale: 'en' });
    expect(Buffer.compare(fr, en)).not.toBe(0);
  });

  it('renders the degraded seller header when only tradingName is seeded', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        InvoicePdfService,
        { provide: MoneyFormatterService, useValue: moneyFormatterMock() },
        { provide: ConfigService, useValue: { get: () => undefined } },
        {
          provide: SettingsService,
          useValue: {
            getGroup: jest.fn(async (group: string) =>
              group === 'business'
                ? {
                    tradingName: {
                      default: 'Atlas Supplies',
                      fr: 'Atlas Supplies',
                      en: 'Atlas Supplies',
                    },
                    addressCountry: 'LY',
                  }
                : {},
            ),
          },
        },
      ],
    }).compile();
    const svc = moduleRef.get(InvoicePdfService);
    const buf = await svc.render({ invoice: invoiceFixture('fr'), order: ORDER, locale: 'fr' });
    expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(buf.length).toBeGreaterThan(8000);
  });

  it('renders with a null billing address and zero discount without throwing', async () => {
    const inv = invoiceFixture('fr');
    inv.billingAddress = null;
    inv.discountAmount = 0;
    const buf = await service.render({ invoice: inv, order: ORDER, locale: 'fr' });
    expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('keeps an ordinary order on one page', async () => {
    const buf = await service.render({ invoice: invoiceFixture('fr'), order: ORDER, locale: 'fr' });
    expect(pageCount(buf)).toBe(1);
  });

  it('renders a buyer whose address wraps the column', async () => {
    // The whole-document companion to the `drawPartyBlock` measurements below,
    // and the sample the dump hook makes inspectable.
    const inv = invoiceFixture('fr');
    inv.billingAddress = {
      fullName: 'Docteur Amine Ben Salah, cabinet dentaire du centre-ville',
      phone: '+216 98 000 000',
      addressLine1: 'Résidence les Jasmins, bloc C, 14 rue Ibn Khaldoun',
      addressLine2: 'Immeuble Corail, 3e étage, porte 12',
      city: 'Le Bardo',
      postalCode: '2000',
      country: 'TN',
    };
    const buf = await service.render({ invoice: inv, order: ORDER, locale: 'fr' });
    dump('invoice-wrapped-fr.pdf', buf);
    expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pageCount(buf)).toBe(1);
  });

  it.each([...invoiceLocales()])(
    'paginates a long order instead of overprinting the footer (%s)',
    async (locale) => {
      // A distributor's monthly consumables order is routinely this long; the
      // table used to run straight through the footer rule at y=760.
      const inv = longInvoiceFixture(locale, 40);
      const buf = await service.render({ invoice: inv, order: ORDER, locale });
      dump(`invoice-long-${locale}.pdf`, buf);

      expect(pageCount(buf)).toBeGreaterThan(1);
      expect(buf.subarray(-1024).toString('latin1')).toContain('%%EOF');
    },
  );

  it('grows the sheet count monotonically across the page boundary', async () => {
    // Walks the band where the last row, then the totals block, stop fitting.
    // Adding a line may turn the page; it may never take one away.
    const counts: number[] = [];
    for (let items = 10; items <= 14; items++) {
      const buf = await service.render({
        invoice: longInvoiceFixture('fr', items),
        order: ORDER,
        locale: 'fr',
      });
      counts.push(pageCount(buf));
    }
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
    expect(counts[0]).toBe(1);
    expect(counts[counts.length - 1]).toBe(2);
  }, 60000);

  it('terminates on a single row taller than a whole page', async () => {
    // The page-turn guard: without it a row that cannot fit anywhere would ask
    // for a fresh page forever.
    const inv = invoiceFixture('fr');
    inv.items = [{ ...inv.items[0], productName: 'Consommable '.repeat(600) }];
    const buf = await service.render({ invoice: inv, order: ORDER, locale: 'fr' });
    expect(buf.subarray(-1024).toString('latin1')).toContain('%%EOF');
  });

  it('embeds Tajawal for ar and not for fr or en', async () => {
    const ar = await service.render({ invoice: invoiceFixture('ar'), order: ORDER, locale: 'ar' });
    expect(ar.toString('latin1')).toContain('Tajawal');
    for (const locale of ['fr', 'en'] as InvoiceLocale[]) {
      const buf = await service.render({ invoice: invoiceFixture(locale), order: ORDER, locale });
      expect(buf.toString('latin1')).not.toContain('Tajawal');
    }
  });

  describe('single-run layout', () => {
    const proto = PDFDocument.prototype as unknown as Record<
      'text' | 'widthOfString' | 'heightOfString',
      (...args: unknown[]) => unknown
    >;
    const METHODS = ['text', 'widthOfString', 'heightOfString'] as const;

    const calls = async (locale: InvoiceLocale) => {
      const seen: { text: string; features: unknown }[] = [];
      const spies = METHODS.map((m) => {
        const original = proto[m];
        const spy = jest.spyOn(proto, m).mockImplementation(function (
          this: unknown,
          ...args: unknown[]
        ) {
          const options = (args.find((a) => typeof a === 'object' && a !== null) ?? {}) as {
            features?: unknown;
          };
          seen.push({ text: String(args[0]), features: options.features });
          return original.apply(this, args);
        });
        return spy;
      });
      try {
        await service.render({ invoice: invoiceFixture(locale), order: ORDER, locale });
      } finally {
        spies.forEach((s) => s.mockRestore());
      }
      return seen;
    };

    it('gives every Arabic string a features list so pdfkit keeps it as one run', async () => {
      const arabic = (await calls('ar')).filter((c) => /[؀-ۿ]/.test(c.text));
      expect(arabic.length).toBeGreaterThan(10);
      expect(arabic.filter((c) => !c.features).map((c) => c.text)).toEqual([]);
    });

    it('leaves fr and en layout calls without the Arabic run options', async () => {
      const fr = await calls('fr');
      expect(fr.some((c) => c.features && c.text.includes('\u061c'))).toBe(false);
    });
  });
});

/**
 * The layout helpers are exported so the document's actual words can be
 * asserted. A PDF's text is written as subset glyph ids, so a buffer-level
 * assertion cannot read the copy back, the previous generation of this spec
 * could only check that the file was a PDF and that two locales differed, which
 * would have stayed green through a document rendered entirely in the wrong
 * language.
 */
describe('invoice layout helpers', () => {
  describe('composeSellerLines', () => {
    it('prints the tax registration number, which a facture legally requires', () => {
      const lines = composeSellerLines(BUSINESS, GENERAL, 'fr');
      expect(lines).toContain('Matricule fiscal 1234567/A/M/000');
    });

    it('names the country in the document locale', () => {
      expect(composeSellerLines(BUSINESS, GENERAL, 'fr')).toContain('Tripoli, Libye');
      expect(composeSellerLines(BUSINESS, GENERAL, 'en')).toContain('Tripoli, Libya');
    });

    it('drops every blank rather than printing an empty line', () => {
      const lines = composeSellerLines(
        { tradingName: { default: 'Atlas Supplies' }, addressCountry: 'LY' },
        {},
        'fr',
      );
      expect(lines).toEqual(['Atlas Supplies', 'Libye']);
    });

    it('omits the matricule line entirely when no number is seeded', () => {
      const lines = composeSellerLines({ ...BUSINESS, taxRegistrationNumber: '' }, GENERAL, 'fr');
      expect(lines.some((l) => l.startsWith('Matricule'))).toBe(false);
    });

    it('falls back to the general phone when the business block has none', () => {
      const lines = composeSellerLines(
        { ...BUSINESS, telephone: '' },
        { ...GENERAL, phone: '+218 21 700 000' },
        'fr',
      );
      expect(lines).toContain('+218 21 700 000');
    });
  });

  describe('formatInvoiceDate', () => {
    // The date is read in the store zone (runtime config, neutral UTC). Paris
    // is +01:00 on both boundary dates below, so the expected strings hold.
    beforeAll(() => storeLocales.set({ ...NEUTRAL_LOCALE_SET, timezone: 'Europe/Paris' }));
    afterAll(() => storeLocales.set(NEUTRAL_LOCALE_SET));

    it('writes the French month in words', () => {
      expect(formatInvoiceDate(new Date('2026-08-24T09:30:00.000Z'), 'fr')).toBe('24 août 2026');
    });

    it('writes the English month abbreviated', () => {
      expect(formatInvoiceDate(new Date('2026-08-24T09:30:00.000Z'), 'en')).toBe('24 Aug 2026');
    });

    it('reads the date in the store zone, so a late-evening UTC issue is already tomorrow', () => {
      // 23:30 UTC on 1 January is 00:30 on 2 January in the store zone, which is the
      // date the facture legally carries.
      expect(formatInvoiceDate(new Date('2026-01-01T23:30:00.000Z'), 'fr')).toBe('2 janvier 2026');
    });

    it('dates an invoice issued just after midnight store time to that day', () => {
      const justAfterMidnight = new Date('2026-03-15T00:10:00+01:00');
      expect(formatInvoiceDate(justAfterMidnight, 'fr')).toBe('15 mars 2026');
      expect(formatInvoiceDate(justAfterMidnight, 'en')).toBe('15 Mar 2026');
      // The same instant is still 14 March in UTC, which is what the field used
      // to print.
      expect(justAfterMidnight.getUTCDate()).toBe(14);
    });

    it('does not move a mid-morning date', () => {
      expect(formatInvoiceDate(new Date('2026-08-24T09:30:00.000Z'), 'en')).toBe('24 Aug 2026');
    });
  });

  describe('deriveVatRate', () => {
    it('recovers the standard rate from the fixture amounts', () => {
      // 257.375 - 6 = 251.375 taxable, and 251.375 x 0.19 = 47.76125, the
      // millime of which is the 47.761 the snapshot carries.
      expect(deriveVatRate(invoiceFixture('fr'))).toBe(19);
    });

    it('takes the base after discount, not before it', () => {
      // 19 per cent of the pre-discount 257.375 would be 48.901; deriving from
      // that base is what would print a wrong rate on a correct invoice.
      const preDiscount = { subtotal: 257.375, discountAmount: 6, taxAmount: 48.901 };
      expect(deriveVatRate(preDiscount)).toBeNull();
    });

    it('excludes shipping from the base, per plan §2.7', () => {
      // The same invoice with the delivery charge folded into the base derives
      // to nothing, which is the proof shipping is left out.
      expect(deriveVatRate({ subtotal: 261.375, discountAmount: 0, taxAmount: 47.761 })).toBeNull();
    });

    it('cannot tell a clean blend from a real rate, and says so', () => {
      // 100 at 19 per cent plus 100 at 7 per cent is an effective 13 per cent,
      // which no line on the invoice was actually charged at, and the check
      // reproduces it exactly. The guard is arithmetic, not a single-rate
      // proof; this pins the limit rather than a claim the function does not
      // make. Unreachable while orders carry one rate (see the docblock).
      expect(deriveVatRate({ subtotal: 200, discountAmount: 0, taxAmount: 26 })).toBe(13);
      // A blend that lands off a tenth of a point does derive to nothing.
      expect(deriveVatRate({ subtotal: 200, discountAmount: 0, taxAmount: 26.417 })).toBeNull();
    });

    it('derives the reduced rates too', () => {
      expect(deriveVatRate({ subtotal: 1000, discountAmount: 0, taxAmount: 130 })).toBe(13);
      expect(deriveVatRate({ subtotal: 1000, discountAmount: 0, taxAmount: 70 })).toBe(7);
    });

    it('returns null when there is no base to divide by', () => {
      expect(deriveVatRate({ subtotal: 0, discountAmount: 0, taxAmount: 0 })).toBeNull();
      expect(deriveVatRate({ subtotal: 100, discountAmount: 100, taxAmount: 19 })).toBeNull();
      expect(deriveVatRate({ subtotal: 100, discountAmount: 0, taxAmount: -19 })).toBeNull();
    });

    it('reads an exonerated invoice as a clean zero', () => {
      expect(deriveVatRate({ subtotal: 100, discountAmount: 0, taxAmount: 0 })).toBe(0);
    });
  });

  /**
   * The labels the totals block actually prints.
   *
   * `38c9b98a` is named after the missing VAT rate, and every other assertion
   * in this file targets a helper rather than the block that prints it, so
   * deleting the rate from its own label left the suite green. pdfkit
   * compresses its content streams, so a rendered buffer cannot be searched for
   * a string; asserting the data the renderer draws from is what makes a revert
   * visible.
   */
  describe('buildTotalsBlock', () => {
    const NBSP = String.fromCodePoint(0x00a0);

    function labelsOf(locale: InvoiceLocale, over: Partial<InvoicePdfSnapshot> = {}): string[] {
      const invoice = { ...invoiceFixture(locale), ...over };
      const block = buildTotalsBlock(invoice, {
        L: LABELS[locale],
        locale,
        money: (n: number) => n.toFixed(3),
      });
      return [...block.rows.map((r) => r.label), block.total.label];
    }

    it('prints the derived rate beside the VAT label', () => {
      expect(labelsOf('fr')).toContain(`TVA 19${NBSP}%`);
      expect(labelsOf('en')).toContain('VAT 19%');
    });

    it('prints the VAT label alone when the rate does not derive', () => {
      // Shipping folded into the base derives to nothing (see deriveVatRate).
      const over = { subtotal: 261.375, discountAmount: 0, taxAmount: 47.761 };
      expect(labelsOf('fr', over)).toContain('TVA');
      expect(labelsOf('fr', over).join(' ')).not.toContain('%');
    });

    it('calls the discount an HT figure, because it comes off an HT base', () => {
      const over = { discountAmount: 6 };
      expect(labelsOf('fr', over)).toContain('Remise HT');
      expect(labelsOf('en', over)).toContain('Discount excl. VAT');
    });

    it('omits the discount row entirely when there is no discount', () => {
      expect(labelsOf('fr', { discountAmount: 0 })).not.toContain('Remise HT');
    });

    it('marks the shipping row TTC, since it carries no VAT', () => {
      expect(labelsOf('fr', { shippingMethodName: null }).join(' ')).toContain('Livraison TTC');
      expect(labelsOf('en', { shippingMethodName: null }).join(' ')).toContain(
        'Shipping incl. VAT',
      );
    });

    it('uses the shipping method name as the label when there is one', () => {
      const rows = labelsOf('fr', { shippingMethodName: 'Livraison standard' });
      expect(rows.join(' ')).toContain('Livraison standard TTC');
      // Not "Livraison · Livraison standard", which said the word twice.
      expect(rows.join(' ')).not.toContain('Livraison Livraison');
    });

    it('states a tax basis on every row, per brand floor §3.2', () => {
      const rows = labelsOf('fr', { discountAmount: 6, shippingMethodName: 'Livraison standard' });
      for (const label of rows) {
        // Written as substring checks rather than a word-boundary regex: the
        // escape for a word boundary is one keystroke from a literal backspace,
        // which is the defect that made the salutation rule vacuous.
        expect(['TTC', 'HT', 'TVA'].some((token) => label.includes(token))).toBe(true);
      }
    });
  });

  describe('formatVatRate', () => {
    // Written as a code point rather than typed inline: an invisible no-break
    // space in a source string is unreviewable.
    const NBSP = String.fromCodePoint(0x00a0);

    it('writes the French rate with the no-break space French puts before a sign', () => {
      expect(formatVatRate(19, 'fr')).toBe(`19${NBSP}%`);
      expect(formatVatRate(19, 'en')).toBe('19%');
    });

    it('keeps a fractional rate to one decimal, in the separator each locale uses', () => {
      expect(formatVatRate(7.5, 'fr')).toBe(`7,5${NBSP}%`);
      expect(formatVatRate(7.5, 'en')).toBe('7.5%');
    });
  });

  describe('drawPartyBlock', () => {
    const COL_W = 100;

    function measuringDoc(): PDFKit.PDFDocument {
      const doc = new PDFDocument({ size: 'A4', margin: 40 });
      registerInvoiceFonts(doc, 'fr');
      return doc;
    }

    it('returns a taller block when a line wraps at the column width', () => {
      const short = drawPartyBlock(measuringDoc(), {
        x: 40,
        top: 100,
        width: COL_W,
        heading: 'Émetteur',
        lines: ['Atlas Supplies'],
      });
      const wrapped = drawPartyBlock(measuringDoc(), {
        x: 40,
        top: 100,
        width: COL_W,
        // A real street address at this column width is three lines of type.
        lines: ['Résidence les Jasmins, bloc C, 14 rue Ibn Khaldoun, Le Bardo 2000'],
        heading: 'Émetteur',
      });

      expect(wrapped).toBeGreaterThan(short);
      // More than one fixed 13pt advance: the old constant could not have
      // produced this.
      expect(wrapped - short).toBeGreaterThan(13);
    });

    it('never returns a y above the text it just drew', () => {
      // This is the defect itself: a short return let the items table start on
      // top of the party block.
      const doc = measuringDoc();
      const bottom = drawPartyBlock(doc, {
        x: 40,
        top: 100,
        width: COL_W,
        heading: 'Facturé à',
        lines: [
          'Dr Amine Ben Salah, cabinet dentaire du centre-ville',
          '5 avenue Habib Bourguiba, immeuble Corail, 3e étage',
          'Sfax',
        ],
      });
      expect(bottom).toBeGreaterThanOrEqual(doc.y);
    });

    it('keeps the unwrapped rhythm at one line per entry', () => {
      const doc = measuringDoc();
      const bottom = drawPartyBlock(doc, {
        x: 40,
        top: 100,
        width: 220,
        heading: 'Émetteur',
        lines: ['Atlas Supplies', 'Atlas Supplies SARL', 'Tripoli, Libye'],
      });
      // Heading (15) plus three unwrapped lines at 13.
      expect(bottom).toBe(100 + 15 + 3 * 13);
    });
  });

  describe('invoiceLocales', () => {
    it('is every registry locale the arabic-latin font kit covers', () => {
      const covered = registryLocaleCodes().filter((code) =>
        fontKitCoversLocale('arabic-latin', code),
      );
      expect([...invoiceLocales()]).toEqual(covered);
      expect([...invoiceLocales()]).toEqual(expect.arrayContaining(['fr', 'en', 'ar']));
    });

    it('keeps a typeset locale as itself, Arabic included', () => {
      expect(invoiceLocaleOf('ar')).toBe('ar');
      expect(invoiceLocaleOf('fr')).toBe('fr');
    });

    it('maps an untypeset locale to the store default, then to the first typeset one', () => {
      expect(invoiceLocaleOf('de')).toBe(storeLocales.current().defaultLocale);
    });
  });

  describe('per-locale tables', () => {
    it('gives every typeset locale the same label keys', () => {
      const keys = Object.keys(LABELS.en).sort();
      for (const locale of invoiceLocales()) {
        expect(Object.keys(LABELS[locale]).sort()).toEqual(keys);
        for (const value of Object.values(LABELS[locale])) expect(value.trim()).not.toBe('');
      }
    });

    it('writes a date with a month name in every typeset locale', () => {
      const date = new Date(Date.UTC(2026, 2, 5, 12));
      for (const locale of invoiceLocales()) {
        const text = formatInvoiceDate(date, locale);
        expect(text).toMatch(/^5 \S+ 2026$/);
        expect(text).not.toContain('undefined');
      }
      expect(formatInvoiceDate(date, 'ar')).toBe('5 مارس 2026');
    });

    it('prints the rate with western digits and the locale decimal mark', () => {
      expect(formatVatRate(19, 'ar')).toBe('19%');
      expect(formatVatRate(7.5, 'ar')).toBe('7.5%');
      expect(formatVatRate(7.5, 'fr')).toBe(`7,5${String.fromCodePoint(0xa0)}%`);
    });

    it('falls back through the store default for a Translatable with no entry', () => {
      const storeDefault = storeLocales.current().defaultLocale;
      const other = storeDefault === 'en' ? 'fr' : 'en';
      expect(pickTranslatable({ [storeDefault]: 'default', [other]: 'other' }, 'de' as never)).toBe(
        'default',
      );
      expect(pickTranslatable({ ar: 'مرحبا' }, 'fr')).toBe('مرحبا');
    });
  });

  describe('Arabic faces and right-to-left layout', () => {
    const TAJAWAL_FILES = ['Tajawal-Regular.ttf', 'Tajawal-Bold.ttf'].map((f) =>
      path.resolve(process.cwd(), 'apps/api/assets/fonts', f),
    );

    it('ships the Tajawal faces next to the Latin ones', () => {
      for (const file of TAJAWAL_FILES) expect(fs.existsSync(file)).toBe(true);
    });

    it('maps body, bold and display to Tajawal for Arabic and keeps mono', () => {
      const ar = invoiceFontFiles('ar');
      expect(path.basename(ar.body)).toBe('Tajawal-Regular.ttf');
      expect(path.basename(ar.bold)).toBe('Tajawal-Bold.ttf');
      expect(path.basename(ar.display)).toBe('Tajawal-Bold.ttf');
      expect(path.basename(ar.mono)).toBe('JetBrainsMono-Regular.ttf');
    });

    it('keeps Inter and Baloo 2 for the Latin locales', () => {
      for (const locale of ['fr', 'en'] as InvoiceLocale[]) {
        const files = invoiceFontFiles(locale);
        expect(path.basename(files.body)).toBe('Inter-Regular.ttf');
        expect(path.basename(files.bold)).toBe('Inter-SemiBold.ttf');
        expect(path.basename(files.display)).toBe('Baloo2-SemiBold.ttf');
      }
    });

    it('reads direction from the registry', () => {
      expect(isRtlLocale('ar')).toBe(true);
      expect(isRtlLocale('fr')).toBe(false);
      expect(isRtlLocale('en')).toBe(false);
    });

    it('mirrors a rect across the page and leaves it alone for ltr', () => {
      expect(mirrorX(40, 100, false)).toBe(40);
      // 595.28 - 40 - 100
      expect(mirrorX(40, 100, true)).toBeCloseTo(455.28, 2);
      // Mirroring twice returns the start.
      expect(mirrorX(mirrorX(123, 50, true), 50, true)).toBeCloseTo(123, 6);
    });

    it('flips the text edge only for rtl', () => {
      expect(textEdge('start', false)).toBe('left');
      expect(textEdge('end', false)).toBe('right');
      expect(textEdge('start', true)).toBe('right');
      expect(textEdge('end', true)).toBe('left');
    });

    it('swaps the narrow no-break space for a no-break space in Arabic only', () => {
      const narrow = `1${String.fromCodePoint(0x202f)}234`;
      expect(printable(narrow, 'ar')).toBe(`1${String.fromCodePoint(0xa0)}234`);
      expect(printable(narrow, 'fr')).toBe(narrow);
    });

    it('draws the party block at the right edge of its column for rtl', () => {
      const doc = new PDFDocument({ size: 'A4', margin: 40 });
      registerInvoiceFonts(doc, 'ar');
      const bottom = drawPartyBlock(doc, {
        x: 40,
        top: 100,
        width: 200,
        heading: 'من',
        lines: ['متجر'],
        align: 'right',
      });
      expect(bottom).toBe(100 + 15 + 13);
    });

    it('covers every Arabic label and month character in the bundled face', () => {
      // fontkit is pdfkit's own reader, so this is the set the page can draw.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const fontkit = require('fontkit') as {
        openSync(file: string): { hasGlyphForCodePoint(cp: number): boolean };
      };
      const printed = [...Object.values(LABELS.ar), ...Object.values(MONTHS.ar), '0123456789%.,-/ ']
        .join('')
        .replace(/\s/g, ' ');
      for (const file of TAJAWAL_FILES) {
        const font = fontkit.openSync(file);
        const missing = [...new Set(printed)].filter(
          (ch) => !font.hasGlyphForCodePoint(ch.codePointAt(0) as number),
        );
        expect(missing).toEqual([]);
      }
    });
  });

  describe('pickTranslatable', () => {
    it('prefers the requested locale', () => {
      expect(pickTranslatable({ default: 'd', fr: 'Valeur', en: 'Value' }, 'fr')).toBe('Valeur');
      expect(pickTranslatable({ default: 'd', fr: 'Valeur', en: 'Value' }, 'en')).toBe('Value');
    });

    it('falls back to default, then to the other locale', () => {
      expect(pickTranslatable({ default: 'Defaut' }, 'fr')).toBe('Defaut');
      expect(pickTranslatable({ en: 'Value' }, 'fr')).toBe('Value');
    });

    it('passes a plain string through and coalesces anything else to empty', () => {
      expect(pickTranslatable('Atlas Supplies', 'fr')).toBe('Atlas Supplies');
      expect(pickTranslatable(null, 'fr')).toBe('');
      expect(pickTranslatable(42, 'fr')).toBe('');
    });
  });

  describe('shapeMixedRuns', () => {
    // fontkit reverses a whole run that holds an Arabic letter, digits included.
    // This is the Latin and digit text left on the page, in left-to-right order.
    const visualLatin = (text: string): string => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const fontkit = require('fontkit') as {
        openSync(file: string): {
          layout(t: string): { glyphs: { codePoints: number[] }[] };
        };
      };
      const font = fontkit.openSync(
        path.resolve(process.cwd(), 'apps/api/assets/fonts/Tajawal-Regular.ttf'),
      );
      return font
        .layout(text)
        .glyphs.flatMap((g) => g.codePoints)
        .map((cp) => String.fromCodePoint(cp))
        .join('')
        .replace(/[\u0600-\u06ff\s\u00a0]/g, '');
    };

    it('shows the canary: unshaped text comes out reversed', () => {
      expect(visualLatin('الضريبة 19%')).toBe('%91');
    });

    it('keeps a VAT rate in order', () => {
      expect(visualLatin(shapeMixedRuns('الضريبة 19%'))).toBe('19%');
    });

    it('keeps a date in order', () => {
      expect(visualLatin(shapeMixedRuns('18 أكتوبر 2026'))).toBe('202618');
    });

    it('keeps a tax id in order', () => {
      expect(visualLatin(shapeMixedRuns('الرقم الضريبي MF123456/A'))).toBe('MF123456/A');
    });

    it('keeps a money amount in order', () => {
      expect(visualLatin(shapeMixedRuns('1\u00a0234,500 د.ت'))).toContain('1234,500');
    });

    it('keeps a postal code and city in order', () => {
      expect(visualLatin(shapeMixedRuns('11511 Cairo، القاهرة'))).toBe('11511Cairo');
    });

    it('leaves text without Arabic untouched', () => {
      expect(shapeMixedRuns('19 Rue de la Paix, 75002 Paris')).toBe(
        '19 Rue de la Paix, 75002 Paris',
      );
    });
  });
});
