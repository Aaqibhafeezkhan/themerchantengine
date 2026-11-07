import * as z from 'zod';

import { apiResponseSchema } from '../shared/envelope';

/**
 * Storefront checkout bootstrap schemas — `GET /v1/checkout/settings`.
 *
 * The endpoint answers the two questions the checkout page has to settle
 * before it can render anything: may an anonymous visitor proceed, and which
 * tenders does the operator offer. Both halves used to be admin-only, so the
 * settings round-tripped into a void and the payment-methods module was dead
 * config (findings K3, D1, D3).
 *
 * `name` and `description` are Translatable JSONB on the API side and arrive
 * as plain strings, resolved by the global interceptor against the request's
 * `X-Locale` / `Accept-Language`. Typing them as `string` is deliberate: an
 * object here means the locale header did not travel, and a checkout that
 * renders `[object Object]` as a tender name is worse than one that fails.
 */

/**
 * Keys `PaymentMethod` carries that must never cross the wire. `config` holds
 * provider API keys and webhook secrets; `isTestMode` is operator state a
 * customer has no business reading. The API projects both away twice, and this
 * refinement is the client-side tripwire on top: a future widening of that
 * projection fails checkout loudly rather than quietly publishing a live key.
 */
const FORBIDDEN_METHOD_KEYS = ['config', 'isTestMode'] as const;

export const storefrontPaymentMethodSchema = z
  .object({
    code: z.string().min(1),
    name: z.string(),
    description: z.string().nullable().optional(),
    provider: z.string().min(1),
    sortOrder: z.number().int().optional(),
    /** The provider needs a payment step after the order (redirect, form or embedded). */
    requiresPayment: z.boolean().default(false),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    for (const key of FORBIDDEN_METHOD_KEYS) {
      if (key in value) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `payment method must not expose "${key}"`,
        });
      }
    }
  });

export type StorefrontPaymentMethod = z.infer<typeof storefrontPaymentMethodSchema>;

/**
 * The `checkout` StoreSetting group, exactly the five keys the admin editor
 * writes. Defaults live on the API (`guestCheckoutEnabled` defaults to true
 * when unset), so every key is always present and none of them is optional
 * here: a missing flag would silently read as "guest checkout off" and bounce
 * every anonymous visitor to login, which is the defect this endpoint exists
 * to fix.
 */
export const storefrontCheckoutGroupSchema = z.object({
  guestCheckoutEnabled: z.boolean(),
  requiredFields: z.array(z.string()).default([]),
  termsOfServiceUrl: z.string().nullable().default(null),
  postPurchaseRedirectUrl: z.string().nullable().default(null),
  checkoutMessage: z.string().nullable().default(null),
});

export type StorefrontCheckoutGroup = z.infer<typeof storefrontCheckoutGroupSchema>;

export const storefrontCheckoutSettingsSchema = z.object({
  checkout: storefrontCheckoutGroupSchema,
  /**
   * Empty is a real state, not an error: no payment method is seeded on this
   * client today. The page renders the "no tender available" branch rather
   * than assuming COD (pass-2 finding D2).
   */
  paymentMethods: z.array(storefrontPaymentMethodSchema).default([]),
});

export type StorefrontCheckoutSettings = z.infer<typeof storefrontCheckoutSettingsSchema>;

export const storefrontCheckoutSettingsResponseSchema = apiResponseSchema(
  storefrontCheckoutSettingsSchema,
);
