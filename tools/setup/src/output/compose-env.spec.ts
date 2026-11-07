import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SetupAnswers } from '../answers';
import { generateSecrets } from '../state/secrets';
import { COMPLETE_ANSWERS } from './client-config.spec';
import { ComposeEnvError, composeEngineEnv, composeStorefrontEnv } from './compose-env';
import { parseEnv, serializeEnv } from './env-file';

const secrets = generateSecrets({}, (n) => Buffer.alloc(n, 0x11));

const SERVER: SetupAnswers = {
  ...COMPLETE_ANSWERS,
  profile: 'both',
  storage: {
    driver: 's3',
    endpoint: 'https://s3.gra.example',
    region: 'gra',
    bucket: 'atlas-assets',
    publicUrl: 'https://atlas-assets.s3.gra.example',
    accessKey: 'AK',
    secretKey: 'SK',
  },
  mail: {
    transport: 'resend',
    apiKey: 're_1',
    webhookSecret: 'whsec_1',
    fromEmail: 'noreply@atlas.example',
    fromName: 'Atlas',
    replyTo: 'hello@atlas.example',
    contactFormRecipient: 'hello@atlas.example',
  },
  turnstile: { enabled: true, siteKey: '0xSITE', secretKey: '0xSECRET' },
  seo: {
    indexNowKey: 'abcdef12',
    bingApiKey: 'bing',
    gscServiceAccountFile: 'sa.json',
    gscSiteUrl: 'sc-domain:atlas.example',
  },
  payments: {
    cod: true,
    manual: false,
    stripe: true,
    stripeApiKey: 'sk_test_1',
    stripeWebhookSecret: 'whsec_1',
  },
};

const flat = (sections: ReturnType<typeof composeEngineEnv>) =>
  parseEnv(serializeEnv(sections, 'spec'));

/** Every variable the API reads, per the census of `process.env` and `config.get` in apps/api/src. */
const API_READS = [
  'NODE_ENV',
  'PORT',
  'API_GLOBAL_PREFIX',
  'LOG_LEVEL',
  'DATABASE_URL',
  'REDIS_HOST',
  'REDIS_PORT',
  'REDIS_PASSWORD',
  'BETTER_AUTH_SECRET',
  'BETTER_AUTH_URL',
  'CORS_ORIGIN',
  'STOREFRONT_PUBLIC_BASE_URL',
  'ADMIN_PUBLIC_BASE_URL',
  'API_PUBLIC_BASE_URL',
  'STOREFRONT_REVALIDATE_URL',
  'STOREFRONT_REVALIDATE_SECRET',
  'UNSUBSCRIBE_TOKEN_SECRET',
  'TURNSTILE_SECRET',
  'MAX_FILE_SIZE',
  'ALLOWED_FILE_TYPES',
  'STORAGE_DRIVER',
  'S3_ENDPOINT',
  'S3_REGION',
  'S3_BUCKET',
  'S3_ACCESS_KEY',
  'S3_SECRET_KEY',
  'S3_PUBLIC_URL',
  'SIGNED_URL_SECRET',
  'RETAIN_ORIGINALS',
  'INVOICE_LOGO_PATH',
  'MAIL_TRANSPORT',
  'RESEND_API_KEY',
  'RESEND_WEBHOOK_SECRET',
  'RESEND_FROM_EMAIL',
  'RESEND_FROM_NAME',
  'RESEND_REPLY_TO',
  'CONTACT_FORM_RECIPIENT',
  'MAIL_DEV_REDIRECT_TO',
  'INDEXNOW_KEY',
  'BING_API_KEY',
  'BING_SITE_URL',
  'GSC_SUBMISSION_ENABLED',
  'GSC_SITE_URL',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'STRIPE_API_KEY',
  'STRIPE_WEBHOOK_SECRET',
];

describe('composeEngineEnv', () => {
  it('writes every variable the API reads on a server profile, with no placeholder', () => {
    const env = flat(composeEngineEnv(SERVER, secrets));
    for (const key of API_READS) expect(env, key).toHaveProperty(key);
    expect(Object.values(env).some((v) => /CHANGE_ME|PASTE_HERE/.test(v))).toBe(false);
    expect(env.NODE_ENV).toBe('production');
    expect(env.CORS_ORIGIN).toBe('https://atlas.example,https://admin.atlas.example');
    expect(env.DATABASE_URL).toContain(secrets.DB_PASSWORD);
    expect(env.TURNSTILE_SECRET).toBe('0xSECRET');
    expect(env).not.toHaveProperty('LICENSE_FILE');
    expect(env.MAIL_DEV_REDIRECT_TO).toBe('');
    expect(env.STRIPE_API_KEY).toBe('sk_test_1');
    expect(env.STRIPE_WEBHOOK_SECRET).toBe('whsec_1');
    expect(env.GSC_SUBMISSION_ENABLED).toBe('true');
  });

  it('runs a local profile under development with the redirect and local disk storage', () => {
    const env = flat(
      composeEngineEnv(
        {
          ...SERVER,
          profile: 'local',
          storage: { driver: 'local' },
          mail: { ...SERVER.mail, transport: 'console', devRedirectTo: 'me@example.test' },
          turnstile: { enabled: false },
          seo: {},
          domains: {
            storefront: 'http://localhost:53300',
            admin: 'http://localhost:53200',
            api: 'http://localhost:53000',
          },
        },
        secrets,
      ),
    );
    expect(env.NODE_ENV).toBe('development');
    expect(env.MAIL_DEV_REDIRECT_TO).toBe('me@example.test');
    expect(env.STORAGE_DRIVER).toBe('local');
    expect(env.UPLOADS_BASE_URL).toBe('http://localhost:53000/uploads');
    expect(env).not.toHaveProperty('TURNSTILE_SECRET');
    expect(env.GSC_SUBMISSION_ENABLED).toBe('false');
  });

  it('names the unanswered group', () => {
    expect(() => composeEngineEnv({ ...SERVER, mail: undefined }, secrets)).toThrow(
      ComposeEnvError,
    );
    expect(() => composeEngineEnv({ ...SERVER, mail: undefined }, secrets)).toThrow(
      /mail was never answered/,
    );
  });

  it('agrees with the storefront env on the revalidate secret when both run on one box', () => {
    const engine = flat(composeEngineEnv(SERVER, secrets));
    const storefront = flat(composeStorefrontEnv(SERVER, secrets));
    expect(storefront.STOREFRONT_REVALIDATE_SECRET).toBe(engine.STOREFRONT_REVALIDATE_SECRET);
    expect(storefront.STOREFRONT_API_URL).toBe('http://api:53000/api');
    expect(storefront.REDIS_PASSWORD).toBe(engine.REDIS_PASSWORD);
    expect(storefront.VITE_TURNSTILE_SITE_KEY).toBe('0xSITE');
  });

  it('takes the engine secret and origin from the answers on a storefront-only box', () => {
    const env = flat(
      composeStorefrontEnv(
        {
          ...SERVER,
          profile: 'storefront',
          engine: { apiUrl: 'https://api.atlas.example', revalidateSecret: 'shared' },
        },
        secrets,
      ),
    );
    expect(env.STOREFRONT_REVALIDATE_SECRET).toBe('shared');
    expect(env.STOREFRONT_API_URL).toBe('https://api.atlas.example/api');
    expect(env.REDIS_PASSWORD).toBe(secrets.STOREFRONT_REDIS_PASSWORD);
    expect(() => composeStorefrontEnv({ ...SERVER, profile: 'storefront' }, secrets)).toThrow(
      /engine\.apiUrl was never answered/,
    );
  });
});

describe('the API env census', () => {
  it('lists every variable the API reads that the stepper is responsible for', () => {
    // Read the API source the way the census did: a variable the API starts
    // reading tomorrow and this file does not know fails here, not on a box.
    const root = path.resolve(__dirname, '..', '..', '..', '..');
    const read = new Set<string>();
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
          const text = fs.readFileSync(full, 'utf8');
          for (const m of text.matchAll(
            /process\.env\.([A-Z][A-Z0-9_]+)|get<[^>]*>\('([A-Z][A-Z0-9_]+)'/g,
          )) {
            read.add(m[1] ?? m[2]);
          }
        }
      }
    };
    walk(path.join(root, 'apps', 'api', 'src'));
    // Variables the API reads that are not an install's to set: test switches,
    // optional providers the plan does not ship, tuning knobs with defaults.
    const notInstallOwned = new Set([
      'ENABLE_THROTTLE',
      'DISABLE_THROTTLE',
      'AUTH_SKIP_EMAIL_VERIFICATION',
      'CORS_ORIGINS',
      'SITE_URL',
      'STOREFRONT_REVALIDATE_URL_BASE',
      'STOREFRONT_MAX_FACET_SPREAD',
      'STOREFRONT_MIN_FACET_COVERAGE',
      'SENTRY_DSN',
      'SENTRY_TRACES_SAMPLE_RATE',
      'REDIS_TLS',
      'INVOICE_PDF_DUMP_DIR',
      'UPLOADS_ROOT',
      'INDEXNOW_HOST',
      'APPLE_CLIENT_ID',
      'APPLE_CLIENT_SECRET',
      'GOOGLE_CLIENT_ID',
      'GOOGLE_CLIENT_SECRET',
      'AUTH_COOKIE_DOMAIN',
      'DATABASE_TEST_URL',
      'REDIS_TEST_HOST',
      'REDIS_TEST_PORT',
      'STORE_CONFIG_FIXTURE',
      'S3_FORCE_PATH_STYLE',
      'PRIVATE_UPLOADS_DIR',
      'MAX_ASSET_SIZE_MB',
      'WINBACK_COUPON_CODE',
      'DEFAULT_PAGE_SIZE',
      'CONTACT_FORM_BCC',
      'RETURN_WINDOW_DAYS',
      'UPLOADS_BASE_URL',
      'PAYMENT_CONFIG_ENCRYPTION_KEY',
      'PAYMENT_CONFIG_ENCRYPTION_KEYS_PREVIOUS',
      'STRIPE_PUBLISHABLE_KEY',
    ]);
    const unknown = [...read].filter((k) => !API_READS.includes(k) && !notInstallOwned.has(k));
    expect(unknown).toEqual([]);
  });
});
