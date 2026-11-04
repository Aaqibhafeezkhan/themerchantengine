import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { google } from 'googleapis';
import type Redis from 'ioredis';
import {
  SEO_ANALYTICS_CACHE_PREFIX,
  SEO_ANALYTICS_DEFAULT_RANGE,
  SEO_ANALYTICS_RANGE_DAYS,
  SEO_ANALYTICS_TOP_LIMIT,
  SEO_ANALYTICS_TTL_SECONDS,
  SEO_BING_QUOTA_CACHE_KEY,
  SEO_BING_QUOTA_TTL_SECONDS,
  SEO_COVERAGE_CACHE_KEY,
  SEO_COVERAGE_TTL_SECONDS,
  SEO_GSC_INSPECT_BUDGET_PREFIX,
  SEO_GSC_INSPECT_DAILY_CAP,
  SEO_INDEXNOW_DEDUP_WINDOW_SECONDS,
  SEO_INSPECT_CACHE_PREFIX,
  SEO_INSPECT_TTL_SECONDS,
  SEO_PRODUCTS_SERVICE,
  SEO_REDIS_CLIENT,
  defaultLocale,
  type SeoAnalyticsRange,
  type SeoProductsReader,
  type SeoUrlInspectionState,
  type SupportedLocale,
} from './seo.constants';
import { SearchEngineSubmitService, type SubmissionHealth } from './search-engine-submit.service';
import { SeoService } from './seo.service';
import { entityPath, resolvePublicBaseUrl } from './site-url';
import {
  SeoMultipleInspectTargetsException,
  SeoNoInspectTargetException,
} from './seo-inspect.exceptions';

const GSC_SCOPES = ['https://www.googleapis.com/auth/webmasters'] as const;

// Bing Webmaster Tools read endpoints (key-auth, no OAuth). Parallel to the
// write endpoints in search-engine-submit.service.ts; kept local to the read
// service so the monitoring surface owns its own engine wiring.
const BING_GET_FEEDS_ENDPOINT = 'https://ssl.bing.com/webmaster/api.svc/json/GetFeeds';
const BING_GET_QUOTA_ENDPOINT = 'https://ssl.bing.com/webmaster/api.svc/json/GetUrlSubmissionQuota';

/** Read-side state per engine — `ok` (live data), `disabled` (no creds), `error`. */
export type SeoEngineReadState = 'ok' | 'disabled' | 'error';

export interface SeoCoverageSitemap {
  path: string;
  /** Sum of `contents[].submitted` — the deprecated `indexed` count is omitted (plan §12). */
  submitted: number;
  lastDownloaded: string | null;
  errors: number;
  warnings: number;
  isPending: boolean;
}

export interface SeoCoverageFeed {
  url: string;
  lastCrawled: string | null;
  urlCount: number | null;
}

export interface SeoCoverage {
  gsc: { state: SeoEngineReadState; detail: string; sitemaps: SeoCoverageSitemap[] };
  bing: { state: SeoEngineReadState; detail: string; feeds: SeoCoverageFeed[] };
}

export interface SeoQuota {
  bing: {
    state: SeoEngineReadState;
    detail: string;
    dailyQuota: number | null;
    monthlyQuota: number | null;
  };
  gsc: {
    state: SeoEngineReadState;
    detail: string;
    inspectUsed: number;
    inspectCap: number;
    /** The GSC inspect budget is a locally-counted estimate, never a Google-reported figure. */
    source: 'estimated';
  };
  indexnow: { dedupWindowSeconds: number };
}

/** One engine row's four Search-Console metrics. Each is nullable so a brand-new
 * property with impressions-but-no-clicks (or vice-versa) parses cleanly. */
export interface SeoAnalyticsMetrics {
  clicks: number | null;
  impressions: number | null;
  ctr: number | null;
  position: number | null;
}

export interface SeoAnalyticsSeriesPoint extends SeoAnalyticsMetrics {
  /** `YYYY-MM-DD` for the day this row aggregates. */
  date: string;
}

export interface SeoAnalyticsQueryRow extends SeoAnalyticsMetrics {
  query: string;
}

export interface SeoAnalyticsPageRow extends SeoAnalyticsMetrics {
  page: string;
}

export interface SeoAnalytics {
  state: SeoEngineReadState;
  detail: string;
  /** Echoes the lookback window the data is for. */
  range: SeoAnalyticsRange;
  /** GSC `metadata.firstIncompleteDate` — the first day still being collected, so
   * everything on/after it may still move. Null when the whole range is final or
   * GSC is off. */
  asOf: string | null;
  totals: SeoAnalyticsMetrics | null;
  series: SeoAnalyticsSeriesPoint[];
  topQueries: SeoAnalyticsQueryRow[];
  topPages: SeoAnalyticsPageRow[];
}

/**
 * One URL's GSC index state (DR-17 D5) — a READ of Google's last-known verdict,
 * never a recrawl request (research §1/§2). All verdict fields are nullable so a
 * brand-new or never-crawled URL parses cleanly; only the safe verdict fields are
 * surfaced — never the raw `inspectionResult` body or any credential (§3.7).
 * `inspectUsed`/`inspectCap` carry the budget readout on the `exhausted` state.
 */
export interface SeoUrlInspection {
  state: SeoUrlInspectionState;
  detail: string;
  /** The concrete URL that was (or would have been) inspected; null when no target
   * resolved (a misconfigured/foreign request). */
  url: string | null;
  verdict: string | null;
  coverageState: string | null;
  indexingState: string | null;
  robotsTxtState: string | null;
  pageFetchState: string | null;
  lastCrawlTime: string | null;
  googleCanonical: string | null;
  userCanonical: string | null;
  /** Set only on `exhausted` so the badge can show "N/cap used"; null otherwise. */
  inspectUsed: number | null;
  inspectCap: number | null;
}

/** Target of a single inspection — exactly one of `url` | `productId` (a `productId`
 * resolves to its public storefront URL server-side so the admin never needs the
 * storefront base URL, §3.14). */
export interface SeoInspectTarget {
  url?: string;
  productId?: string;
  locale?: SupportedLocale;
}

/**
 * Read-side monitoring service for the admin SEO indexing dashboard (DR-17 D3).
 *
 * Wraps the engine read APIs the dashboard needs — GSC `sitemaps.list`, Bing
 * `GetFeeds` / `GetUrlSubmissionQuota` — behind Redis caches so a page load is
 * never a live multi-engine probe (plan §8). Every method DEGRADES per engine: a
 * disabled engine (no key) reports `state:'disabled'`, a probe failure reports
 * `state:'error'` with a short detail — never a spinner, never a thrown 500, and
 * never a raw engine body or API key in the payload (§3.7). The only live call is
 * `recheckHealth()`, gated to 1 / 5 min at the route.
 */
@Injectable()
export class SeoInsightsService {
  private readonly logger = new Logger(SeoInsightsService.name);

  constructor(
    @Inject(SEO_REDIS_CLIENT) private readonly redis: Redis,
    private readonly submit: SearchEngineSubmitService,
    private readonly seo: SeoService,
    private readonly config: ConfigService,
    @Inject(SEO_PRODUCTS_SERVICE) private readonly products: SeoProductsReader,
  ) {}

  // ── Coverage ──────────────────────────────────────────────────────────────

  /** Per-engine sitemap coverage. Cached 6 h — coverage moves slowly and each
   * read is an engine API call. */
  async getSitemapCoverage(): Promise<SeoCoverage> {
    const cached = await this.readCache<SeoCoverage>(SEO_COVERAGE_CACHE_KEY);
    if (cached) return cached;

    const [gsc, bing] = await Promise.all([this.gscCoverage(), this.bingCoverage()]);
    const coverage: SeoCoverage = { gsc, bing };
    // Don't cache a transient probe failure for the full 6 h — an engine blip (or
    // a creds fix moments later) would otherwise show "Error"/stale until the TTL
    // expires. Only `ok`/`disabled` (stable) snapshots are write-through cached.
    if (gsc.state !== 'error' && bing.state !== 'error') {
      await this.writeCache(SEO_COVERAGE_CACHE_KEY, coverage, SEO_COVERAGE_TTL_SECONDS);
    }
    return coverage;
  }

  private async gscCoverage(): Promise<SeoCoverage['gsc']> {
    const gsc = this.gscClient();
    if (!gsc) return { state: 'disabled', detail: 'GSC disabled', sitemaps: [] };
    try {
      const res = await gsc.client.sitemaps.list({ siteUrl: gsc.propertyUrl });
      const sitemaps: SeoCoverageSitemap[] = (res.data.sitemap ?? []).map((s) => ({
        path: s.path ?? '',
        submitted: (s.contents ?? []).reduce((sum, c) => sum + Number(c.submitted ?? 0), 0),
        lastDownloaded: s.lastDownloaded ?? null,
        errors: Number(s.errors ?? 0),
        warnings: Number(s.warnings ?? 0),
        isPending: Boolean(s.isPending ?? false),
      }));
      return { state: 'ok', detail: `${sitemaps.length} sitemap(s)`, sitemaps };
    } catch (err) {
      return { state: 'error', detail: this.errMessage(err), sitemaps: [] };
    }
  }

  private async bingCoverage(): Promise<SeoCoverage['bing']> {
    const apiKey = process.env.BING_API_KEY;
    if (!apiKey) return { state: 'disabled', detail: 'BING_API_KEY unset', feeds: [] };
    const siteUrl = process.env.BING_SITE_URL ?? process.env.STOREFRONT_PUBLIC_BASE_URL;
    if (!siteUrl) return { state: 'error', detail: 'BING_SITE_URL unset', feeds: [] };
    try {
      const url = `${BING_GET_FEEDS_ENDPOINT}?apikey=${encodeURIComponent(apiKey)}&siteUrl=${encodeURIComponent(siteUrl)}`;
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (res.status !== 200)
        return { state: 'error', detail: `GetFeeds returned ${res.status}`, feeds: [] };
      const json = (await res.json().catch(() => ({}))) as {
        d?: Array<{ Url?: string; LastCrawled?: string; UrlCount?: number }>;
      };
      const feeds: SeoCoverageFeed[] = (json.d ?? []).map((f) => ({
        url: f.Url ?? '',
        lastCrawled: f.LastCrawled ?? null,
        urlCount: typeof f.UrlCount === 'number' ? f.UrlCount : null,
      }));
      return { state: 'ok', detail: `${feeds.length} feed(s)`, feeds };
    } catch (err) {
      return { state: 'error', detail: this.errMessage(err), feeds: [] };
    }
  }

  // ── Quota ─────────────────────────────────────────────────────────────────

  /** Bing URL-submission quota + GSC inspect-budget estimate + IndexNow window. */
  async getQuota(): Promise<SeoQuota> {
    const [bing, gsc] = await Promise.all([this.bingQuota(), this.gscInspectBudget()]);
    return { bing, gsc, indexnow: { dedupWindowSeconds: SEO_INDEXNOW_DEDUP_WINDOW_SECONDS } };
  }

  private async bingQuota(): Promise<SeoQuota['bing']> {
    const apiKey = process.env.BING_API_KEY;
    if (!apiKey) {
      return {
        state: 'disabled',
        detail: 'BING_API_KEY unset',
        dailyQuota: null,
        monthlyQuota: null,
      };
    }
    const cached = await this.readCache<SeoQuota['bing']>(SEO_BING_QUOTA_CACHE_KEY);
    if (cached) return cached;

    const siteUrl = process.env.BING_SITE_URL ?? process.env.STOREFRONT_PUBLIC_BASE_URL;
    if (!siteUrl) {
      return {
        state: 'error',
        detail: 'BING_SITE_URL unset',
        dailyQuota: null,
        monthlyQuota: null,
      };
    }
    try {
      const url = `${BING_GET_QUOTA_ENDPOINT}?apikey=${encodeURIComponent(apiKey)}&siteUrl=${encodeURIComponent(siteUrl)}`;
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (res.status !== 200) {
        return {
          state: 'error',
          detail: `GetUrlSubmissionQuota returned ${res.status}`,
          dailyQuota: null,
          monthlyQuota: null,
        };
      }
      const json = (await res.json().catch(() => ({}))) as {
        d?: { DailyQuota?: number; MonthlyQuota?: number };
      };
      const d = json.d ?? {};
      // Read the adaptive quota verbatim — Bing can report single digits; never
      // assume a fixed 10 000 (plan §12).
      const quota: SeoQuota['bing'] = {
        state: 'ok',
        detail: 'live',
        dailyQuota: typeof d.DailyQuota === 'number' ? d.DailyQuota : null,
        monthlyQuota: typeof d.MonthlyQuota === 'number' ? d.MonthlyQuota : null,
      };
      await this.writeCache(SEO_BING_QUOTA_CACHE_KEY, quota, SEO_BING_QUOTA_TTL_SECONDS);
      return quota;
    } catch (err) {
      return { state: 'error', detail: this.errMessage(err), dailyQuota: null, monthlyQuota: null };
    }
  }

  private async gscInspectBudget(): Promise<SeoQuota['gsc']> {
    if (!this.gscEnabled()) {
      return {
        state: 'disabled',
        detail: 'GSC disabled',
        inspectUsed: 0,
        inspectCap: SEO_GSC_INSPECT_DAILY_CAP,
        source: 'estimated',
      };
    }
    let inspectUsed = 0;
    try {
      const raw = await this.redis.get(`${SEO_GSC_INSPECT_BUDGET_PREFIX}${this.ptDateKey()}`);
      inspectUsed = raw ? Number(raw) || 0 : 0;
    } catch {
      inspectUsed = 0;
    }
    return {
      state: 'ok',
      detail: `${inspectUsed}/${SEO_GSC_INSPECT_DAILY_CAP} used (estimated)`,
      inspectUsed,
      inspectCap: SEO_GSC_INSPECT_DAILY_CAP,
      source: 'estimated',
    };
  }

  // ── Search Analytics ────────────────────────────────────────────────────────

  /**
   * GSC `searchanalytics.query` rollup for the admin performance block: totals,
   * a daily series, and the top queries + pages over the lookback window. Cached
   * per range (6 h) — Search Console data is daily-grained and lags ~2–3 days, so
   * a page load is never a live probe. Degrades to `state:'disabled'` when GSC is
   * off and `state:'error'` (NOT cached) on a probe failure, never a thrown 500 or
   * a leaked engine body (§3.7).
   */
  async getSearchAnalytics(
    range: SeoAnalyticsRange = SEO_ANALYTICS_DEFAULT_RANGE,
  ): Promise<SeoAnalytics> {
    const cacheKey = `${SEO_ANALYTICS_CACHE_PREFIX}${range}`;
    const cached = await this.readCache<SeoAnalytics>(cacheKey);
    if (cached) return cached;

    const gsc = this.gscClient();
    if (!gsc) return this.emptyAnalytics(range, 'disabled', 'GSC disabled');

    try {
      const { startDate, endDate } = this.analyticsRange(range);
      const body = (extra: Record<string, unknown>) => ({
        requestBody: { startDate, endDate, ...extra },
        siteUrl: gsc.propertyUrl,
      });
      // Four queries, one per grouping — GSC returns rows keyed by the requested
      // `dimensions`. Same property + auth, so they fail together; one throw → the
      // whole rollup degrades to `error`. `dataState:'all'` on the date series is
      // what populates `metadata.firstIncompleteDate` (the asOf boundary).
      const [totalsRes, seriesRes, queriesRes, pagesRes] = await Promise.all([
        gsc.client.searchanalytics.query(body({})),
        gsc.client.searchanalytics.query(body({ dimensions: ['date'], dataState: 'all' })),
        gsc.client.searchanalytics.query(
          body({ dimensions: ['query'], rowLimit: SEO_ANALYTICS_TOP_LIMIT }),
        ),
        gsc.client.searchanalytics.query(
          body({ dimensions: ['page'], rowLimit: SEO_ANALYTICS_TOP_LIMIT }),
        ),
      ]);

      const totalsRow = totalsRes.data.rows?.[0];
      const series = (seriesRes.data.rows ?? []).map((r) => ({
        date: r.keys?.[0] ?? '',
        ...this.metric(r),
      }));
      const analytics: SeoAnalytics = {
        state: 'ok',
        detail: `${series.length} day(s)`,
        range,
        asOf: seriesRes.data.metadata?.firstIncompleteDate ?? null,
        totals: totalsRow ? this.metric(totalsRow) : null,
        series,
        topQueries: (queriesRes.data.rows ?? []).map((r) => ({
          query: r.keys?.[0] ?? '',
          ...this.metric(r),
        })),
        topPages: (pagesRes.data.rows ?? []).map((r) => ({
          page: r.keys?.[0] ?? '',
          ...this.metric(r),
        })),
      };
      await this.writeCache(cacheKey, analytics, SEO_ANALYTICS_TTL_SECONDS);
      return analytics;
    } catch (err) {
      // A transient GSC failure must not be frozen into the 6 h cache.
      return this.emptyAnalytics(range, 'error', this.errMessage(err));
    }
  }

  private emptyAnalytics(
    range: SeoAnalyticsRange,
    state: SeoEngineReadState,
    detail: string,
  ): SeoAnalytics {
    return {
      state,
      detail,
      range,
      asOf: null,
      totals: null,
      series: [],
      topQueries: [],
      topPages: [],
    };
  }

  /** Map one GSC `ApiDataRow` to the four metrics, coercing absent/garbage to null
   * (never NaN) so the response always parses. */
  private metric(r: {
    clicks?: number | null;
    impressions?: number | null;
    ctr?: number | null;
    position?: number | null;
  }): SeoAnalyticsMetrics {
    const n = (v: unknown): number | null =>
      typeof v === 'number' && Number.isFinite(v) ? v : null;
    return {
      clicks: n(r.clicks),
      impressions: n(r.impressions),
      ctr: n(r.ctr),
      position: n(r.position),
    };
  }

  /** Resolve a range to a `{ startDate, endDate }` (YYYY-MM-DD, America/Los_Angeles
   * to match the property timezone + the inspect-budget counter). GSC treats both
   * bounds as inclusive, so an N-day window is today back through today − (N − 1). */
  private analyticsRange(range: SeoAnalyticsRange): { startDate: string; endDate: string } {
    return { startDate: this.ptDate(SEO_ANALYTICS_RANGE_DAYS[range] - 1), endDate: this.ptDate(0) };
  }

  // ── URL Inspection ──────────────────────────────────────────────────────────

  /**
   * Read one URL's GSC index state (DR-17 D5). Lazy-on-click only — NEVER called on
   * a page load (plan §8). Resolves the target (a raw `url` or a `productId` →
   * its public storefront URL), then, guarded by the daily inspect budget:
   *  1. cache-first (`seo:inspect:<url>`, ≥24 h) — a hit costs nothing;
   *  2. GSC off → `disabled`; foreign URL / unknown product → `error` (no spend);
   *  3. at/over the 2 000/day cap → `exhausted` (no spend);
   *  4. otherwise reserve the slot (INCR, first-of-day sets a midnight-PT TTL) BEFORE
   *     the call so concurrent clicks can't race past the cap, then inspect.
   * Maps only the safe verdict fields — never the raw body or a credential (§3.7).
   */
  async inspectUrl(target: SeoInspectTarget): Promise<SeoUrlInspection> {
    const resolved = await this.resolveInspectionUrl(target);
    if ('error' in resolved) return this.emptyInspection('error', resolved.error, null);
    const url = resolved.url;

    const cacheKey = `${SEO_INSPECT_CACHE_PREFIX}${url}`;
    const cached = await this.readCache<SeoUrlInspection>(cacheKey);
    if (cached) return cached;

    const gsc = this.gscClient();
    if (!gsc) return this.emptyInspection('disabled', 'GSC disabled', url);

    // Atomically reserve a slot: the INCR result IS the gate, so two concurrent
    // requests can never both pass at used=cap-1 (a separate GET-then-INCR would
    // leave that race open). An over-cap reservation is released back so the
    // estimated counter doesn't drift upward on repeated exhausted clicks.
    const counterKey = `${SEO_GSC_INSPECT_BUDGET_PREFIX}${this.ptDateKey()}`;
    const reserved = await this.reserveInspectBudget(counterKey);
    if (reserved > SEO_GSC_INSPECT_DAILY_CAP) {
      await this.releaseInspectBudget(counterKey);
      return {
        ...this.emptyInspection(
          'exhausted',
          `Daily inspection budget reached (${SEO_GSC_INSPECT_DAILY_CAP}/${SEO_GSC_INSPECT_DAILY_CAP})`,
          url,
        ),
        inspectUsed: SEO_GSC_INSPECT_DAILY_CAP,
        inspectCap: SEO_GSC_INSPECT_DAILY_CAP,
      };
    }

    try {
      const res = await gsc.client.urlInspection.index.inspect({
        requestBody: { inspectionUrl: url, siteUrl: gsc.propertyUrl },
      });
      const idx = res.data.inspectionResult?.indexStatusResult ?? {};
      const inspection: SeoUrlInspection = {
        state: 'ok',
        detail: idx.verdict ?? 'inspected',
        url,
        verdict: idx.verdict ?? null,
        coverageState: idx.coverageState ?? null,
        indexingState: idx.indexingState ?? null,
        robotsTxtState: idx.robotsTxtState ?? null,
        pageFetchState: idx.pageFetchState ?? null,
        lastCrawlTime: idx.lastCrawlTime ?? null,
        googleCanonical: idx.googleCanonical ?? null,
        userCanonical: idx.userCanonical ?? null,
        inspectUsed: null,
        inspectCap: null,
      };
      await this.writeCache(cacheKey, inspection, SEO_INSPECT_TTL_SECONDS);
      return inspection;
    } catch (err) {
      // A transient GSC failure must not be frozen into the 24 h cache.
      return this.emptyInspection('error', this.errMessage(err), url);
    }
  }

  /** Resolve the inspection target to a concrete URL. Throws a 400 on a missing/
   * ambiguous target (caller misuse); returns a degrade `{ error }` for a foreign
   * URL or an unknown/inactive product (no quota spend, the badge still renders). */
  private async resolveInspectionUrl(
    target: SeoInspectTarget,
  ): Promise<{ url: string } | { error: string }> {
    const hasUrl = target.url !== undefined;
    const hasProductId = target.productId !== undefined;
    if (!hasUrl && !hasProductId) throw new SeoNoInspectTargetException();
    if (hasUrl && hasProductId) throw new SeoMultipleInspectTargetsException();

    const siteUrl = resolvePublicBaseUrl(this.config);
    if (hasUrl) {
      const url = target.url as string;
      let sameOrigin = false;
      try {
        sameOrigin = new URL(url).origin === new URL(siteUrl).origin;
      } catch {
        sameOrigin = false;
      }
      if (!sameOrigin) return { error: 'URL is outside the configured storefront property' };
      return { url };
    }

    const resolved = await this.products.resolveActivePublicSlugs([target.productId as string]);
    if (resolved.length === 0) return { error: 'Product not found or not publicly active' };
    const locale: SupportedLocale = target.locale ?? defaultLocale();
    const base = siteUrl.replace(/\/$/, '');
    return { url: `${base}${entityPath('product', resolved[0].slug, locale)}` };
  }

  private emptyInspection(
    state: SeoUrlInspectionState,
    detail: string,
    url: string | null,
  ): SeoUrlInspection {
    return {
      state,
      detail,
      url,
      verdict: null,
      coverageState: null,
      indexingState: null,
      robotsTxtState: null,
      pageFetchState: null,
      lastCrawlTime: null,
      googleCanonical: null,
      userCanonical: null,
      inspectUsed: null,
      inspectCap: null,
    };
  }

  /** Atomically reserve one inspect slot: INCR the PT-day counter (the single
   * gate) and, on the first increment of the day, expire it at the next midnight
   * PT so it matches Google's reset. Returns the post-increment count, or 0 on a
   * Redis failure (fail-open — a counter outage must not break the read; Google
   * still enforces the real per-property cap). */
  private async reserveInspectBudget(key: string): Promise<number> {
    try {
      const n = await this.redis.incr(key);
      if (n === 1) await this.redis.expire(key, this.secondsUntilPtMidnight());
      return n;
    } catch (err) {
      this.logger.warn({ msg: 'inspect budget reserve failed', err: this.errMessage(err) });
      return 0;
    }
  }

  /** Release a slot reserved by `reserveInspectBudget` when the reservation came
   * back over the cap, so the estimated counter stays bounded at the cap. */
  private async releaseInspectBudget(key: string): Promise<void> {
    try {
      await this.redis.decr(key);
    } catch (err) {
      this.logger.warn({ msg: 'inspect budget release failed', err: this.errMessage(err) });
    }
  }

  /** Seconds from now until the next America/Los_Angeles midnight (the GSC daily
   * reset boundary the counter key is bucketed by). */
  private secondsUntilPtMidnight(): number {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(new Date(Date.now()));
    const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? 0);
    const hour = get('hour') % 24; // some ICU builds emit '24' at midnight
    const elapsed = hour * 3600 + get('minute') * 60 + get('second');
    const remaining = 86_400 - elapsed;
    return remaining > 0 ? remaining : 86_400;
  }

  // ── Live health re-check ────────────────────────────────────────────────────

  /** The only live multi-engine probe — runs `checkSubmissionHealth`, persists the
   * snapshot the status strip reads, and returns it. Route-gated to 1 / 5 min. */
  async recheckHealth(): Promise<SubmissionHealth> {
    const siteUrl = resolvePublicBaseUrl(this.config);
    const health = await this.submit.checkSubmissionHealth(siteUrl);
    // Persist the fresh snapshot for the status strip, but never lose the live
    // probe result to a cache-write hiccup — return what we just measured even if
    // the setex fails.
    try {
      await this.seo.setSubmissionHealth(health);
    } catch (err) {
      this.logger.warn({ msg: 'recheckHealth snapshot persist failed', err: this.errMessage(err) });
    }
    return health;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /** Whether the GSC service-account path is configured. Public so the
   * URL-Inspection sweep can gate on it without duplicating the env logic (§3.14). */
  gscEnabled(): boolean {
    return (
      process.env.GSC_SUBMISSION_ENABLED === 'true' &&
      !!process.env.GOOGLE_APPLICATION_CREDENTIALS &&
      !!process.env.GSC_SITE_URL
    );
  }

  /** Construct the read-only GSC client exactly like `checkGscHealth` does, or
   * null when GSC is not configured. */
  private gscClient(): {
    client: ReturnType<typeof google.searchconsole>;
    propertyUrl: string;
  } | null {
    if (!this.gscEnabled()) return null;
    const auth = new google.auth.GoogleAuth({
      keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
      scopes: GSC_SCOPES as unknown as string[],
    });
    return {
      client: google.searchconsole({ version: 'v1', auth }),
      propertyUrl: process.env.GSC_SITE_URL as string,
    };
  }

  /** `YYYYMMDD` in America/Los_Angeles so the inspect-budget counter matches
   * Google's midnight-PT reset (D5's INCR uses the same key). */
  private ptDateKey(): string {
    return this.ptDate(0).replace(/-/g, '');
  }

  /** `YYYY-MM-DD` in America/Los_Angeles, `offsetDays` ago (0 = today PT). Single
   * source for every PT calendar date the service needs — the inspect-budget
   * counter key and the analytics date window both derive from it. */
  private ptDate(offsetDays: number): string {
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    // Step back on the calendar date, not in 24h blocks, so a DST change
    // inside the window cannot shift the result by a day.
    const day = new Date(`${today}T00:00:00Z`);
    day.setUTCDate(day.getUTCDate() - offsetDays);
    return day.toISOString().slice(0, 10);
  }

  private errMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  private async readCache<T>(key: string): Promise<T | null> {
    try {
      const raw = await this.redis.get(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  }

  private async writeCache(key: string, value: unknown, ttl: number): Promise<void> {
    try {
      await this.redis.setex(key, ttl, JSON.stringify(value));
    } catch (err) {
      // Cache write is best-effort; a Redis hiccup must not fail the read.
      this.logger.warn({ msg: 'SeoInsights cache write failed', key, err: this.errMessage(err) });
    }
  }
}
