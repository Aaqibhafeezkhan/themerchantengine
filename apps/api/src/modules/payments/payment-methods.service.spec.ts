import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { PaymentConfigCrypto } from './payment-config-crypto';
import { PaymentMethodsService } from './payment-methods.service';
import { PaymentProviderRegistry } from './payment-provider.registry';

// ConfigService reads process.env before its own values, so a key in .env (loaded by nx) would win.
function isolatedConfig(env: Record<string, string>): ConfigService {
  return { get: (name: string) => env[name] } as unknown as ConfigService;
}

const KEY = Buffer.alloc(32, 7).toString('base64');
const crypto = new PaymentConfigCrypto(isolatedConfig({ PAYMENT_CONFIG_ENCRYPTION_KEY: KEY }));

function makeRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'pm-1',
    code: 'stripe_live',
    name: { default: 'Stripe', en: 'Stripe' },
    description: null,
    provider: 'stripe',
    isActive: false,
    isTestMode: false,
    sortOrder: 0,
    config: { apiKey: 'sk_live_xxxx', publishableKey: 'pk_live_yyyy' },
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  };
}

function makePrismaMock() {
  return {
    paymentMethod: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
    },
    $transaction: jest.fn((ops: unknown[]) => Promise.all(ops as Promise<unknown>[])),
  };
}

describe('PaymentMethodsService', () => {
  let service: PaymentMethodsService;
  let prisma: ReturnType<typeof makePrismaMock>;

  beforeEach(async () => {
    prisma = makePrismaMock();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentMethodsService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: PaymentConfigCrypto,
          useValue: crypto,
        },
        {
          provide: PaymentProviderRegistry,
          useValue: {
            has: (id: string) => id === 'canary_pay' || id === 'cod' || id === 'card_pay',
            get: (id: string) => ({
              secretFields: ['merchantPassword'],
              actionTypes: id === 'card_pay' ? ['redirect', 'embedded'] : ['none'],
            }),
          },
        },
      ],
    }).compile();
    service = module.get(PaymentMethodsService);
  });

  describe('list', () => {
    it('paginates + masks config secrets', async () => {
      prisma.paymentMethod.findMany.mockResolvedValue([makeRow()]);
      prisma.paymentMethod.count.mockResolvedValue(1);

      const res = await service.list({ page: 1, pageSize: 20 });
      expect(res.meta.total).toBe(1);
      expect(res.data[0].config['apiKey']).toBe('***');
      // Non-secret keys pass through.
      expect(res.data[0].config['publishableKey']).toBe('pk_live_yyyy');
    });
  });

  describe('findOne', () => {
    it('404s when missing', async () => {
      prisma.paymentMethod.findFirst.mockResolvedValue(null);
      await expect(service.findOne('missing')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('create', () => {
    it('rejects a duplicate code with 409', async () => {
      prisma.paymentMethod.findUnique.mockResolvedValue({ id: 'existing', deletedAt: null });
      await expect(
        service.create({
          code: 'stripe_live',
          name: { default: 'Stripe' },
          provider: 'stripe',
        } as never),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('persists + masks secrets on the response', async () => {
      prisma.paymentMethod.findUnique.mockResolvedValue(null);
      prisma.paymentMethod.create.mockResolvedValue(makeRow());
      const out = await service.create({
        code: 'stripe_live',
        name: { default: 'Stripe' },
        provider: 'stripe',
        config: { apiKey: 'sk_live_xxxx' },
      } as never);
      expect(out.config['apiKey']).toBe('***');
    });
  });

  describe('update', () => {
    it('404s when missing', async () => {
      prisma.paymentMethod.findFirst.mockResolvedValue(null);
      await expect(service.update('pm-x', { isActive: true })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('merges the config delta — masked values preserve the stored secret', async () => {
      const stored = makeRow({ config: { apiKey: 'sk_live_real', flag: false } });
      prisma.paymentMethod.findFirst.mockResolvedValue(stored);
      prisma.paymentMethod.update.mockImplementation(({ data }: { data: unknown }) =>
        Promise.resolve(
          makeRow({ ...(data as object), config: (data as { config: unknown }).config }),
        ),
      );
      const out = await service.update('pm-1', {
        // Operator submitted the form with masked placeholder for the secret;
        // we must keep the real value stored, not overwrite with "***".
        config: { apiKey: '***', flag: true },
      });
      expect((out.config as Record<string, unknown>)['flag']).toBe(true);
      // update call saw the REAL apiKey preserved in the merge.
      const writeArgs = prisma.paymentMethod.update.mock.calls[0][0];
      expect(writeArgs.data.config['apiKey']).toMatch(/^enc:v1:/);
      expect(crypto.decrypt(writeArgs.data.config, ['apiKey'])['apiKey']).toBe('sk_live_real');
    });

    it('null in config deletes the key', async () => {
      const stored = makeRow({ config: { flag: true, stale: 'x' } });
      prisma.paymentMethod.findFirst.mockResolvedValue(stored);
      prisma.paymentMethod.update.mockImplementation(({ data }: { data: unknown }) =>
        Promise.resolve(
          makeRow({ ...(data as object), config: (data as { config: unknown }).config }),
        ),
      );
      await service.update('pm-1', { config: { stale: null } as never });
      const writeArgs = prisma.paymentMethod.update.mock.calls[0][0];
      expect('stale' in writeArgs.data.config).toBe(false);
      expect(writeArgs.data.config['flag']).toBe(true);
    });
  });

  describe('reorder', () => {
    it('rejects empty payload', async () => {
      await expect(service.reorder([])).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects duplicate ids', async () => {
      await expect(service.reorder(['a', 'a'])).rejects.toBeInstanceOf(BadRequestException);
    });

    it('404s when any id is unknown', async () => {
      prisma.paymentMethod.findMany.mockResolvedValue([{ id: 'a' }]);
      await expect(service.reorder(['a', 'b'])).rejects.toBeInstanceOf(NotFoundException);
    });

    it('writes monotonically increasing sortOrder per id in the payload', async () => {
      prisma.paymentMethod.findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
      prisma.paymentMethod.update.mockResolvedValue(makeRow());
      await service.reorder(['b', 'a']);
      const calls = prisma.paymentMethod.update.mock.calls.map((c) => c[0]);
      expect(calls[0]).toEqual({ where: { id: 'b' }, data: { sortOrder: 0 } });
      expect(calls[1]).toEqual({ where: { id: 'a' }, data: { sortOrder: 1 } });
    });
  });

  describe('remove', () => {
    it('soft-deletes + clears active flag', async () => {
      prisma.paymentMethod.findFirst.mockResolvedValue({ id: 'pm-1' });
      prisma.paymentMethod.update.mockResolvedValue(makeRow());
      await service.remove('pm-1');
      const writeArgs = prisma.paymentMethod.update.mock.calls[0][0];
      expect(writeArgs.data.isActive).toBe(false);
      expect(writeArgs.data.deletedAt).toBeInstanceOf(Date);
    });
  });
  // ── listStorefront (plan F phase F1) ──────────────────────────────────────
  //
  // The public checkout projection. Everything here is a leak boundary: the
  // stored `config` blob carries provider secrets, and masking is an admin-read
  // convenience, never a defence. This projection selects the public columns
  // and nothing else, so there is no blob to mask.
  describe('listStorefront', () => {
    it('queries only active, non-deleted methods of an exposed provider, ordered by sortOrder', async () => {
      prisma.paymentMethod.findMany.mockResolvedValue([]);
      await service.listStorefront();
      const args = prisma.paymentMethod.findMany.mock.calls[0][0] as {
        where: Record<string, unknown>;
        orderBy: unknown;
        select?: Record<string, boolean>;
      };
      expect(args.where).toMatchObject({
        isActive: true,
        deletedAt: null,
        provider: { in: ['cod', 'manual', 'stripe'] },
      });
      expect(args.orderBy).toEqual([{ sortOrder: 'asc' }, { createdAt: 'asc' }]);
      // An explicit select is the guarantee. A `select` that omits `config`
      // means the secret never leaves Postgres, which a post-query delete does
      // not give us.
      expect(args.select).toBeDefined();
      expect(args.select).not.toHaveProperty('config');
      expect(args.select).not.toHaveProperty('isTestMode');
    });

    it('flags a method as requiring a payment step from the provider action types', async () => {
      prisma.paymentMethod.findMany.mockResolvedValue([
        { code: 'cod', name: {}, description: null, provider: 'cod', sortOrder: 0 },
        { code: 'card', name: {}, description: null, provider: 'card_pay', sortOrder: 1 },
      ]);
      const rows = await service.listStorefront();
      expect(rows.map((r) => [r.code, r.requiresPayment])).toEqual([
        ['cod', false],
        ['card', true],
      ]);
    });

    it('projects code, name, description, provider, sortOrder and requiresPayment, and nothing else', async () => {
      prisma.paymentMethod.findMany.mockResolvedValue([
        {
          code: 'cod',
          name: { default: 'Cash on delivery', fr: 'Paiement a la livraison' },
          description: null,
          provider: 'cod',
          sortOrder: 0,
        },
      ]);
      const rows = await service.listStorefront();
      expect(rows).toHaveLength(1);
      expect(Object.keys(rows[0]).sort()).toEqual([
        'code',
        'description',
        'name',
        'provider',
        'requiresPayment',
        'sortOrder',
      ]);
      expect(rows[0].code).toBe('cod');
    });

    it('never surfaces a config key even when the row carries one', async () => {
      prisma.paymentMethod.findMany.mockResolvedValue([
        {
          code: 'manual_transfer',
          name: { default: 'Bank transfer' },
          description: { default: 'Wire the total' },
          provider: 'manual',
          sortOrder: 1,
          config: { apiKey: 'sk_live_leaked' },
          isTestMode: true,
        },
      ]);
      const rows = await service.listStorefront();
      expect(rows[0]).not.toHaveProperty('config');
      expect(rows[0]).not.toHaveProperty('isTestMode');
      expect(JSON.stringify(rows)).not.toContain('sk_live_leaked');
    });
  });

  describe('secret fields declared by the provider', () => {
    it('encrypts them on create and never stores plaintext', async () => {
      prisma.paymentMethod.findUnique.mockResolvedValue(null);
      prisma.paymentMethod.create.mockImplementation(({ data }: { data: object }) =>
        Promise.resolve(makeRow(data)),
      );

      const out = await service.create({
        code: 'canary',
        name: { default: 'Canary' },
        provider: 'canary_pay',
        config: { merchantId: 'm-1', merchantPassword: 'hunter2' },
      } as never);

      const stored = prisma.paymentMethod.create.mock.calls[0][0].data.config;
      expect(stored.merchantPassword).toMatch(/^enc:v1:/);
      expect(JSON.stringify(stored)).not.toContain('hunter2');
      expect(out.config['merchantPassword']).toBe('***');
      expect(out.config['merchantId']).toBe('m-1');
    });

    it('keeps the stored ciphertext when the form resubmits the mask', async () => {
      const stored = makeRow({
        provider: 'canary_pay',
        config: { merchantPassword: 'enc:v1:abcd1234:iv:tag:body' },
      });
      prisma.paymentMethod.findFirst.mockResolvedValue(stored);
      prisma.paymentMethod.update.mockImplementation(({ data }: { data: object }) =>
        Promise.resolve(makeRow({ provider: 'canary_pay', ...data })),
      );

      await service.update('pm-1', { config: { merchantPassword: '***' } });

      const written = prisma.paymentMethod.update.mock.calls[0][0].data.config;
      expect(written.merchantPassword).toBe('enc:v1:abcd1234:iv:tag:body');
    });

    it('masks them on read', async () => {
      prisma.paymentMethod.findFirst.mockResolvedValue(
        makeRow({ provider: 'canary_pay', config: { merchantPassword: 'enc:v1:k:i:t:b' } }),
      );

      const out = await service.findOne('pm-1');

      expect(out.config['merchantPassword']).toBe('***');
    });
  });

  describe('reencryptAll', () => {
    const oldKey = Buffer.alloc(32, 3).toString('base64');
    const oldCrypto = new PaymentConfigCrypto(
      isolatedConfig({ PAYMENT_CONFIG_ENCRYPTION_KEY: oldKey }),
    );

    it('rewrites plaintext and old-key secrets with the current key, soft-deleted rows included', async () => {
      prisma.paymentMethod.findMany.mockResolvedValue([
        makeRow({
          id: 'pm-plain',
          provider: 'canary_pay',
          config: { merchantId: 'm-1', merchantPassword: 'hunter2' },
        }),
        makeRow({
          id: 'pm-old',
          provider: 'canary_pay',
          deletedAt: new Date(),
          config: oldCrypto.encrypt({ merchantPassword: 'hunter3' }, ['merchantPassword']),
        }),
        makeRow({ id: 'pm-none', provider: 'canary_pay', config: { merchantId: 'm-2' } }),
      ]);
      prisma.paymentMethod.update.mockResolvedValue({});
      const rotating = new PaymentConfigCrypto(
        isolatedConfig({
          PAYMENT_CONFIG_ENCRYPTION_KEY: KEY,
          PAYMENT_CONFIG_ENCRYPTION_KEYS_PREVIOUS: oldKey,
        }),
      );
      (service as unknown as { crypto: PaymentConfigCrypto }).crypto = rotating;

      const result = await service.reencryptAll();

      expect(prisma.paymentMethod.findMany).toHaveBeenCalledWith({
        where: { deletedAt: undefined },
        select: { id: true, provider: true, config: true },
      });
      expect(
        Object.prototype.hasOwnProperty.call(
          prisma.paymentMethod.findMany.mock.calls[0][0].where,
          'deletedAt',
        ),
      ).toBe(true);
      expect(result).toEqual({ rewritten: 2, unchanged: 1 });
      const writes = prisma.paymentMethod.update.mock.calls.map(
        ([arg]: [{ where: { id: string }; data: { config: Record<string, string> } }]) => arg,
      );
      expect(writes.map((w) => w.where.id)).toEqual(['pm-plain', 'pm-old']);
      for (const write of writes) {
        expect(write.data.config['merchantPassword']).toMatch(/^enc:v1:/);
        expect(rotating.decrypt(write.data.config, ['merchantPassword'])).toBeDefined();
      }
      expect(JSON.stringify(writes)).not.toContain('hunter');
    });

    it('rewrites nothing when every secret is already under the current key', async () => {
      prisma.paymentMethod.findMany.mockResolvedValue([
        makeRow({
          provider: 'canary_pay',
          config: crypto.encrypt({ merchantPassword: 'hunter2' }, ['merchantPassword']),
        }),
      ]);

      await expect(service.reencryptAll()).resolves.toEqual({ rewritten: 0, unchanged: 1 });
      expect(prisma.paymentMethod.update).not.toHaveBeenCalled();
    });
  });
});
