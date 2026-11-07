import type { PaymentProviderCatalogueEntry } from '@admin-services';
import {
  activeTone,
  displayConfigValue,
  findProvider,
  isMasked,
  isSecretKey,
  methodLabel,
  providerLabel,
  testModeTone,
} from './payments.utils';

const catalogue: PaymentProviderCatalogueEntry[] = [
  {
    id: 'stripe',
    label: 'Stripe',
    actionTypes: ['embedded', 'redirect'],
    secretFields: ['secretKey', 'webhookSecret'],
    configJsonSchema: {},
  },
  {
    id: 'canary_pay',
    label: 'Canary Pay',
    actionTypes: ['redirect'],
    secretFields: ['merchantPassword'],
    configJsonSchema: {},
  },
];

describe('payments utils', () => {
  describe('providerLabel', () => {
    it('reads the label from the catalogue, including a provider admin never heard of', () => {
      expect(providerLabel('canary_pay', catalogue)).toBe('Canary Pay');
      expect(providerLabel('stripe', catalogue)).toBe('Stripe');
    });
    it('falls back to the raw id when the catalogue has no entry', () => {
      expect(providerLabel('paypal', catalogue)).toBe('paypal');
      expect(providerLabel('unknown')).toBe('unknown');
    });
  });

  describe('findProvider', () => {
    it('finds an entry by id or returns null', () => {
      expect(findProvider('canary_pay', catalogue)?.label).toBe('Canary Pay');
      expect(findProvider('nope', catalogue)).toBeNull();
      expect(findProvider('canary_pay', [])).toBeNull();
    });
  });

  describe('activeTone', () => {
    it('maps isActive to tone', () => {
      expect(activeTone(true)).toBe('success');
      expect(activeTone(false)).toBe('neutral');
    });
  });

  describe('testModeTone', () => {
    it('surfaces warning only in test mode', () => {
      expect(testModeTone(true)).toBe('warning');
      expect(testModeTone(false)).toBeNull();
    });
  });

  describe('methodLabel', () => {
    it('resolves in the operator locale', () => {
      const name = { default: 'Card', fr: 'Carte bancaire', en: 'Card' } as never;
      expect(methodLabel({ name, code: 'c' }, 'fr', 'xx')).toBe('Carte bancaire');
      expect(methodLabel({ name, code: 'c' }, 'en', 'xx')).toBe('Card');
    });
    it('falls back to default, then code', () => {
      expect(
        methodLabel({ name: { default: 'x', en: 'English' } as never, code: 'c' }, 'fr', 'xx'),
      ).toBe('x');
      expect(methodLabel({ name: { default: 'D' } as never, code: 'c' }, 'fr', 'xx')).toBe('D');
      expect(methodLabel({ name: {} as never, code: 'c' }, 'fr', 'xx')).toBe('c');
    });
  });

  describe('secret helpers', () => {
    it('isSecretKey follows the catalogue secretFields', () => {
      const canary = findProvider('canary_pay', catalogue);
      expect(isSecretKey('merchantPassword', canary)).toBe(true);
      expect(isSecretKey('merchantId', canary)).toBe(false);
    });
    it('isSecretKey keeps the legacy names for providers with no catalogue entry', () => {
      expect(isSecretKey('apiKey', null)).toBe(true);
      expect(isSecretKey('publishableKey', null)).toBe(false);
    });
    it('isMasked detects the placeholder', () => {
      expect(isMasked('***')).toBe(true);
      expect(isMasked('real')).toBe(false);
    });
  });

  describe('displayConfigValue', () => {
    it('labels stored secrets without leaking the value', () => {
      expect(displayConfigValue('apiKey', '***')).toBe('Stored (hidden)');
    });
    it('hides a catalogue-declared secret of an unknown provider', () => {
      const canary = findProvider('canary_pay', catalogue);
      expect(displayConfigValue('merchantPassword', '***', canary)).toBe('Stored (hidden)');
    });
    it('shows plain values for non-secret keys', () => {
      expect(displayConfigValue('publishableKey', 'pk_live_x')).toBe('pk_live_x');
    });
    it('formats booleans + nulls readably', () => {
      expect(displayConfigValue('flag', true)).toBe('Yes');
      expect(displayConfigValue('flag', null)).toBe('—');
    });
  });
});
