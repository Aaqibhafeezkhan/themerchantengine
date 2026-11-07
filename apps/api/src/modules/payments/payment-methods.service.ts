import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { PaginatedResult } from '@common/interceptors/api-response.interceptor';
import type { CreatePaymentMethodDto } from './dto/create-payment-method.dto';
import type { ListPaymentMethodsDto } from './dto/query-payment-methods.dto';
import type { UpdatePaymentMethodDto } from './dto/update-payment-method.dto';
import { MASKED_SECRET, PaymentConfigCrypto } from './payment-config-crypto';
import {
  type PaymentProviderCatalogueEntry,
  PaymentProviderRegistry,
} from './payment-provider.registry';
import { CHECKOUT_PAYMENT_PROVIDER_IDS } from './payment-providers';

/**
 * Legacy names masked for rows whose provider has no implementation (for
 * example `paypal`). Registered providers declare `secretFields` instead.
 * Config keys that must never leak their raw value on read. The stored
 * value is preserved; we just overwrite the returned copy with the
 * placeholder `***` so admin UIs can show "a secret is set" without
 * surfacing the secret itself.
 */
const MASKED_CONFIG_KEYS = new Set([
  'apiKey',
  'webhookSecret',
  'clientSecret',
  'privateKey',
  'signingSecret',
]);

const MASKED_PLACEHOLDER = MASKED_SECRET;

/**
 * Provider families the storefront checkout is allowed to offer: the
 * registered ones that declare `offeredAtCheckout`. A `paypal` row with no
 * provider behind it must never reach a customer, because it would produce
 * orders nobody can charge (plan F decision K-F4).
 */
export const STOREFRONT_PAYMENT_PROVIDERS = CHECKOUT_PAYMENT_PROVIDER_IDS;

/**
 * The public shape of a payment method. Deliberately a different type from
 * `PaymentMethodResult`: `config` carries provider secrets and `isTestMode`
 * is operator state, and neither is ever selected on this path. Masking is an
 * admin-read convenience, not a boundary.
 */
export interface StorefrontPaymentMethod {
  code: string;
  name: unknown;
  description: unknown;
  provider: string;
  sortOrder: number;
  /** True when the provider needs a payment step (redirect, form or embedded) after the order. */
  requiresPayment: boolean;
}

export interface PaymentMethodResult {
  id: string;
  code: string;
  name: unknown;
  description: unknown;
  provider: string;
  isActive: boolean;
  isTestMode: boolean;
  sortOrder: number;
  config: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class PaymentMethodsService {
  private readonly logger = new Logger(PaymentMethodsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: PaymentConfigCrypto,
    private readonly registry: PaymentProviderRegistry,
  ) {}

  providerCatalogue(): PaymentProviderCatalogueEntry[] {
    return this.registry.catalogue();
  }

  private secretFieldsOf(providerId: string): string[] {
    const declared = this.registry.has(providerId)
      ? this.registry.get(providerId).secretFields
      : [];
    return [...new Set([...declared, ...MASKED_CONFIG_KEYS])];
  }

  /**
   * Rewrites every stored secret under the current key: plaintext gets encrypted,
   * retired keys get replaced. Soft-deleted rows are included because their open
   * orders still reach the provider.
   */
  async reencryptAll(): Promise<{ rewritten: number; unchanged: number }> {
    const rows = await this.prisma.paymentMethod.findMany({
      where: { deletedAt: undefined },
      select: { id: true, provider: true, config: true },
    });
    let rewritten = 0;
    let unchanged = 0;
    for (const row of rows) {
      const config = (row.config ?? {}) as Record<string, unknown>;
      const next = this.crypto.reencrypt(config, this.secretFieldsOf(row.provider));
      if (JSON.stringify(next) === JSON.stringify(config)) {
        unchanged += 1;
        continue;
      }
      await this.prisma.paymentMethod.update({
        where: { id: row.id },
        data: { config: next as never },
      });
      rewritten += 1;
    }
    return { rewritten, unchanged };
  }

  async list(query: ListPaymentMethodsDto): Promise<PaginatedResult<PaymentMethodResult>> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const where = {
      deletedAt: null,
      ...(query.provider !== undefined && { provider: query.provider }),
      ...(query.isActive !== undefined && { isActive: query.isActive }),
    };

    const [rows, total] = await Promise.all([
      this.prisma.paymentMethod.findMany({
        where,
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.paymentMethod.count({ where }),
    ]);

    return {
      data: rows.map((r) => this.toResult(r)),
      meta: { page, pageSize, total },
    };
  }

  /**
   * The methods a customer may pick at checkout, in operator sort order.
   *
   * `name` and `description` stay Translatable JSONB here; the global
   * interceptor resolves them against the request's `Accept-Language` like
   * every other public payload.
   */
  async listStorefront(): Promise<StorefrontPaymentMethod[]> {
    const rows = await this.prisma.paymentMethod.findMany({
      where: {
        isActive: true,
        deletedAt: null,
        provider: { in: [...STOREFRONT_PAYMENT_PROVIDERS] },
      },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: {
        code: true,
        name: true,
        description: true,
        provider: true,
        sortOrder: true,
      },
    });
    // The `select` above is the real defence and the explicit rebuild below is
    // the second one. Widening that select later, by accident or by a copied
    // line, would otherwise start streaming `config` to anonymous visitors.
    return rows.map((r) => ({
      code: r.code,
      name: r.name,
      description: r.description,
      provider: r.provider,
      sortOrder: r.sortOrder,
      requiresPayment: this.registry.get(r.provider).actionTypes.some((type) => type !== 'none'),
    }));
  }

  async findOne(id: string): Promise<PaymentMethodResult> {
    const row = await this.prisma.paymentMethod.findFirst({
      where: { id, deletedAt: null },
    });
    if (!row) throw new NotFoundException(`Payment method "${id}" not found`);
    return this.toResult(row);
  }

  async create(dto: CreatePaymentMethodDto): Promise<PaymentMethodResult> {
    const existing = await this.prisma.paymentMethod.findUnique({
      where: { code: dto.code },
      select: { id: true, deletedAt: true },
    });
    // Soft-deleted code is considered taken too: operator should pick
    // a different identifier rather than reviving by collision.
    if (existing) throw new ConflictException(`Payment method code "${dto.code}" already in use`);

    const row = await this.prisma.paymentMethod.create({
      data: {
        code: dto.code,
        name: dto.name as never,
        description: (dto.description as never) ?? null,
        provider: dto.provider,
        isActive: dto.isActive ?? false,
        isTestMode: dto.isTestMode ?? false,
        sortOrder: dto.sortOrder ?? 0,
        config: this.crypto.encrypt(dto.config ?? {}, this.secretFieldsOf(dto.provider)) as never,
      },
    });

    this.logger.log(`create: code=${dto.code} provider=${dto.provider}`);
    return this.toResult(row);
  }

  async update(id: string, dto: UpdatePaymentMethodDto): Promise<PaymentMethodResult> {
    const existing = await this.prisma.paymentMethod.findFirst({
      where: { id, deletedAt: null },
    });
    if (!existing) throw new NotFoundException(`Payment method "${id}" not found`);

    const mergedConfig =
      dto.config !== undefined
        ? this.crypto.encrypt(
            this.mergeConfig(existing.config as Record<string, unknown>, dto.config),
            this.secretFieldsOf(existing.provider),
          )
        : undefined;

    const row = await this.prisma.paymentMethod.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name as never }),
        ...(dto.description !== undefined && { description: dto.description as never }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
        ...(dto.isTestMode !== undefined && { isTestMode: dto.isTestMode }),
        ...(dto.sortOrder !== undefined && { sortOrder: dto.sortOrder }),
        ...(mergedConfig !== undefined && { config: mergedConfig as never }),
      },
    });

    return this.toResult(row);
  }

  /** Soft-delete: deletedAt = now, isActive = false. */
  async remove(id: string): Promise<void> {
    const existing = await this.prisma.paymentMethod.findFirst({
      where: { id, deletedAt: null },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException(`Payment method "${id}" not found`);

    await this.prisma.paymentMethod.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });
  }

  /**
   * Atomically reorder the full set. Caller supplies an id list in the
   * desired sortOrder; rows that are not in the list keep their current
   * order (no gaps needed; sortOrder only has to be monotonically
   * increasing). 404 if any id is unknown.
   */
  async reorder(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) {
      throw new BadRequestException('Reorder payload must contain at least one id');
    }
    // Dedupe so the writes are deterministic.
    const unique = [...new Set(ids)];
    if (unique.length !== ids.length) {
      throw new BadRequestException('Reorder payload contains duplicate ids');
    }
    const found = await this.prisma.paymentMethod.findMany({
      where: { id: { in: unique }, deletedAt: null },
      select: { id: true },
    });
    if (found.length !== unique.length) {
      throw new NotFoundException('One or more payment method ids are unknown');
    }

    await this.prisma.$transaction(
      unique.map((id, index) =>
        this.prisma.paymentMethod.update({
          where: { id },
          data: { sortOrder: index },
        }),
      ),
    );
  }

  /**
   * Merge the config delta into the stored blob. Keys whose dto value
   * equals the masked placeholder are preserved (operator resubmitted
   * the form unchanged); real values overwrite, `null` deletes a key.
   */
  private mergeConfig(
    current: Record<string, unknown>,
    delta: Record<string, unknown>,
  ): Record<string, unknown> {
    const next = { ...current };
    for (const [k, v] of Object.entries(delta)) {
      if (v === MASKED_PLACEHOLDER) continue; // keep existing secret
      if (v === null) {
        delete next[k];
        continue;
      }
      next[k] = v;
    }
    return next;
  }

  private toResult(row: {
    id: string;
    code: string;
    name: unknown;
    description: unknown;
    provider: string;
    isActive: boolean;
    isTestMode: boolean;
    sortOrder: number;
    config: unknown;
    createdAt: Date;
    updatedAt: Date;
  }): PaymentMethodResult {
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      description: row.description,
      provider: row.provider,
      isActive: row.isActive,
      isTestMode: row.isTestMode,
      sortOrder: row.sortOrder,
      config: this.crypto.mask(
        (row.config ?? {}) as Record<string, unknown>,
        this.secretFieldsOf(row.provider),
      ),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
