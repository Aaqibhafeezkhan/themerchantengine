import { defineEventHandler, setResponseHeader } from 'h3';
// Relative on purpose: Nitro bundles the server without the workspace
// tsconfig aliases, and this module has no alias in `nitro.alias`.
// eslint-disable-next-line @nx/enforce-module-boundaries
import { isProduction } from '../../../../../libs/shared/common/src/env/runtime-environment';

import { createCspNonce, setCspNonce } from '../csp-nonce';
import { EVENT_DISPATCH_CONTRACT_SHA256 } from '../csp-script-hashes';

/**
 * Storefront Nitro middleware that emits the security response headers
 * documented in `agent_docs/security.md` §"XSS Prevention / Headers".
 *
 * The API serves its own headers via the Nest CORS + Helmet stack; the
 * storefront origin needs the same defense-in-depth posture for the
 * authenticated surfaces (`/account/*`, `/checkout`) where missing
 * headers would let a hostile origin frame the page or where an XSS
 * regression would have no in-browser CSP boundary to limit blast.
 *
 * Header rationale:
 *  - X-Content-Type-Options: nosniff      — prevent MIME-type sniffing.
 *  - X-Frame-Options: DENY                — clickjacking defense; CSP
 *                                          frame-ancestors is the
 *                                          forward-looking version, but
 *                                          XFO is the universal floor.
 *  - Referrer-Policy: strict-origin-when-cross-origin
 *                                          — limits cross-origin referrer
 *                                            leakage for product / order
 *                                            URLs.
 *  - Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
 *                                          — set only when NODE_ENV=production
 *                                            so dev over plain HTTP is not
 *                                            HSTS-pinned for two years.
 *  - Content-Security-Policy                — restrictive starter that
 *                                            permits Analog's hydration
 *                                            inline runtime via 'self' +
 *                                            'unsafe-inline' on style only.
 *                                            script-src is locked to 'self'
 *                                            so any future inline-script
 *                                            regression triggers CSP.
 *
 * Customer-facing surfaces (sitemap_index.xml, robots.txt, llms.txt)
 * are served from `apps/storefront/src/server/routes/*.ts` via the same
 * Nitro pipeline so they receive these headers automatically.
 *
 * The internal `/api/_internal/revalidate` endpoint also receives these
 * headers — harmless on a backend-to-backend POST and consistent with the
 * defense-in-depth principle that every storefront response should carry
 * the same baseline headers.
 */
export default defineEventHandler((event) => {
  // Guard: if the locale-redirect middleware (or any earlier middleware) has
  // already sent a response (e.g. a 302 Location redirect), Node's
  // ServerResponse object has `headersSent === true` and calling
  // setResponseHeader will throw ERR_HTTP_HEADERS_SENT. Skip header injection
  // for already-finalised responses. The redirect itself carries no sensitive
  // content so there is nothing to protect here.
  if (event.node.res.headersSent) return;

  setResponseHeader(event, 'X-Content-Type-Options', 'nosniff');
  setResponseHeader(event, 'X-Frame-Options', 'DENY');
  setResponseHeader(event, 'Referrer-Policy', 'strict-origin-when-cross-origin');
  setResponseHeader(
    event,
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(self)',
  );

  if (isProduction()) {
    setResponseHeader(
      event,
      'Strict-Transport-Security',
      'max-age=63072000; includeSubDomains; preload',
    );
  }

  // CSP starter. `'unsafe-inline'` is permitted on style only because
  // Angular SSR emits inline component styles via `<style>` tags; the
  // forward path is style hashes once the bundle stabilises. `script-src`
  // is locked to 'self' (+ Cloudflare Turnstile, below) so any inline
  // `<script>` regression triggers CSP — JSON-LD
  // `<script type="application/ld+json">` is parsed as data, not executed,
  // and is not gated by `script-src`.
  //
  // Cloudflare Turnstile (bot defense on the sign-up + newsletter forms) loads
  // `https://challenges.cloudflare.com/turnstile/v0/api.js` and renders its
  // challenge in an iframe from the same origin. Per Cloudflare's CSP guidance
  // that host must be allowed in BOTH `script-src` (the api.js) and `frame-src`
  // (the challenge iframe) — without `frame-src` the iframe falls back to
  // `default-src 'self'` and the widget silently fails to load, blocking real
  // users from submitting (the server still rejects tokenless requests).
  //
  // The per-request nonce covers the two inline scripts Angular emits for
  // hydration event replay: `ng-event-dispatch-contract` and the
  // `window.__jsaction_bootstrap(...)` call that arms it. Without it both are
  // refused in every browser, so event replay is inert and every page load
  // reports two violations. `'self'` still applies alongside the nonce, since
  // there is no `'strict-dynamic'` here, so an injected inline script without
  // the nonce is still refused. `app.config.server.ts` reads the same value
  // back off the request to provide Angular's CSP_NONCE.
  //
  // The hash covers the second one, the event-dispatch contract, which the
  // builder inlines into index.html at build time so nothing per-request can
  // stamp an attribute onto it. Its spec re-derives the hash from the installed
  // Angular package, so an upgrade that changes the script fails a test rather
  // than quietly disarming event replay.
  const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';
  // Stripe Payment Element (the `embedded` card step). stripe.js, its card iframe,
  // the 3-D Secure frame on hooks.stripe.com and the API calls it makes. Static
  // like the vendor tags: nothing on these origins loads unless a method needs it.
  const STRIPE_SCRIPT_ORIGIN = 'https://js.stripe.com';
  const STRIPE_FRAME_ORIGINS = 'https://js.stripe.com https://hooks.stripe.com';
  const STRIPE_CONNECT_ORIGIN = 'https://api.stripe.com';
  // Vendor analytics tags (plan I phase I8, finding D2). Each vendor serves its
  // loader from one origin and beacons to another, and both have to be allowed
  // or the tag is dead with no visible error anywhere.
  //
  // Static allowances, not conditional ones. The header is built per request
  // and the pixel config is not available here without a fetch on the hot path;
  // and the allowance costs nothing when unused: with no pixel id configured
  // `PixelService` appends no script, so nothing on these origins is fetched.
  //
  // Deliberately NOT accompanied by `'unsafe-inline'`. The bootstrap snippets
  // the vendor docs hand you are inline scripts; allowing them would reopen the
  // whole inline surface the nonce exists to close, so the stub queues are
  // built in bundled TypeScript and only the external loader is appended.
  const VENDOR_SCRIPT_ORIGINS = [
    'https://www.googletagmanager.com',
    'https://connect.facebook.net',
    'https://analytics.tiktok.com',
    'https://sc-static.net',
  ].join(' ');
  //
  // The GA4 list is longer than its documentation suggests and every entry
  // here was observed, not guessed: with only `google-analytics.com` allowed,
  // the tag loaded and then every beacon was refused, which is the exact
  // "dead with no visible error" shape this whole phase exists to avoid. The
  // storefront-e2e pixel journey is what caught it.
  const VENDOR_CONNECT_ORIGINS = [
    'https://www.googletagmanager.com',
    'https://www.google-analytics.com',
    // GA4 routes some traffic to a regional collector rather than the global one.
    'https://region1.google-analytics.com',
    'https://analytics.google.com',
    // `/g/collect` on the bare google.com origin, which gtag uses for the
    // ads-linked leg of the same hit. Observed on a first page view.
    'https://www.google.com',
    'https://stats.g.doubleclick.net',
    'https://www.facebook.com',
    'https://analytics.tiktok.com',
    'https://tr.snapchat.com',
  ].join(' ');
  const nonce = createCspNonce();
  setCspNonce(event.node.req, nonce);
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' '${EVENT_DISPATCH_CONTRACT_SHA256}' ${TURNSTILE_ORIGIN} ${STRIPE_SCRIPT_ORIGIN} ${VENDOR_SCRIPT_ORIGINS}`,
    "style-src 'self' 'unsafe-inline'",
    // Assets come from the store's storage over https. The local profile
    // serves them from the API over plain http on another port of this
    // machine, so outside production http: is allowed as well; a server
    // install is always production and never widens.
    `img-src 'self' data: https:${isProduction() ? '' : ' http:'}`,
    "font-src 'self' data:",
    `connect-src 'self' ${TURNSTILE_ORIGIN} ${STRIPE_CONNECT_ORIGIN} ${VENDOR_CONNECT_ORIGINS}`,
    `frame-src ${TURNSTILE_ORIGIN} ${STRIPE_FRAME_ORIGINS}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    // upgrade-insecure-requests forces the browser to fetch every subresource
    // and follow every nested navigation over HTTPS. Correct on the production
    // HTTPS origin; on a plain-HTTP dev / e2e origin it upgrades localhost to
    // https:// and every request then fails with an SSL connect error — so it
    // is gated to production, the same as Strict-Transport-Security above.
    ...(isProduction() ? ['upgrade-insecure-requests'] : []),
  ].join('; ');
  setResponseHeader(event, 'Content-Security-Policy', csp);
});
