import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { H3Event } from 'h3';

import securityHeadersHandler from '../middleware/security-headers';

interface FakeRecording {
  headers: Record<string, string>;
}

function createFakeEvent(): { event: H3Event; recorded: FakeRecording } {
  const recorded: FakeRecording = { headers: {} };
  const event = {
    node: {
      res: {
        statusCode: 0,
        setHeader(name: string, value: string) {
          recorded.headers[name.toLowerCase()] = value;
        },
        getHeader(name: string) {
          return recorded.headers[name.toLowerCase()];
        },
      },
    },
  } as unknown as H3Event;
  return { event, recorded };
}

describe('security-headers middleware', () => {
  const ORIGINAL_NODE_ENV = process.env['NODE_ENV'];

  beforeEach(() => {
    delete process.env['NODE_ENV'];
  });

  afterEach(() => {
    if (ORIGINAL_NODE_ENV === undefined) delete process.env['NODE_ENV'];
    else process.env['NODE_ENV'] = ORIGINAL_NODE_ENV;
  });

  it('allows http: images outside production, where the local profile serves assets over plain http, and never in production', async () => {
    process.env['NODE_ENV'] = 'development';
    const dev = createFakeEvent();
    await securityHeadersHandler(dev.event);
    expect(dev.recorded.headers['content-security-policy']).toMatch(
      /img-src 'self' data: https: http:;/,
    );
    process.env['NODE_ENV'] = 'production';
    const prod = createFakeEvent();
    await securityHeadersHandler(prod.event);
    expect(prod.recorded.headers['content-security-policy']).toMatch(
      /img-src 'self' data: https:;/,
    );
    expect(prod.recorded.headers['content-security-policy']).not.toMatch(/img-src[^;]*http:/);
  });

  it('sets the universal floor of headers on every response', async () => {
    const { event, recorded } = createFakeEvent();
    await securityHeadersHandler(event);
    expect(recorded.headers['x-content-type-options']).toBe('nosniff');
    expect(recorded.headers['x-frame-options']).toBe('DENY');
    expect(recorded.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(recorded.headers['permissions-policy']).toContain('camera=()');
  });

  it('includes a Content-Security-Policy with locked script-src and frame-ancestors none', async () => {
    const { event, recorded } = createFakeEvent();
    await securityHeadersHandler(event);
    const csp = recorded.headers['content-security-policy'];
    expect(csp).toBeTruthy();
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
  });

  it('allows Cloudflare Turnstile in script-src AND frame-src (bot-defense widget)', async () => {
    // Regression: a CSP of `script-src 'self'` with no `frame-src` silently
    // blocks the Turnstile api.js + its challenge iframe, so real users cannot
    // obtain a token and the sign-up / newsletter forms break while the server
    // still rejects tokenless requests. Both directives must allow the host.
    const { event, recorded } = createFakeEvent();
    await securityHeadersHandler(event);
    const csp = recorded.headers['content-security-policy'];
    const directive = (name: string) =>
      csp
        .split(';')
        .map((d) => d.trim())
        .find((d) => d.startsWith(`${name} `)) ?? '';
    expect(directive('script-src')).toContain('https://challenges.cloudflare.com');
    expect(directive('frame-src')).toContain('https://challenges.cloudflare.com');
    expect(directive('connect-src')).toContain('https://challenges.cloudflare.com');
  });

  it('allows the Stripe Payment Element origins in script-src, frame-src and connect-src', async () => {
    // Without these the card form never mounts and the shopper sees an empty
    // payment step with no visible error.
    const { event, recorded } = createFakeEvent();
    await securityHeadersHandler(event);
    const csp = recorded.headers['content-security-policy'];
    const directive = (name: string) =>
      csp
        .split(';')
        .map((d) => d.trim())
        .find((d) => d.startsWith(`${name} `)) ?? '';
    expect(directive('script-src')).toContain('https://js.stripe.com');
    expect(directive('frame-src')).toContain('https://js.stripe.com');
    expect(directive('frame-src')).toContain('https://hooks.stripe.com');
    expect(directive('connect-src')).toContain('https://api.stripe.com');
  });

  it('omits Strict-Transport-Security in non-production', async () => {
    process.env['NODE_ENV'] = 'development';
    const { event, recorded } = createFakeEvent();
    await securityHeadersHandler(event);
    expect(recorded.headers['strict-transport-security']).toBeUndefined();
  });

  it('emits Strict-Transport-Security only when NODE_ENV=production', async () => {
    process.env['NODE_ENV'] = 'production';
    const { event, recorded } = createFakeEvent();
    await securityHeadersHandler(event);
    expect(recorded.headers['strict-transport-security']).toBe(
      'max-age=63072000; includeSubDomains; preload',
    );
  });

  it('omits upgrade-insecure-requests from the CSP in non-production', async () => {
    process.env['NODE_ENV'] = 'development';
    const { event, recorded } = createFakeEvent();
    await securityHeadersHandler(event);
    expect(recorded.headers['content-security-policy']).not.toContain('upgrade-insecure-requests');
  });

  it('adds upgrade-insecure-requests to the CSP only when NODE_ENV=production', async () => {
    process.env['NODE_ENV'] = 'production';
    const { event, recorded } = createFakeEvent();
    await securityHeadersHandler(event);
    expect(recorded.headers['content-security-policy']).toContain('upgrade-insecure-requests');
  });

  describe('vendor analytics origins (plan I phase I8)', () => {
    /**
     * The pixel tags load their vendor loader from one origin and beacon to
     * another, and CSP has to allow both or the tag is dead with no visible
     * error. Listed here so a vendor's origin change is a failing test rather
     * than a silently unreported conversion.
     *
     * The allowances are inert until an operator configures a pixel id: with
     * none configured `PixelService` appends no script, so nothing on these
     * origins is ever fetched.
     */
    const SCRIPT_ORIGINS = [
      'https://www.googletagmanager.com',
      'https://connect.facebook.net',
      'https://analytics.tiktok.com',
      'https://sc-static.net',
    ];

    /**
     * Every entry was observed in a real GA4 hit, not taken from a doc page.
     * With only `google-analytics.com` allowed the tag loaded and then every
     * beacon was refused, which is the silent failure this phase exists to
     * avoid; the storefront-e2e pixel journey is what caught it.
     */
    const CONNECT_ORIGINS = [
      'https://www.googletagmanager.com',
      'https://www.google-analytics.com',
      'https://region1.google-analytics.com',
      'https://analytics.google.com',
      'https://www.google.com',
      'https://stats.g.doubleclick.net',
      'https://www.facebook.com',
      'https://analytics.tiktok.com',
      'https://tr.snapchat.com',
    ];

    async function directive(name: string): Promise<string> {
      const { event, recorded } = createFakeEvent();
      await securityHeadersHandler(event);
      const csp = recorded.headers['content-security-policy'] ?? '';
      const found = csp.split('; ').find((part) => part.startsWith(`${name} `));
      expect(found, `${name} missing from CSP`).toBeDefined();
      return found!;
    }

    it.each(SCRIPT_ORIGINS)('allows %s to serve a tag loader', async (origin) => {
      expect(await directive('script-src')).toContain(origin);
    });

    it.each(CONNECT_ORIGINS)('allows a beacon to %s', async (origin) => {
      expect(await directive('connect-src')).toContain(origin);
    });

    it('keeps script-src without unsafe-inline, so vendor stubs stay bundled', async () => {
      // The vendor snippets the docs hand you are inline scripts. Allowing
      // them would open the whole inline surface the nonce exists to close, so
      // PixelService builds the stub queues in TypeScript instead.
      expect(await directive('script-src')).not.toContain("'unsafe-inline'");
    });

    it('still allows Turnstile, which the sign-up and newsletter forms need', async () => {
      expect(await directive('script-src')).toContain('https://challenges.cloudflare.com');
      expect(await directive('frame-src')).toContain('https://challenges.cloudflare.com');
    });
  });
});
