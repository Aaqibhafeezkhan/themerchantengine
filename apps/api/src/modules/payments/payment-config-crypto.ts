import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentConfigEncryptionUnavailableException } from './payment-config-encryption-unavailable.exception';

export const MASKED_SECRET = '***';

const PREFIX = 'enc:v1:';
const KEY_BYTES = 32;
const IV_BYTES = 12;

type Config = Record<string, unknown>;

interface Key {
  id: string;
  bytes: Buffer;
}

function toKey(base64: string): Key {
  const bytes = Buffer.from(base64.trim(), 'base64');
  if (bytes.length !== KEY_BYTES) {
    throw new Error(`Payment config encryption keys must be ${KEY_BYTES} bytes, base64 encoded`);
  }
  return { id: createHash('sha256').update(bytes).digest('hex').slice(0, 8), bytes };
}

/**
 * AES-256-GCM over the secret fields of a payment method config. Stored form:
 * `enc:v1:<keyId>:<iv>:<tag>:<ciphertext>`. The current key comes from
 * PAYMENT_CONFIG_ENCRYPTION_KEY; retired keys stay readable through
 * PAYMENT_CONFIG_ENCRYPTION_KEYS_PREVIOUS (comma separated). Without a current
 * key the app still boots, plaintext still reads, and saving a secret is refused.
 */
@Injectable()
export class PaymentConfigCrypto {
  private readonly current: Key | undefined;
  private readonly byId = new Map<string, Key>();

  constructor(config: ConfigService) {
    const current = config.get<string>('PAYMENT_CONFIG_ENCRYPTION_KEY');
    const previous = config.get<string>('PAYMENT_CONFIG_ENCRYPTION_KEYS_PREVIOUS');
    this.current = current ? toKey(current) : undefined;
    const retired = (previous ?? '').split(',').filter((value) => value.trim());
    for (const key of [...(this.current ? [this.current] : []), ...retired.map(toKey)]) {
      this.byId.set(key.id, key);
    }
  }

  encrypt(config: Config, secretFields: readonly string[]): Config {
    return this.mapSecrets(config, secretFields, (value) => this.seal(value));
  }

  decrypt(config: Config, secretFields: readonly string[]): Config {
    return this.mapSecrets(config, secretFields, (value) => this.open(value));
  }

  /**
   * Reads with any known key and writes with the current one. Plaintext gets
   * encrypted; a value already under the current key is left as it is.
   */
  reencrypt(config: Config, secretFields: readonly string[]): Config {
    const currentPrefix = this.current ? `${PREFIX}${this.current.id}:` : undefined;
    return this.mapSecrets(config, secretFields, (value) =>
      currentPrefix && value.startsWith(currentPrefix) ? value : this.seal(this.open(value)),
    );
  }

  mask(config: Config, secretFields: readonly string[]): Config {
    const masked = { ...config };
    for (const field of secretFields) {
      if (typeof masked[field] === 'string' && masked[field] !== '') masked[field] = MASKED_SECRET;
    }
    return masked;
  }

  private mapSecrets(
    config: Config,
    secretFields: readonly string[],
    fn: (value: string) => string,
  ): Config {
    const next = { ...config };
    for (const field of secretFields) {
      const value = next[field];
      if (typeof value === 'string' && value !== '') next[field] = fn(value);
    }
    return next;
  }

  private seal(value: string): string {
    if (value.startsWith(PREFIX)) return value;
    if (!this.current) throw new PaymentConfigEncryptionUnavailableException();
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.current.bytes, iv);
    const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const parts = [this.current.id, iv, cipher.getAuthTag(), body].map((part, index) =>
      index === 0 ? (part as string) : (part as Buffer).toString('base64url'),
    );
    return `${PREFIX}${parts.join(':')}`;
  }

  private open(value: string): string {
    if (!value.startsWith(PREFIX)) return value;
    const [keyId, iv, tag, body] = value.slice(PREFIX.length).split(':');
    const key = keyId ? this.byId.get(keyId) : undefined;
    if (!key || !iv || !tag || !body) throw new PaymentConfigEncryptionUnavailableException();
    try {
      const decipher = createDecipheriv('aes-256-gcm', key.bytes, Buffer.from(iv, 'base64url'));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(body, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new PaymentConfigEncryptionUnavailableException();
    }
  }
}
