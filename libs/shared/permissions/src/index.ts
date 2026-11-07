/**
 * Canonical permission catalogue. The single source of truth for every
 * `<module>:<action>` string the RBAC layer accepts, enforces, or renders.
 *
 * Dependency-free on purpose. Three independent copies used to exist (the Nest
 * decorator, `prisma/seed.ts`, and the roles grid, which derived its columns
 * from whatever was in the database) and they drifted: ten module keys reached
 * the operator's screen that zero endpoints ever checked. Every consumer now
 * imports this file:
 *
 * - `@common/decorators` re-exports it for `@Permissions('<module>:<action>')`.
 * - `apps/api/src/modules/users/dto/admin/*` validates grants against
 *   `PERMISSION_STRINGS` (membership, not just format).
 * - The admin roles grid renders these columns and its request schemas send
 *   only these values.
 *
 * `prisma/permission-catalogue.ts` is a hand-maintained copy, because the prod
 * runtime image ships `prisma/` but not `libs/`. `apps/api/src/permission-catalogue.parity.spec.ts`
 * fails the moment the two diverge.
 *
 * Adding a module: add it here (alphabetically), mirror it in
 * `prisma/permission-catalogue.ts`, and give it at least one enforcing
 * `@Permissions` route. `apps/api/src/permission-key-drift.spec.ts` asserts
 * both directions.
 */
export const PERMISSION_MODULES = Object.freeze([
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
] as const);

/**
 * Action verbs that pair with each module. Read-tier endpoints use `view`;
 * mutation tiers use `create` / `update` / `delete`; `manage` is reserved for
 * full-CRUD-plus-side-effects per spec §4.2.
 */
export const PERMISSION_ACTIONS = Object.freeze([
  'view',
  'create',
  'update',
  'delete',
  'manage',
] as const);

export type PermissionModule = (typeof PERMISSION_MODULES)[number];
export type PermissionAction = (typeof PERMISSION_ACTIONS)[number];

/** Template-literal union of every legal permission string. */
export type Permission = `${PermissionModule}:${PermissionAction}`;

/**
 * The full module x action cross product. Non-empty readonly tuple so it can
 * feed `z.enum(...)` client-side and `@IsIn(...)` server-side unchanged.
 */
export const PERMISSION_STRINGS = Object.freeze(
  PERMISSION_MODULES.flatMap((mod) =>
    PERMISSION_ACTIONS.map((action) => `${mod}:${action}` as Permission),
  ),
) as readonly [Permission, ...Permission[]];

/** Type guard for values arriving from the wire or a legacy database row. */
export function isPermission(value: string): value is Permission {
  return (PERMISSION_STRINGS as readonly string[]).includes(value);
}
