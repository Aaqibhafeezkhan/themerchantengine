import {
  PERMISSION_ACTIONS as CATALOGUE_ACTIONS,
  PERMISSION_MODULES as CATALOGUE_MODULES,
  PERMISSION_STRINGS as CATALOGUE_STRINGS,
} from '@permissions';
import {
  PERMISSION_ACTIONS,
  PERMISSION_MODULES,
  PERMISSION_STRINGS,
  Permissions,
  type Permission,
} from './index';

describe('permissions decorator runtime exports', () => {
  describe('re-export identity', () => {
    // The decorator used to own a private copy of the catalogue, which drifted
    // from the seed and the roles grid. It now re-exports `@permissions`, so
    // reference identity is the assertion that keeps the copies from returning.
    it('re-exports the shared catalogue by reference, not by copy', () => {
      expect(PERMISSION_MODULES).toBe(CATALOGUE_MODULES);
      expect(PERMISSION_ACTIONS).toBe(CATALOGUE_ACTIONS);
      expect(PERMISSION_STRINGS).toBe(CATALOGUE_STRINGS);
    });
  });

  describe('PERMISSION_MODULES', () => {
    it('declares 26 module names', () => {
      expect(PERMISSION_MODULES).toHaveLength(26);
    });

    it('includes payments (separate from payment_methods, gates capture, refund and void)', () => {
      expect(PERMISSION_MODULES).toContain('payments');
    });

    it('includes the six modules previously undeclared in agent_docs (§1.13 BLOCKER #2)', () => {
      const previouslyUndeclared = [
        'payment_methods',
        'carriers',
        'geo',
        'checkout',
        'notifications',
        'search',
      ] as const;
      for (const mod of previouslyUndeclared) {
        expect(PERMISSION_MODULES).toContain(mod);
      }
    });

    it('includes campaigns (added by NE9, absent from the stale 24-entry count)', () => {
      expect(PERMISSION_MODULES).toContain('campaigns');
    });

    it('is sorted alphabetically (lock against diff churn)', () => {
      const sorted = [...PERMISSION_MODULES].sort();
      expect([...PERMISSION_MODULES]).toEqual(sorted);
    });
  });

  describe('PERMISSION_ACTIONS', () => {
    it('matches the canonical 5-verb tuple', () => {
      expect([...PERMISSION_ACTIONS]).toEqual(['view', 'create', 'update', 'delete', 'manage']);
    });
  });

  describe('PERMISSION_STRINGS', () => {
    it('exposes every module:action pair the DTOs validate against', () => {
      expect(PERMISSION_STRINGS).toHaveLength(
        PERMISSION_MODULES.length * PERMISSION_ACTIONS.length,
      );
      for (const value of PERMISSION_STRINGS) {
        expect(value).toMatch(/^[a-z][a-z0-9_]*:(view|create|update|delete|manage)$/);
      }
    });
  });

  describe('Permission template-literal union', () => {
    it('accepts legal module:action combinations at compile time', () => {
      const legal: Permission = 'products:view';
      expect(legal).toBe('products:view');
    });

    it('rejects illegal module:action combinations at compile time', () => {
      // @ts-expect-error 'not_a_module:view' is not a member of the Permission union
      const illegal: Permission = 'not_a_module:view';
      expect(illegal).toBe('not_a_module:view');
    });

    it('rejects illegal actions at compile time', () => {
      // @ts-expect-error 'products:archive' — 'archive' is not in PERMISSION_ACTIONS
      const illegal: Permission = 'products:archive';
      expect(illegal).toBe('products:archive');
    });
  });

  describe('Permissions(...) factory', () => {
    it('remains a runtime-string-accepting factory (legacy call-site compat)', () => {
      const decoratorFn = Permissions('products:view');
      expect(typeof decoratorFn).toBe('function');
    });
  });
});
