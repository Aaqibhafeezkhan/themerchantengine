import { randomBytes } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { PaymentConfigCrypto } from './payment-config-crypto';
import { PaymentConfigEncryptionUnavailableException } from './payment-config-encryption-unavailable.exception';

const keyA = randomBytes(32).toString('base64');
const keyB = randomBytes(32).toString('base64');

// ConfigService reads process.env before its own values, so a key in .env (loaded by nx) would win.
function isolatedConfig(env: Record<string, string>): ConfigService {
  return { get: (name: string) => env[name] } as unknown as ConfigService;
}

function crypto(env: Record<string, string> = {}): PaymentConfigCrypto {
  return new PaymentConfigCrypto(isolatedConfig(env));
}

describe('PaymentConfigCrypto', () => {
  const config = { merchantId: 'm-1', merchantPassword: 'hunter2', mode: 'live' };

  it('encrypts only the secret fields', () => {
    const stored = crypto({ PAYMENT_CONFIG_ENCRYPTION_KEY: keyA }).encrypt(config, [
      'merchantPassword',
    ]);

    expect(stored['merchantId']).toBe('m-1');
    expect(stored['mode']).toBe('live');
    expect(stored['merchantPassword']).toMatch(/^enc:v1:[0-9a-f]{8}:/);
    expect(JSON.stringify(stored)).not.toContain('hunter2');
  });

  it('round-trips a secret', () => {
    const c = crypto({ PAYMENT_CONFIG_ENCRYPTION_KEY: keyA });

    const stored = c.encrypt(config, ['merchantPassword']);

    expect(c.decrypt(stored, ['merchantPassword'])).toEqual(config);
  });

  it('uses a fresh iv, so the same secret never stores the same text twice', () => {
    const c = crypto({ PAYMENT_CONFIG_ENCRYPTION_KEY: keyA });

    const one = c.encrypt(config, ['merchantPassword']);
    const two = c.encrypt(config, ['merchantPassword']);

    expect(one['merchantPassword']).not.toBe(two['merchantPassword']);
  });

  it('does not encrypt twice', () => {
    const c = crypto({ PAYMENT_CONFIG_ENCRYPTION_KEY: keyA });
    const once = c.encrypt(config, ['merchantPassword']);

    expect(c.encrypt(once, ['merchantPassword'])).toEqual(once);
  });

  it('reads legacy plaintext as is', () => {
    const c = crypto({ PAYMENT_CONFIG_ENCRYPTION_KEY: keyA });

    expect(c.decrypt(config, ['merchantPassword'])).toEqual(config);
  });

  it('reads plaintext without any key, so the app still works before a key is set', () => {
    expect(crypto().decrypt(config, ['merchantPassword'])).toEqual(config);
  });

  it('refuses to save a secret without a key, with a stable code', () => {
    expect(() => crypto().encrypt(config, ['merchantPassword'])).toThrow(
      PaymentConfigEncryptionUnavailableException,
    );
  });

  it('saves a config with no secret value without a key', () => {
    const noSecret = { merchantId: 'm-1', mode: 'live' };

    expect(crypto().encrypt(noSecret, ['merchantPassword'])).toEqual(noSecret);
  });

  it('refuses a key that is not 32 bytes', () => {
    const short = randomBytes(16).toString('base64');

    expect(() => crypto({ PAYMENT_CONFIG_ENCRYPTION_KEY: short })).toThrow(/32 bytes/);
  });

  it('decrypts with a previous key after rotation and re-encrypts with the current one', () => {
    const old = crypto({ PAYMENT_CONFIG_ENCRYPTION_KEY: keyA });
    const stored = old.encrypt(config, ['merchantPassword']);
    const rotated = crypto({
      PAYMENT_CONFIG_ENCRYPTION_KEY: keyB,
      PAYMENT_CONFIG_ENCRYPTION_KEYS_PREVIOUS: keyA,
    });

    expect(rotated.decrypt(stored, ['merchantPassword'])).toEqual(config);
    const reencrypted = rotated.reencrypt(stored, ['merchantPassword']);
    expect(reencrypted['merchantPassword']).not.toBe(stored['merchantPassword']);
    expect(
      crypto({ PAYMENT_CONFIG_ENCRYPTION_KEY: keyB }).decrypt(reencrypted, ['merchantPassword']),
    ).toEqual(config);
  });

  it('fails closed on a tampered value', () => {
    const c = crypto({ PAYMENT_CONFIG_ENCRYPTION_KEY: keyA });
    const stored = c.encrypt(config, ['merchantPassword']);
    const text = stored['merchantPassword'] as string;
    const tampered = { ...stored, merchantPassword: `${text.slice(0, -2)}AA` };

    expect(() => c.decrypt(tampered, ['merchantPassword'])).toThrow(
      PaymentConfigEncryptionUnavailableException,
    );
  });

  it('fails closed when the key is gone for a stored secret', () => {
    const stored = crypto({ PAYMENT_CONFIG_ENCRYPTION_KEY: keyA }).encrypt(config, [
      'merchantPassword',
    ]);

    expect(() => crypto().decrypt(stored, ['merchantPassword'])).toThrow(
      PaymentConfigEncryptionUnavailableException,
    );
  });

  it('masks every secret field for reads', () => {
    const c = crypto({ PAYMENT_CONFIG_ENCRYPTION_KEY: keyA });
    const stored = c.encrypt(config, ['merchantPassword']);

    expect(c.mask(stored, ['merchantPassword'])).toEqual({
      merchantId: 'm-1',
      mode: 'live',
      merchantPassword: '***',
    });
    expect(c.mask(config, ['merchantPassword'])['merchantPassword']).toBe('***');
  });
});
