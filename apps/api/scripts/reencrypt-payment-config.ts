/**
 * Re-encrypts every stored payment method secret under the current key.
 *
 * Run it after setting PAYMENT_CONFIG_ENCRYPTION_KEY for the first time (it
 * encrypts secrets that were saved as plaintext) and after a rotation (move the
 * old key to PAYMENT_CONFIG_ENCRYPTION_KEYS_PREVIOUS, set the new one, run this,
 * then drop the old key):
 *   npx ts-node -r tsconfig-paths/register --transpile-only apps/api/scripts/reencrypt-payment-config.ts
 *
 * Idempotent: a secret already under the current key is left as it is.
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { PaymentMethodsService } from '../src/modules/payments/payment-methods.service';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  try {
    const { rewritten, unchanged } = await app.get(PaymentMethodsService).reencryptAll();
    process.stdout.write(`Payment config: ${rewritten} rewritten, ${unchanged} unchanged.\n`);
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
