import type { ExecutionContext } from '@nestjs/common';

import { AppThrottlerGuard } from './throttler.guard';

// We only test getTracker since the rest of the logic lives in ThrottlerGuard.
// getTracker is protected, so we access it via a test subclass.
class TestableGuard extends AppThrottlerGuard {
  public tracker(req: Record<string, unknown>): Promise<string> {
    return this.getTracker(req);
  }
}

function makeGuard(): TestableGuard {
  // ThrottlerGuard constructor expects (options, storage, reflector)
  // All can be undefined for unit-testing getTracker.
  return new TestableGuard(undefined as never, undefined as never, undefined as never);
}

function makeContext(req: { ip?: string; socket?: { remoteAddress?: string } }): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => ({}),
      getNext: () => ({}),
    }),
  } as unknown as ExecutionContext;
}

// AppThrottlerGuard.canActivate has two observable outcomes for this test:
//   1. Bypass branches return `true` synchronously without invoking super.
//   2. Production-path branches fall through to super.canActivate(), which
//      throws because the test instance is constructed with undefined
//      ThrottlerGuard collaborators (options/storage/reflector).
// We use the throw as a positive signal that the bypass did NOT engage.
async function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => Promise<void>,
): Promise<void> {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) previous[key] = process.env[key];
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('AppThrottlerGuard.getTracker', () => {
  let guard: TestableGuard;

  beforeEach(() => {
    guard = makeGuard();
  });

  it('uses user ID prefix when req.user.id is present', async () => {
    const req = { user: { id: 'user-uuid-123' }, ip: '1.2.3.4' };
    expect(await guard.tracker(req)).toBe('user:user-uuid-123');
  });

  it('uses ip prefix when req.user is absent', async () => {
    const req = { ip: '10.0.0.1' };
    expect(await guard.tracker(req)).toBe('ip:10.0.0.1');
  });

  it('uses ip prefix when req.user.id is undefined', async () => {
    const req = { user: {}, ip: '10.0.0.2' };
    expect(await guard.tracker(req)).toBe('ip:10.0.0.2');
  });

  it('uses ip prefix when req.user is null', async () => {
    const req = { user: null, ip: '10.0.0.3' };
    expect(await guard.tracker(req)).toBe('ip:10.0.0.3');
  });

  it('falls back to ip: (empty) when ip is also missing', async () => {
    const req = {};
    expect(await guard.tracker(req)).toBe('ip:');
  });

  it('user tracker takes precedence over ip when both are present', async () => {
    const req = { user: { id: 'u1' }, ip: '9.9.9.9' };
    expect(await guard.tracker(req)).toBe('user:u1');
  });
});

describe('AppThrottlerGuard.canActivate bypass branches', () => {
  let guard: AppThrottlerGuard;

  beforeEach(() => {
    guard = makeGuard();
  });

  it('NODE_ENV=test bypasses unless ENABLE_THROTTLE is set', async () => {
    await withEnv(
      { NODE_ENV: 'test', ENABLE_THROTTLE: undefined, DISABLE_THROTTLE: undefined },
      async () => {
        await expect(guard.canActivate(makeContext({ ip: '8.8.8.8' }))).resolves.toBe(true);
      },
    );
  });

  it('NODE_ENV=test + ENABLE_THROTTLE=1 falls through to super (does NOT bypass)', async () => {
    await withEnv(
      { NODE_ENV: 'test', ENABLE_THROTTLE: '1', DISABLE_THROTTLE: undefined },
      async () => {
        await expect(guard.canActivate(makeContext({ ip: '8.8.8.8' }))).rejects.toBeDefined();
      },
    );
  });

  it('DISABLE_THROTTLE=1 bypasses in development', async () => {
    await withEnv(
      { NODE_ENV: 'development', DISABLE_THROTTLE: '1', ENABLE_THROTTLE: undefined },
      async () => {
        await expect(guard.canActivate(makeContext({ ip: '8.8.8.8' }))).resolves.toBe(true);
      },
    );
  });

  it('DISABLE_THROTTLE=1 is IGNORED in production (env-gated)', async () => {
    await withEnv(
      { NODE_ENV: 'production', DISABLE_THROTTLE: '1', ENABLE_THROTTLE: undefined },
      async () => {
        // Falls through to super.canActivate (which throws because the guard
        // was constructed without real ThrottlerGuard collaborators) — proves
        // the bypass did NOT engage in production.
        await expect(guard.canActivate(makeContext({ ip: '8.8.8.8' }))).rejects.toBeDefined();
      },
    );
  });

  it.each([['staging'], ['prod'], [undefined]])(
    'DISABLE_THROTTLE=1 is IGNORED under NODE_ENV=%s (every label outside test and development is production)',
    async (label) => {
      await withEnv(
        { NODE_ENV: label, DISABLE_THROTTLE: '1', ENABLE_THROTTLE: undefined },
        async () => {
          await expect(guard.canActivate(makeContext({ ip: '8.8.8.8' }))).rejects.toBeDefined();
        },
      );
    },
  );

  it('the loopback bypass does not engage under NODE_ENV=staging', async () => {
    await withEnv(
      { NODE_ENV: 'staging', DISABLE_THROTTLE: undefined, ENABLE_THROTTLE: undefined },
      async () => {
        await expect(guard.canActivate(makeContext({ ip: '127.0.0.1' }))).rejects.toBeDefined();
      },
    );
  });

  it('NODE_ENV=development bypasses on loopback 127.0.0.1', async () => {
    await withEnv(
      { NODE_ENV: 'development', DISABLE_THROTTLE: undefined, ENABLE_THROTTLE: undefined },
      async () => {
        await expect(guard.canActivate(makeContext({ ip: '127.0.0.1' }))).resolves.toBe(true);
      },
    );
  });

  it('NODE_ENV=development bypasses on loopback ::1 and ::ffff:127.0.0.1', async () => {
    await withEnv(
      { NODE_ENV: 'development', DISABLE_THROTTLE: undefined, ENABLE_THROTTLE: undefined },
      async () => {
        await expect(guard.canActivate(makeContext({ ip: '::1' }))).resolves.toBe(true);
        await expect(guard.canActivate(makeContext({ ip: '::ffff:127.0.0.1' }))).resolves.toBe(
          true,
        );
      },
    );
  });

  it('NODE_ENV=development falls through to super on a non-loopback ip', async () => {
    await withEnv(
      { NODE_ENV: 'development', DISABLE_THROTTLE: undefined, ENABLE_THROTTLE: undefined },
      async () => {
        await expect(guard.canActivate(makeContext({ ip: '8.8.8.8' }))).rejects.toBeDefined();
      },
    );
  });

  it('NODE_ENV=production with non-loopback ip falls through to super', async () => {
    await withEnv(
      { NODE_ENV: 'production', DISABLE_THROTTLE: undefined, ENABLE_THROTTLE: undefined },
      async () => {
        await expect(guard.canActivate(makeContext({ ip: '127.0.0.1' }))).rejects.toBeDefined();
        await expect(guard.canActivate(makeContext({ ip: '8.8.8.8' }))).rejects.toBeDefined();
      },
    );
  });
});
