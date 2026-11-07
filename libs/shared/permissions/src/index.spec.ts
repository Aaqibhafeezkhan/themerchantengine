import {
  PERMISSION_ACTIONS,
  PERMISSION_MODULES,
  PERMISSION_STRINGS,
  type Permission,
} from './index';

describe('permission catalogue', () => {
  describe('PERMISSION_MODULES', () => {
    it('declares the 26 modules the api enforces', () => {
      expect(PERMISSION_MODULES).toHaveLength(26);
    });

    it('is sorted alphabetically (lock against diff churn)', () => {
      expect([...PERMISSION_MODULES]).toEqual([...PERMISSION_MODULES].sort());
    });

    it('holds no duplicates', () => {
      expect(new Set(PERMISSION_MODULES).size).toBe(PERMISSION_MODULES.length);
    });

    it('uses underscore separators only (hyphenated twins are the drift this lib removes)', () => {
      for (const mod of PERMISSION_MODULES) {
        expect(mod).toMatch(/^[a-z][a-z0-9_]*$/);
      }
    });

    it('is frozen', () => {
      expect(Object.isFrozen(PERMISSION_MODULES)).toBe(true);
    });
  });

  describe('PERMISSION_ACTIONS', () => {
    it('matches the canonical 5-verb tuple', () => {
      expect([...PERMISSION_ACTIONS]).toEqual(['view', 'create', 'update', 'delete', 'manage']);
    });

    it('is frozen', () => {
      expect(Object.isFrozen(PERMISSION_ACTIONS)).toBe(true);
    });
  });

  describe('PERMISSION_STRINGS', () => {
    it('is the full 26 x 5 cross product', () => {
      expect(PERMISSION_STRINGS).toHaveLength(130);
    });

    it('holds only well-formed module:action pairs drawn from the two source tuples', () => {
      for (const value of PERMISSION_STRINGS) {
        const [mod, action] = value.split(':');
        expect(PERMISSION_MODULES).toContain(mod);
        expect(PERMISSION_ACTIONS).toContain(action);
      }
    });

    it('holds no duplicates', () => {
      expect(new Set(PERMISSION_STRINGS).size).toBe(PERMISSION_STRINGS.length);
    });

    it('excludes every orphan key the seed used to grant', () => {
      const orphans = [
        'audit-logs:view',
        'currencies:view',
        'gift-cards:view',
        'payment-methods:view',
        'rbac:manage',
        'refunds:create',
        'roles:view',
        'staff:view',
        'tax:view',
        'users:view',
      ];
      for (const orphan of orphans) {
        expect(PERMISSION_STRINGS).not.toContain(orphan);
      }
    });

    it('is frozen', () => {
      expect(Object.isFrozen(PERMISSION_STRINGS)).toBe(true);
    });
  });

  describe('Permission template-literal union', () => {
    it('accepts legal module:action combinations at compile time', () => {
      const legal: Permission = 'products:view';
      expect(legal).toBe('products:view');
    });

    it('rejects illegal modules at compile time', () => {
      // @ts-expect-error 'gift-cards:view' is the hyphenated twin, not a member of the union
      const illegal: Permission = 'gift-cards:view';
      expect(illegal).toBe('gift-cards:view');
    });

    it('rejects illegal actions at compile time', () => {
      // @ts-expect-error 'archive' is not in PERMISSION_ACTIONS
      const illegal: Permission = 'products:archive';
      expect(illegal).toBe('products:archive');
    });
  });
});
