import * as path from 'path';
import { NestFactory, Reflector } from '@nestjs/core';
import { ClassSerializerInterceptor, ValidationPipe, BadRequestException } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { isProduction } from '@common/env';
import { SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import cookieParser from 'cookie-parser';
import express from 'express';
import { toNodeHandler } from 'better-auth/node';
import { AppModule } from './app.module';
import { StoreLocaleRegistry } from './modules/settings/store-locale.registry';
import { applyCacheControlHardening } from './bootstrap/cache-control-hardening';
import { corsOriginCheck } from './bootstrap/cors-origin';
import { applyEngineFingerprint } from './bootstrap/engine-fingerprint';
import { assertFtsIntegrity } from './bootstrap/fts-integrity';
import { serveLocalUploads } from './bootstrap/local-uploads';
import { buildOpenApiDocument } from './openapi/openapi';
import { PrismaService } from './prisma/prisma.service';
import { auth, AUTH_BASE_PATH } from './auth/auth';
import { validateMailEnv } from './modules/mail/config/mail.env';
import {
  HttpExceptionFilter,
  ApiResponseInterceptor,
  TranslatableInterceptor,
  DecimalSerializationInterceptor,
  flattenValidationErrors,
  initSentry,
} from '@common/index';

// Sentry must init before Nest — the SDK instruments undici/http on import.
initSentry();

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Disable NestJS's default console logger — Pino takes over
    bufferLogs: true,
    // Better Auth consumes its own raw request bodies — express.json() is
    // re-registered for every non-auth route just after the auth mount below.
    bodyParser: false,
  });

  // Browser-cache hardening per constitution §3.15-A. Disables Express's
  // weak-ETag emitter and defaults `Cache-Control: no-store` on every
  // response. Controllers that intentionally opt into browser caching
  // (sitemap, llms.txt, geo lookups) declare `@PublicCacheable(maxAge)`
  // which sets `Cache-Control: public, max-age=N` later in the request
  // lifecycle and overwrites the default. See
  // `apps/api/src/bootstrap/cache-control-hardening.ts` for the contract.
  applyCacheControlHardening(app);

  // `X-Powered-By: themerchantengine` instead of Express (DR-36).
  applyEngineFingerprint(app);

  // The local storage driver writes public files under ./uploads and hands
  // out URLs on this API; this is what answers them. The S3 driver mounts
  // nothing, the bucket serves. See `apps/api/src/bootstrap/local-uploads.ts`.
  serveLocalUploads(app, {
    driver: process.env.STORAGE_DRIVER,
    uploadsRoot: path.resolve(process.cwd(), process.env.UPLOADS_ROOT ?? 'uploads'),
    privateRoot: path.resolve(process.cwd(), process.env.PRIVATE_UPLOADS_DIR ?? 'uploads-private'),
  });

  // Use nestjs-pino as the application logger for all Nest-internal messages
  app.useLogger(app.get(Logger));
  app.flushLogs();

  // Optional global path prefix. Set API_GLOBAL_PREFIX=api when the admin
  // reaches the backend through a same-origin `/api/*` proxy (dev + e2e) —
  // routing, cookies, and swagger all hang off the same base path that way.
  // Default empty keeps existing deployments unchanged.
  const globalPrefix = process.env.API_GLOBAL_PREFIX ?? '';
  if (globalPrefix) {
    app.setGlobalPrefix(globalPrefix, { exclude: ['health'] });
  }

  // Cookie parser — required for refresh token cookies
  app.use(cookieParser());

  // ── Security ──────────────────────────────────────────────────────────────

  // CORS — origin allowlist from environment; no wildcard with credentials.
  // `CORS_ORIGIN` is the canonical name everywhere else (env.example, README);
  // `CORS_ORIGINS` stays as a fallback so older deployments don't break.
  // A production deployment extends `CORS_ORIGIN` with its public storefront
  // and admin origins. Dev defaults cover the four reserved local origins
  // (admin 53200/53211, storefront 53300/53311).
  const corsOrigins = (process.env.CORS_ORIGIN ?? process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  // Production fail-loud per constitution §3.7 (fail-loud on config). An empty
  // allowlist is the BA5 security-review C-2 finding: the CORS callback
  // silently rejects every cross-origin request (admin can't sign in), while
  // Better Auth's `trustedOrigins` (sourced from the same env var) silently
  // rejects every auth callback. Both fail-closed for authn, but operationally
  // catastrophic. Refuse to boot rather than serve a half-functional API.
  if (isProduction() && corsOrigins.length === 0) {
    throw new Error(
      'CORS_ORIGIN (or CORS_ORIGINS) is empty in NODE_ENV=production. ' +
        'Set it to a comma-separated allowlist of every front-end origin ' +
        '(admin + storefront) — Better Auth also derives its trustedOrigins ' +
        'from this value. See .env.production.example.',
    );
  }

  // Resend mail env — same fail-loud philosophy as CORS above. When
  // MAIL_TRANSPORT=resend in prod, RESEND_API_KEY + RESEND_WEBHOOK_SECRET
  // are required. Outside prod the schema's defaults keep dev + e2e on the
  // 'console' transport so a misconfigured local box doesn't accidentally
  // hit Resend with a missing key.
  if (isProduction()) {
    validateMailEnv(process.env);
  }

  app.enableCors({
    origin: corsOriginCheck(corsOrigins),
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: [
      'Authorization',
      'Content-Type',
      'Accept-Language',
      // A page cannot set Accept-Language: it is a forbidden header name in
      // the Fetch standard and WebKit still enforces that. Browser-side calls
      // state their locale here instead.
      'X-Locale',
      'X-Idempotency-Key',
      'X-Resolve-Locale',
      'X-Request-Id',
      'X-Requested-With',
    ],
    exposedHeaders: [
      'X-RateLimit-Limit',
      'X-RateLimit-Remaining',
      'X-RateLimit-Reset',
      'X-Request-Id',
      'Retry-After',
      'Sunset',
    ],
    maxAge: 86400, // Cache preflight for 24 h
  });

  // ── Better Auth ───────────────────────────────────────────────────────────
  // Mounted BEFORE express.json() — Better Auth consumes the raw request
  // stream. A path-checking middleware (not `app.use(path, …)`, which would
  // strip the prefix) keeps the full URL intact so Better Auth's own basePath
  // router resolves. AUTH_BASE_PATH honours API_GLOBAL_PREFIX. The §3.15-A
  // cache hardening above still covers these JSON responses (shared app).
  const betterAuthHandler = toNodeHandler(auth);
  app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.originalUrl.split('?')[0].startsWith(`${AUTH_BASE_PATH}/`)) {
      void betterAuthHandler(req, res);
      return;
    }
    next();
  });

  // ── Resend inbound webhook raw-body capture ───────────────────────────────
  // The Svix signature check in ResendWebhookService HMACs the exact bytes
  // Resend signed; we must capture the request stream BEFORE the global
  // JSON parser below consumes it. The `verify` callback runs synchronously
  // during JSON parsing and exposes the raw Buffer on req.rawBody. Limit
  // matches the global cap; Resend payloads are well under it (single-event
  // envelopes ~2 KB).
  // globalPrefix is the bare value (e.g. "api"), no leading slash — Express
  // app.use() needs an absolute "/api/v1/..." mount path or it never matches
  // the incoming "/api/v1/webhooks/resend" request and rawBody stays empty
  // (which silently breaks Svix signature verification). Build it with a
  // leading slash, collapsing the empty-prefix (dev) case to "/v1/...".
  const resendWebhookPath = globalPrefix
    ? `/${globalPrefix}/v1/webhooks/resend`
    : '/v1/webhooks/resend';
  app.use(
    resendWebhookPath,
    express.json({
      limit: '100kb',
      verify: (req: express.Request & { rawBody?: Buffer }, _res, buf) => {
        req.rawBody = Buffer.from(buf);
      },
    }),
  );

  // Payment provider webhooks (DR-34): same raw-byte need as Resend, but any
  // content type, since some providers post form-encoded bodies. The mount
  // prefix covers every `/:providerId`.
  const paymentsWebhookPath = globalPrefix
    ? `/${globalPrefix}/v1/webhooks/payments`
    : '/v1/webhooks/payments';
  app.use(paymentsWebhookPath, express.raw({ type: () => true, limit: '100kb' }));
  app.use(
    paymentsWebhookPath,
    (
      req: express.Request & { rawBody?: Buffer },
      _res: express.Response,
      next: express.NextFunction,
    ) => {
      if (Buffer.isBuffer(req.body)) req.rawBody = req.body;
      next();
    },
  );

  // Body size: 100 KB hard limit (spec §8.1 API4). File-upload routes raise
  // this per-controller via multer's own limits.
  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ limit: '100kb', extended: true }));

  // ── Global filters / interceptors / pipes ─────────────────────────────────

  // Exception filter — HttpException, Prisma errors, unknown errors
  app.useGlobalFilters(new HttpExceptionFilter());

  // Response interceptors. NestJS executes global interceptors in reverse on
  // the response path, so the registration order below means on outbound
  // responses: DecimalSerializationInterceptor runs first (converts Prisma
  // Decimal money fields to numbers — before ClassSerializerInterceptor would
  // otherwise mangle them to their internal { s, e, d } shape), then
  // ClassSerializerInterceptor strips @Exclude/@Expose on any class instance
  // the controller returns (constitution §3.5 + spec §8.1 API3 mass-assignment
  // defense — structural today; future entity classes carrying @Exclude land
  // their defenses here), then TranslatableInterceptor resolves Translatable
  // JSONB fields, then ApiResponseInterceptor wraps the payload into the
  // { data, meta? } envelope.
  app.useGlobalInterceptors(
    new ApiResponseInterceptor(),
    new TranslatableInterceptor(app.get(StoreLocaleRegistry)),
    new ClassSerializerInterceptor(app.get(Reflector)),
    new DecimalSerializationInterceptor(),
  );

  // Validation pipe
  // - whitelist: true              strip unknown properties (mass-assignment prevention)
  // - forbidNonWhitelisted: true   throw 400 VALIDATION_ERROR on unknown fields (strict mode, §3.5)
  // - transform: true              coerce plain objects to DTO class instances
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      // Flattened, not `errors.map`: a nested property carries its reasons on
      // its children, so the top-level-only version answered
      // `{"field":"description","messages":[]}` for every Translatable failure.
      exceptionFactory: (errors) => {
        const formatted = flattenValidationErrors(errors);
        return new BadRequestException({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Validation failed',
            details: formatted,
          },
        });
      },
    }),
  );

  // ── Swagger ───────────────────────────────────────────────────────────────
  // The same document `openapi-export.ts` writes for the public reference.
  const document = buildOpenApiDocument(app);
  SwaggerModule.setup('docs', app, document, {
    swaggerOptions: { persistAuthorization: true },
  });

  // ── Full-text-search integrity ────────────────────────────────────────────
  // Refuses to boot on dev and test when a bare `prisma db push` has dropped
  // `Product."searchVector"` and left its trigger attached, which silently
  // breaks search and every product write. Skipped in production, where the
  // repair runs as the superuser through the pg container. See
  // `apps/api/src/bootstrap/fts-integrity.ts`.
  //
  // raw-sql-approved: the integrity probe reads pg_catalog for the searchVector
  // column and its trigger, which Prisma's typed client cannot express. The SQL
  // is a constant in fts-integrity.ts and every value is passed as a bound
  // parameter; no request input reaches it. Reviewed at the O2 guard gate.
  await assertFtsIntegrity(
    (sql, ...params) =>
      app.get(PrismaService).$queryRawUnsafe(sql, ...params) as Promise<unknown[]>,
  );

  // ── Start ─────────────────────────────────────────────────────────────────
  const port = process.env.PORT ?? 53000;
  const server = await app.listen(port);

  // Global 30s request timeout — prevents runaway queries from holding threads (spec §8.1 API4)
  server.setTimeout(30_000);
}

bootstrap();
