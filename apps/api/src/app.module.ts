import * as crypto from 'node:crypto';
import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { BullModule } from '@nestjs/bullmq';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { LoggerModule } from 'nestjs-pino';

// Core infrastructure
import { PrismaModule } from './prisma/prisma.module';
import { RedisThrottlerStorage } from './throttler/redis-throttler.storage';
import { CorrelationIdMiddleware, SecurityHeadersMiddleware } from '@common/middleware';
import { AppThrottlerGuard, OwnerGuardGuard } from '@common/guards';
import { IdempotencyModule } from './common/idempotency.module';
import { PermissionsGuard } from './modules/auth';
import { SessionAuthGuard } from './common/session-auth.guard';
import { redactUrl } from '@common/utils';
import { AuthMailerProvider } from './auth/auth-mailer.provider';

// Feature modules
import { UsersModule } from './modules/users';
import { ProductsModule } from './modules/products';
import { InventoryModule } from './modules/inventory';
import { CategoriesModule } from './modules/categories';
import { AssetsModule } from './modules/assets';
import { CartModule } from './modules/cart';
import { OrdersModule } from './modules/orders';
import { ReturnsModule } from './modules/returns';
import { ReviewsModule } from './modules/reviews';
import { PromotionsModule } from './modules/promotions';
import { GiftCardsModule } from './modules/gift-cards';
import { ContactModule } from './modules/contact';
import { WishlistModule } from './modules/wishlist';
import { SearchModule } from './modules/search';
import { ShippingModule } from './modules/shipping';
import { TaxModule } from './modules/tax';
import { StorefrontConfigModule } from './modules/storefront-config';
import { CmsModule } from './modules/cms';
import { SeoModule } from './modules/seo';
import { GeoModule } from './modules/geo';
import { AnalyticsModule } from './modules/analytics';
import { PaymentsModule } from './modules/payments';
import { CheckoutModule } from './modules/checkout';
import { CountriesModule } from './modules/countries';
import { CarriersModule } from './modules/carriers';
import { CurrenciesModule } from './modules/currencies';
import { NotificationsModule } from './modules/notifications';
import { MailModule } from './modules/mail';
import { CampaignsModule } from './modules/campaigns/campaigns.module';
import { WebhooksModule } from './modules/webhooks';
import { AuditLogModule } from './modules/audit-log';
import { SettingsModule } from './modules/settings';
import { HealthModule } from './health';

@Module({
  imports: [
    // ── Configuration ────────────────────────────────────────────────────────
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
    }),

    // ── Structured logging (pino) ────────────────────────────────────────────
    // Emits structured JSON in production; auto-assigns X-Request-Id via genReqId.
    LoggerModule.forRoot({
      pinoHttp: {
        // Log level from env (default: info)
        level: process.env.LOG_LEVEL ?? 'info',
        // Redact sensitive fields before writing to log
        redact: ['req.headers.authorization', 'req.headers.cookie'],
        // Forward the correlation id set by CorrelationIdMiddleware
        genReqId: (req) => (req.headers['x-request-id'] as string) || crypto.randomUUID(),
        // Lean serializers — never log full request/response bodies, and never
        // the value of a query parameter carrying personal data or a
        // credential. `redact` above only reaches headers, so without this the
        // customer email on `GET /v1/orders/:orderNumber/track?email=` lands in
        // every line for that request and in any proxy access log in front of
        // it (§3.7).
        serializers: {
          req: (req: { method: string; url: string; id?: string }) => ({
            method: req.method,
            url: redactUrl(req.url),
            requestId: req.id,
          }),
          res: (res: { statusCode: number }) => ({
            statusCode: res.statusCode,
          }),
        },
        // Structured JSON to stdout — no pino-pretty transport. The webpack
        // builder bundles the API into a single file (apps/api/webpack.config.js);
        // pino's worker-thread transports do not resolve from inside that
        // bundle, so the prior dev-only pino-pretty transport is dropped.
        // Pretty-print locally by piping: `nx serve api | npx pino-pretty`.
        // (BA2.9b — better-auth-migration.)
      },
    }),

    // ── Rate limiting (@nestjs/throttler v6 + Redis storage) ─────────────────
    // Default: 100 req/60s — overridden per-route with @RateLimit decorators.
    // Uses RedisThrottlerStorage for distributed, multi-instance rate limiting.
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        // Default fallback limits (individual routes use @RateLimit decorators)
        throttlers: [{ ttl: 60_000, limit: 100 }],
        storage: new RedisThrottlerStorage({
          host: config.get<string>('REDIS_HOST', 'localhost'),
          port: config.get<number>('REDIS_PORT', 56379),
          password: config.get<string>('REDIS_PASSWORD'),
        }),
      }),
    }),

    // ── BullMQ (Redis-backed job queues) ────────────────────────────────────
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.get<string>('REDIS_HOST', 'localhost'),
          port: config.get<number>('REDIS_PORT', 56379),
          password: config.get<string>('REDIS_PASSWORD'),
          // TLS only when explicitly opted in via REDIS_TLS=true. Self-hosted
          // Redis containers (the engine box uses redis:7-alpine with
          // requirepass over plain TCP) don't terminate TLS; gating on
          // NODE_ENV=production made the api hang in an ETIMEDOUT loop on
          // every BullMQ connect. Set REDIS_TLS=true only when pointing at
          // a managed Redis-as-a-service that actually serves TLS.
          ...(config.get('REDIS_TLS') === 'true' && { tls: {} }),
        },
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 1000 },
          removeOnComplete: 100,
          removeOnFail: 500,
        },
      }),
    }),

    EventEmitterModule.forRoot(),

    // ── Core infrastructure ──────────────────────────────────────────────────
    PrismaModule,
    IdempotencyModule,

    // ── Health ────────────────────────────────────────────────────────────────
    HealthModule,

    // ── Feature modules ──────────────────────────────────────────────────────
    // Authentication is owned by Better Auth (DR-24), mounted in main.ts — it
    // is not a NestJS module. The retired AuthModule's only survivor, the RBAC
    // PermissionsGuard, is registered globally below.
    UsersModule,
    ProductsModule,
    InventoryModule,
    CategoriesModule,
    AssetsModule,
    CartModule,
    OrdersModule,
    ReturnsModule,
    ReviewsModule,
    PromotionsModule,
    GiftCardsModule,
    ContactModule,
    WishlistModule,
    SearchModule,
    ShippingModule,
    TaxModule,
    StorefrontConfigModule,
    CmsModule,
    SeoModule,
    GeoModule,
    AnalyticsModule,
    PaymentsModule,
    CheckoutModule,
    CountriesModule,
    CarriersModule,
    CurrenciesModule,
    NotificationsModule,
    // MailModule must precede WebhooksModule (which imports MailService via
    // the Resend webhook listener) AND must be registered before the
    // top-level AuthMailerProvider provider so Nest can resolve MailService
    // when AuthMailerProvider is instantiated.
    MailModule,
    // NE9 — marketing / broadcast plane. After MailModule (imports its exports:
    // ResendClient, SuppressionService, NotificationPreferenceService, MailService).
    CampaignsModule,
    WebhooksModule,
    AuditLogModule,
    SettingsModule,
  ],

  providers: [
    // Apply AppThrottlerGuard globally — @RateLimit.Skip() disables per-route
    { provide: APP_GUARD, useClass: AppThrottlerGuard },
    // Session auth guard (Better Auth) — @Public() bypasses; @OptionalAuth() anonymous
    { provide: APP_GUARD, useClass: SessionAuthGuard },
    // RBAC permissions guard — @Permissions('module:action') on admin routes
    { provide: APP_GUARD, useClass: PermissionsGuard },
    // Storefront per-customer route gate — @OwnerGuard() asserts req.user.id
    // is present; service layer enforces the actual entity-ownership match.
    { provide: APP_GUARD, useClass: OwnerGuardGuard },
    // Registers the AuthMailer (Better Auth transactional emails) at bootstrap.
    AuthMailerProvider,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(
        // Correlation ID must run first so all subsequent logs carry the ID
        CorrelationIdMiddleware,
        SecurityHeadersMiddleware,
      )
      .forRoutes({ path: '*', method: RequestMethod.ALL });
  }
}
