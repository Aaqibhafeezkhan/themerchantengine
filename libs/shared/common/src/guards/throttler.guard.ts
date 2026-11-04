import { ExecutionContext, Injectable } from '@nestjs/common';
import { runtimeEnvironment } from '../env';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Application-level throttler guard.
 *
 * Extends @nestjs/throttler's ThrottlerGuard with two customisations:
 *
 * 1. Tracker strategy:
 *    - Authenticated requests  → keyed by `user:<userId>` (per-user quota)
 *    - Unauthenticated requests → keyed by `ip:<clientIp>` (per-IP quota)
 *
 * 2. The base guard already sets the rate-limit response headers:
 *      X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset
 *    and Retry-After on 429 responses — no additional work needed here.
 *
 * Apply globally in AppModule or per-route via @RateLimit decorators.
 */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  /**
   * Skip rate limiting in test environment unless ENABLE_THROTTLE is set.
   * Also skips in development when requests originate from the loopback
   * address (127.0.0.1 / ::1) — this covers the Vite dev-server proxy
   * used by the storefront e2e suite, where all requests share the same
   * IP bucket and the home page fires 5 concurrent API calls per load.
   *
   * Both bypasses are environment-gated: production deployments cannot
   * disable throttling via env var (DISABLE_THROTTLE only honored when
   * NODE_ENV !== 'production'), and the loopback bypass is restricted to
   * NODE_ENV === 'development'. CORS + firewall rules already prevent
   * external clients from masquerading as loopback, but the env-gate
   * guarantees the bypass cannot accidentally ship to production.
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const env = runtimeEnvironment();
    if (env === 'test' && !process.env.ENABLE_THROTTLE) return true;
    if (env !== 'production' && process.env.DISABLE_THROTTLE === '1') return true;
    if (env === 'development') {
      const req = context
        .switchToHttp()
        .getRequest<{ ip?: string; socket?: { remoteAddress?: string } }>();
      const ip = req.ip ?? req.socket?.remoteAddress ?? '';
      if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return true;
    }
    return super.canActivate(context);
  }
  /**
   * Returns the tracker string used as part of the Redis key.
   * Authenticated users are throttled per user ID; everyone else per IP.
   */
  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    const user = req['user'] as { id?: string } | undefined;
    if (user?.id) {
      return `user:${user.id}`;
    }
    // req.ip may be undefined in tests; fall back to empty string
    return `ip:${(req['ip'] as string | undefined) ?? ''}`;
  }
}
