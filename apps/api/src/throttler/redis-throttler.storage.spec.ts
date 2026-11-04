import { RedisThrottlerStorage } from './redis-throttler.storage';

// ── Redis mock ───────────────────────────────────────────────────────────────

const mockEval = jest.fn();
const mockQuit = jest.fn().mockResolvedValue('OK');

jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    eval: mockEval,
    quit: mockQuit,
  }));
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('RedisThrottlerStorage', () => {
  let storage: RedisThrottlerStorage;

  beforeEach(() => {
    jest.clearAllMocks();
    storage = new RedisThrottlerStorage({ host: 'localhost', port: 56379 });
  });

  describe('increment()', () => {
    it('returns totalHits and timeToExpire from Redis eval result', async () => {
      mockEval.mockResolvedValue([3, 57_000]);

      const result = await storage.increment('test:key', 60_000, 100, 0, 'default');

      expect(result).toEqual({
        totalHits: 3,
        timeToExpire: 57,
        isBlocked: false,
        timeToBlockExpire: 0,
      });
    });

    it('calls Redis eval with the correct Lua script arguments', async () => {
      mockEval.mockResolvedValue([1, 60]);

      await storage.increment('route:127.0.0.1', 60_000, 100, 0, 'default');

      // First arg: script, second: numkeys, third: key, fourth: ttl string
      expect(mockEval).toHaveBeenCalledWith(
        expect.stringContaining('INCR'),
        1,
        'route:127.0.0.1',
        '60000',
      );
    });

    it('passes TTL as a string (Redis eval ARGV are strings)', async () => {
      mockEval.mockResolvedValue([1, 900]);

      await storage.increment('auth:key', 900_000, 5, 0, 'default');

      const [, , , ttlArg] = mockEval.mock.calls[0] as unknown[];
      expect(typeof ttlArg).toBe('string');
      expect(ttlArg).toBe('900000');
    });

    it('clamps negative timeToExpire to 0', async () => {
      // Redis TTL returns -1 when a key has no expiry (shouldn't happen normally)
      mockEval.mockResolvedValue([5, -1]);

      const result = await storage.increment('bad:key', 60_000, 100, 0, 'default');

      expect(result.timeToExpire).toBe(0);
    });

    it('clamps zero timeToExpire', async () => {
      mockEval.mockResolvedValue([10, 0]);

      const result = await storage.increment('expired:key', 60_000, 100, 0, 'default');

      expect(result.timeToExpire).toBe(0);
    });

    it('propagates Redis errors', async () => {
      mockEval.mockRejectedValue(new Error('Redis connection error'));

      await expect(storage.increment('key', 60_000, 100, 0, 'default')).rejects.toThrow(
        'Redis connection error',
      );
    });
  });

  describe('onModuleDestroy()', () => {
    it('calls redis.quit()', async () => {
      await storage.onModuleDestroy();
      expect(mockQuit).toHaveBeenCalledTimes(1);
    });
  });
});
