/**
 * Hand-maintained copy of `libs/shared/permissions` (`@permissions`).
 *
 * Why a copy and not an import: the prod runtime image copies `prisma/` but not
 * `libs/` (see `apps/api/Dockerfile`), so `ts-node prisma/seed.ts` inside the
 * container cannot resolve `@permissions`. The seed keeps the same
 * self-containment promise as `prisma/notification-template-defaults.ts`.
 *
 * Keep both files identical. `apps/api/src/permission-catalogue.parity.spec.ts`
 * asserts deep equality and turns `npx nx test api` red the moment they drift.
 */
export const PERMISSION_MODULES = [
  'admin_users',
  'analytics',
  'assets',
  'audit_log',
  'campaigns',
  'carriers',
  'categories',
  'checkout',
  'cms',
  'customers',
  'geo',
  'gift_cards',
  'inventory',
  'notifications',
  'orders',
  'payment_methods',
  'payments',
  'products',
  'promotions',
  'returns',
  'reviews',
  'search',
  'seo',
  'settings',
  'shipping',
  'storefront_config',
] as const;

export const PERMISSION_ACTIONS = ['view', 'create', 'update', 'delete', 'manage'] as const;

export type PermissionModule = (typeof PERMISSION_MODULES)[number];
export type PermissionAction = (typeof PERMISSION_ACTIONS)[number];
export type Permission = `${PermissionModule}:${PermissionAction}`;

export const PERMISSION_STRINGS: readonly Permission[] = PERMISSION_MODULES.flatMap((mod) =>
  PERMISSION_ACTIONS.map((action) => `${mod}:${action}` as Permission),
);
