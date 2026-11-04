import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';
import Redis from 'ioredis';

/**
 * Lua script for atomic rate-limit increment.
 *
 * Arguments:
 *   KEYS[1] — the throttle key
 *   ARGV[1] — TTL in milliseconds
 *
 * Returns: { currentCount, remainingTtlMs }
 *
 * Atomicity guarantee: INCR + conditional EXPIRE run as a single Redis operation.
 * If this is the first hit (current == 1) the key is given its TTL, ensuring
 * the window always expires even if the caller crashes between INCR and EXPIRE.
 */
const INCREMENT_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
return {current, ttl}
`;

@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage, OnModuleDestroy {
  private readonly redis: Redis;

  constructor(redisOptions: { host: string; port: number; password?: string }) {
    this.redis = new Redis({
      host: redisOptions.host,
      port: redisOptions.port,
      password: redisOptions.password,
      // Fail fast in dev; do not retry indefinitely
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: true,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
  }

  /**
   * Atomically increments the hit counter for `key`.
   *
   * @param key  - Unique throttle key (built by ThrottlerGuard from route + tracker)
   * @param ttl  - Window duration in **milliseconds** (@nestjs/throttler v6 convention)
   * @returns    ThrottlerStorageRecord with totalHits and timeToExpire (seconds).
   *             Blocking is not used by this app, so isBlocked is always false.
   */
  async increment(key: string, ttl: number): Promise<ThrottlerStorageRecord> {
    const result = (await this.redis.eval(INCREMENT_SCRIPT, 1, key, String(ttl))) as [
      number,
      number,
    ];

    const [totalHits, timeToExpireMs] = result;

    return {
      totalHits,
      // Clamp to 0 to guard against PTTL=-1 (no expiry)
      timeToExpire: Math.max(0, Math.ceil(timeToExpireMs / 1000)),
      isBlocked: false,
      timeToBlockExpire: 0,
    };
  }
}
