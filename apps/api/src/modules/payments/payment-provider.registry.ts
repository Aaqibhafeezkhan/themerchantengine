import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { PAYMENT_PROVIDERS } from './payments.constants';
import { PaymentProviderUnknownException } from './payment-provider-unknown.exception';
import type { PaymentActionType, PaymentProvider } from './providers/payment-provider.interface';

const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9_]*$/;

export interface PaymentProviderCatalogueEntry {
  id: string;
  label: string;
  actionTypes: PaymentActionType[];
  secretFields: string[];
  configJsonSchema: Record<string, unknown>;
}

/** Resolves `PaymentMethod.provider` to the provider that handles it. */
@Injectable()
export class PaymentProviderRegistry {
  private readonly providers = new Map<string, PaymentProvider>();

  constructor(@Inject(PAYMENT_PROVIDERS) providers: PaymentProvider[]) {
    for (const provider of providers) {
      if (!PROVIDER_ID_PATTERN.test(provider.id)) {
        throw new Error(`Invalid payment provider id "${provider.id}": use lower snake case`);
      }
      if (this.providers.has(provider.id)) {
        throw new Error(`Duplicate payment provider id "${provider.id}"`);
      }
      if (provider.actionTypes.length === 0) {
        throw new Error(`Payment provider "${provider.id}" declares no action type`);
      }
      const configJsonSchema = z.toJSONSchema(provider.configSchema, { io: 'input' });
      const declared = Object.keys((configJsonSchema as { properties?: object }).properties ?? {});
      for (const field of provider.secretFields) {
        if (!declared.includes(field)) {
          throw new Error(
            `Payment provider "${provider.id}" lists secret field "${field}" missing from its config schema`,
          );
        }
      }
      this.providers.set(provider.id, provider);
    }
  }

  /** Everything the admin needs to render a provider, with no provider-specific code. */
  catalogue(): PaymentProviderCatalogueEntry[] {
    return this.list().map((provider) => ({
      id: provider.id,
      label: provider.label,
      actionTypes: [...provider.actionTypes],
      secretFields: [...provider.secretFields],
      configJsonSchema: z.toJSONSchema(provider.configSchema, { io: 'input' }) as Record<
        string,
        unknown
      >,
    }));
  }

  get(id: string): PaymentProvider {
    const provider = this.providers.get(id);
    if (!provider) throw new PaymentProviderUnknownException(id);
    return provider;
  }

  has(id: string): boolean {
    return this.providers.has(id);
  }

  ids(): string[] {
    return [...this.providers.keys()];
  }

  list(): PaymentProvider[] {
    return [...this.providers.values()];
  }
}
