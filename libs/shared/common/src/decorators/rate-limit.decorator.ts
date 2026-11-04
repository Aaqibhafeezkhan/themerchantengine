import { Throttle, SkipThrottle, seconds } from '@nestjs/throttler';

/**
 * Named rate-limit groups (§08 Rate Limiting table).
 * All decorators accept the @nestjs/throttler convention: ttl is converted to the milliseconds v6 expects.
 *
 * Usage:
 *   @RateLimit.Auth()         – 5 req / 15 min (login, register)
 *   @RateLimit.StorefrontRead()  – 100 req / min (browse, search results)
 *   @RateLimit.StorefrontWrite() – 30 req / min (cart, wishlist mutations)
 *   @RateLimit.Admin()        – 200 req / min (admin panel)
 *   @RateLimit.AssetUpload()  – 30 req / hour (file uploads)
 *   @RateLimit.Search()       – 60 req / min (search endpoints)
 *   @RateLimit.WebhookTest()  – 5 req / min (webhook delivery tests)
 *   @RateLimit.GiftCardLookup() – 10 req / min (gift card validation)
 *   @RateLimit.CouponValidation() – 15 req / min (coupon check)
 *   @RateLimit.Skip()         – disable rate limiting for a route
 */
export const RateLimit = {
  /** 5 requests per 15 minutes — login, register, forgot-password */
  Auth: () => Throttle({ default: { limit: 5, ttl: seconds(15 * 60) } }),

  /** 100 requests per minute — storefront read endpoints */
  StorefrontRead: () => Throttle({ default: { limit: 100, ttl: seconds(60) } }),

  /** 30 requests per minute — storefront write endpoints (cart, wishlist) */
  StorefrontWrite: () => Throttle({ default: { limit: 30, ttl: seconds(60) } }),

  /** 200 requests per minute — admin panel endpoints */
  Admin: () => Throttle({ default: { limit: 200, ttl: seconds(60) } }),

  /** 30 requests per hour — asset/file upload */
  AssetUpload: () => Throttle({ default: { limit: 30, ttl: seconds(60 * 60) } }),

  /** 60 requests per minute — search endpoints */
  Search: () => Throttle({ default: { limit: 60, ttl: seconds(60) } }),

  /** 5 requests per minute — webhook delivery tests */
  WebhookTest: () => Throttle({ default: { limit: 5, ttl: seconds(60) } }),

  /** 10 requests per minute — gift card lookup */
  GiftCardLookup: () => Throttle({ default: { limit: 10, ttl: seconds(60) } }),

  /** 15 requests per minute — coupon/promo validation */
  CouponValidation: () => Throttle({ default: { limit: 15, ttl: seconds(60) } }),

  /** 5 requests per 15 minutes — public contact form (anti-spam) */
  ContactForm: () => Throttle({ default: { limit: 5, ttl: seconds(15 * 60) } }),

  /** 10 requests per minute — manual SEO reindex submit. Tighter than Admin()
   * because every accepted call spends finite IndexNow / GSC / Bing quota
   * (DR-17 §7 — quota-spending endpoints get their own throttle group). */
  SeoSubmit: () => Throttle({ default: { limit: 10, ttl: seconds(60) } }),

  /** 1 request per 5 minutes — live SEO submission-health re-check. The "Re-check
   * now" button is the only live multi-engine probe (GSC sitemaps.list + Bing
   * GetFeeds + public-sitemap fetch); every other status read is served from the
   * cached snapshot. Capped at the operator cadence fixed in DR-17 §8 + §11 #7 so
   * a held button can't hammer the engines. */
  SeoHealthRecheck: () => Throttle({ default: { limit: 1, ttl: seconds(5 * 60) } }),

  /** Bypass rate limiting for a specific route */
  Skip: () => SkipThrottle(),
} as const;
