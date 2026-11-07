import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service';
import { CurrenciesService } from '../currencies/currencies.service';
import { GiftCardsService } from './gift-cards.service';

// ── Factories ─────────────────────────────────────────────────────────────────

function makeCard(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'card-1',
    code: 'ABCD1234EFGH5678',
    initialBalance: 100,
    currentBalance: 100,
    currency: 'LYD',
    recipientEmail: 'recipient@test.com',
    recipientName: 'John Doe',
    personalMessage: null,
    purchasedBy: 'user-1',
    expiresAt: null,
    isActive: true,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    transactions: [],
    ...overrides,
  };
}

function makeTransaction(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'tx-1',
    giftCardId: 'card-1',
    amount: -50,
    orderId: 'order-1',
    note: 'Order redemption',
    createdAt: new Date(),
    ...overrides,
  };
}

// ── Prisma mock ───────────────────────────────────────────────────────────────

function makePrismaMock() {
  return {
    giftCard: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      count: jest.fn(),
    },
    giftCardTransaction: {
      create: jest.fn(),
      findMany: jest.fn(),
    },
    $transaction: jest.fn(),
  };
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('GiftCardsService', () => {
  let service: GiftCardsService;
  let prisma: ReturnType<typeof makePrismaMock>;
  let events: { emit: jest.Mock };
  let currencies: { list: jest.Mock };

  beforeEach(async () => {
    prisma = makePrismaMock();
    events = { emit: jest.fn() };
    currencies = {
      list: jest.fn().mockResolvedValue({
        data: [
          {
            code: 'LYD',
            symbol: 'DT',
            name: 'Libyan Dinar',
            decimalPlaces: 3,
            region: 'MENA',
            enabled: true,
            isDefault: true,
          },
          {
            code: 'USD',
            symbol: '$',
            name: 'US Dollar',
            decimalPlaces: 2,
            region: 'Americas',
            enabled: false,
            isDefault: false,
          },
        ],
        defaultCode: 'LYD',
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GiftCardsService,
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: events },
        { provide: CurrenciesService, useValue: currencies },
      ],
    }).compile();

    service = module.get(GiftCardsService);
  });

  // ── checkBalance ───────────────────────────────────────────────────────────

  describe('checkBalance', () => {
    it('returns balance for valid active card', async () => {
      prisma.giftCard.findUnique.mockResolvedValue(
        makeCard({ currentBalance: { toNumber: () => 75 }, currency: 'LYD', expiresAt: null }),
      );

      const result = await service.checkBalance('ABCD1234EFGH5678');

      expect(result.currentBalance).toBe(75);
      expect(result.currency).toBe('LYD');
      expect(result.expiresAt).toBeNull();
    });

    it('throws GIFT_CARD_INVALID when card not found', async () => {
      prisma.giftCard.findUnique.mockResolvedValue(null);

      // All three checkBalance failure modes (not-found, inactive, expired)
      // collapse to the same code per §8.1 API6 enumeration-mask; siblings
      // below assert instanceof BadRequestException and inherit transitively
      // (GiftCardInvalidException extends BadRequestException).
      await expect(service.checkBalance('BADCODE')).rejects.toMatchObject({
        response: { error: { code: 'GIFT_CARD_INVALID' } },
      });
    });

    it('throws generic 400 when card is inactive', async () => {
      prisma.giftCard.findUnique.mockResolvedValue(makeCard({ isActive: false }));

      await expect(service.checkBalance('ABCD1234EFGH5678')).rejects.toThrow(BadRequestException);
    });

    it('throws generic 400 when card is soft-deleted', async () => {
      prisma.giftCard.findUnique.mockResolvedValue(makeCard({ deletedAt: new Date() }));

      await expect(service.checkBalance('ABCD1234EFGH5678')).rejects.toThrow(BadRequestException);
    });

    it('throws generic 400 when card is expired', async () => {
      const past = new Date(Date.now() - 1000);
      prisma.giftCard.findUnique.mockResolvedValue(makeCard({ expiresAt: past }));

      await expect(service.checkBalance('ABCD1234EFGH5678')).rejects.toThrow(BadRequestException);
    });

    it('does NOT throw when card expires in the future', async () => {
      const future = new Date(Date.now() + 86400_000);
      prisma.giftCard.findUnique.mockResolvedValue(
        makeCard({ currentBalance: { toNumber: () => 50 }, expiresAt: future }),
      );

      const result = await service.checkBalance('ABCD1234EFGH5678');

      expect(result.expiresAt).toEqual(future);
    });
  });

  // ── redeem ─────────────────────────────────────────────────────────────────

  describe('restoreForOrder', () => {
    beforeEach(() => {
      prisma.$transaction.mockImplementation((cb: (tx: unknown) => Promise<unknown>) => cb(prisma));
    });

    it('credits back what the order spent and writes a restore row', async () => {
      prisma.giftCardTransaction.findMany.mockResolvedValue([
        { giftCardId: 'gc-1', amount: -40, note: 'Order redemption' },
      ]);
      prisma.giftCard.updateMany.mockResolvedValue({ count: 1 });

      await service.restoreForOrder('order-1');

      expect(prisma.giftCard.updateMany).toHaveBeenCalledWith({
        where: { id: 'gc-1' },
        data: { currentBalance: { increment: 40 } },
      });
      expect(prisma.giftCardTransaction.create).toHaveBeenCalledWith({
        data: {
          giftCardId: 'gc-1',
          amount: 40,
          orderId: 'order-1',
          note: 'Order cancellation restore',
        },
      });
    });

    it('does nothing when the card was already restored', async () => {
      prisma.giftCardTransaction.findMany.mockResolvedValue([
        { giftCardId: 'gc-1', amount: -40, note: 'Order redemption' },
        { giftCardId: 'gc-1', amount: 40, note: 'Order cancellation restore' },
      ]);

      await service.restoreForOrder('order-1');

      expect(prisma.giftCard.updateMany).not.toHaveBeenCalled();
      expect(prisma.giftCardTransaction.create).not.toHaveBeenCalled();
    });

    it('does nothing when the order spent no gift card', async () => {
      prisma.giftCardTransaction.findMany.mockResolvedValue([]);

      await service.restoreForOrder('order-1');

      expect(prisma.giftCard.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('redeem', () => {
    it('atomically decrements balance and logs transaction', async () => {
      prisma.giftCard.findUnique.mockResolvedValue(
        makeCard({ currentBalance: { toNumber: () => 100 } }),
      );
      prisma.giftCard.updateMany.mockResolvedValue({ count: 1 });
      prisma.giftCardTransaction.create.mockResolvedValue(makeTransaction({ id: 'tx-new' }));

      const result = await service.redeem('ABCD1234EFGH5678', 40, 'order-1');

      expect(prisma.giftCard.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ currentBalance: { gte: 40 } }),
          data: { currentBalance: { decrement: 40 } },
        }),
      );
      expect(prisma.giftCardTransaction.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ amount: -40, orderId: 'order-1' }),
        }),
      );
      expect(result.amountDebited).toBe(40);
      expect(result.remainingBalance).toBe(60);
      expect(result.transactionId).toBe('tx-new');
    });

    it('refuses a card denominated in another currency, without debiting it', async () => {
      // Nothing compared the two before D4, so a card in one currency paid an
      // order in another at 1:1. The assertion that matters is the second one:
      // the guard must run BEFORE the atomic decrement, so a rejected
      // redemption leaves the balance untouched rather than debiting and
      // then failing.
      prisma.giftCard.findUnique.mockResolvedValue(
        makeCard({ currency: 'AED', currentBalance: { toNumber: () => 100 } }),
      );

      await expect(service.redeem('ABCD1234EFGH5678', 40, 'order-1', 'LYD')).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.giftCard.updateMany).not.toHaveBeenCalled();
      expect(prisma.giftCardTransaction.create).not.toHaveBeenCalled();
    });

    it('redeems when the card currency matches the order currency', async () => {
      prisma.giftCard.findUnique.mockResolvedValue(
        makeCard({ currency: 'LYD', currentBalance: { toNumber: () => 100 } }),
      );
      prisma.giftCard.updateMany.mockResolvedValue({ count: 1 });
      prisma.giftCardTransaction.create.mockResolvedValue(makeTransaction({ id: 'tx-new' }));

      const result = await service.redeem('ABCD1234EFGH5678', 40.5, 'order-1', 'LYD');

      expect(prisma.giftCard.updateMany).toHaveBeenCalled();
      // Quantised to the millime rather than left as a raw float, because this
      // figure is emitted on the REDEEMED event and rendered into the receipt.
      expect(result.remainingBalance).toBe(59.5);
    });
    it('throws 400 on insufficient balance (updateMany returns count=0)', async () => {
      prisma.giftCard.findUnique.mockResolvedValue(
        makeCard({ currentBalance: { toNumber: () => 10 } }),
      );
      prisma.giftCard.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.redeem('ABCD1234EFGH5678', 50, 'order-1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws 400 for non-positive amount', async () => {
      await expect(service.redeem('ABCD1234EFGH5678', 0, 'order-1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws 400 when card not found', async () => {
      prisma.giftCard.findUnique.mockResolvedValue(null);

      await expect(service.redeem('BADCODE', 10, 'order-1')).rejects.toThrow(BadRequestException);
    });

    it('throws 400 when card is expired', async () => {
      const past = new Date(Date.now() - 1000);
      prisma.giftCard.findUnique.mockResolvedValue(
        makeCard({ currentBalance: { toNumber: () => 100 }, expiresAt: past }),
      );

      await expect(service.redeem('ABCD1234EFGH5678', 10, 'order-1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws 400 when card is inactive', async () => {
      prisma.giftCard.findUnique.mockResolvedValue(
        makeCard({ currentBalance: { toNumber: () => 100 }, isActive: false }),
      );

      await expect(service.redeem('ABCD1234EFGH5678', 10, 'order-1')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // ── purchase (removed at D8, DR-30) ───────────────────────────────────────
  //
  // The customer-facing mint is gone: it created a card worth whatever the
  // request body named, with no payment captured. Its idempotency behaviour
  // was the only unique thing these cases covered, and IdempotencyService has
  // its own spec plus e2e coverage on orders, inventory, returns and webhooks.

  // ── issue (admin) ──────────────────────────────────────────────────────────

  describe('issue', () => {
    it('issues gift card with provided code', async () => {
      const created = makeCard({ code: 'CUSTOM12345ABCDE' });
      prisma.giftCard.findUnique.mockResolvedValue(null); // code not taken
      prisma.giftCard.create.mockResolvedValue(created);

      const result = await service.issue({
        code: 'CUSTOM12345ABCDE',
        initialBalance: 200,
        currency: 'LYD',
      });

      expect(prisma.giftCard.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ code: 'CUSTOM12345ABCDE', initialBalance: 200 }),
        }),
      );
      expect(result).toEqual(created);
    });

    it('auto-generates code when not provided', async () => {
      prisma.giftCard.findUnique.mockResolvedValue(null);
      prisma.giftCard.create.mockResolvedValue(makeCard());

      await service.issue({ initialBalance: 50, currency: 'LYD' });

      const callArgs = prisma.giftCard.create.mock.calls[0][0] as {
        data: { code: string };
      };
      expect(callArgs.data.code).toMatch(/^[A-Z0-9]{16}$/);
    });

    it('issues store credit when purchasedBy is omitted', async () => {
      prisma.giftCard.findUnique.mockResolvedValue(null);
      prisma.giftCard.create.mockResolvedValue(makeCard({ purchasedBy: null }));

      await service.issue({ initialBalance: 50, currency: 'LYD' });

      const callArgs = prisma.giftCard.create.mock.calls[0][0] as {
        data: { purchasedBy: null; transactions: { create: { note: string } } };
      };
      expect(callArgs.data.purchasedBy).toBeNull();
      expect(callArgs.data.transactions.create.note).toBe('Store credit issued');
    });

    it('rejects a currency outside the enabled set', async () => {
      prisma.giftCard.findUnique.mockResolvedValue(null);

      await expect(service.issue({ initialBalance: 50, currency: 'USD' })).rejects.toMatchObject({
        response: { error: { code: 'GIFT_CARD_CURRENCY_NOT_ENABLED' } },
      });
      expect(prisma.giftCard.create).not.toHaveBeenCalled();
    });

    it('accepts an enabled currency in any case', async () => {
      prisma.giftCard.findUnique.mockResolvedValue(null);
      prisma.giftCard.create.mockResolvedValue(makeCard());

      await service.issue({ initialBalance: 50, currency: 'lyd' });

      const callArgs = prisma.giftCard.create.mock.calls[0][0] as { data: { currency: string } };
      expect(callArgs.data.currency).toBe('LYD');
    });

    it('throws 400 when custom code is already taken', async () => {
      prisma.giftCard.findUnique.mockResolvedValue(makeCard()); // code exists

      await expect(
        service.issue({ code: 'TAKEN00000000000', initialBalance: 50, currency: 'LYD' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('emits PURCHASED for an admin-issued card with a recipient (NE5)', async () => {
      prisma.giftCard.findUnique.mockResolvedValue(null);
      prisma.giftCard.create.mockResolvedValue(
        makeCard({ purchasedBy: 'user-1', recipientEmail: 'r@e.com' }),
      );

      await service.issue({
        initialBalance: 50,
        currency: 'LYD',
        purchasedBy: 'user-1',
        recipientEmail: 'r@e.com',
      });

      expect(events.emit).toHaveBeenCalledWith(
        'giftcard.purchased',
        expect.objectContaining({
          cardId: 'card-1',
          recipientEmail: 'r@e.com',
          purchaserUserId: 'user-1',
        }),
      );
    });

    it('emits STORE_CREDIT_ISSUED for a purchaser-less grant with a recipient (NE5)', async () => {
      prisma.giftCard.findUnique.mockResolvedValue(null);
      prisma.giftCard.create.mockResolvedValue(
        makeCard({ purchasedBy: null, recipientEmail: 'r@e.com' }),
      );

      await service.issue({ initialBalance: 50, currency: 'LYD', recipientEmail: 'r@e.com' });

      expect(events.emit).toHaveBeenCalledWith(
        'giftcard.store-credit-issued',
        expect.objectContaining({
          cardId: 'card-1',
          recipientEmail: 'r@e.com',
          balance: 100,
          // The CARD's currency, not the requested one. They agreed by accident
          // before, which is why nothing showed which of the two is emitted.
          currency: 'LYD',
        }),
      );
    });

    it('emits nothing when an issued card has no recipient (NE5)', async () => {
      prisma.giftCard.findUnique.mockResolvedValue(null);
      prisma.giftCard.create.mockResolvedValue(
        makeCard({ purchasedBy: null, recipientEmail: null }),
      );

      await service.issue({ initialBalance: 50, currency: 'LYD' });

      expect(events.emit).not.toHaveBeenCalled();
    });
  });

  // ── resendEmail (admin) ──────────────────────────────────────────────────────

  describe('resendEmail', () => {
    it('re-emits PURCHASED with forceResend for a genuine resend (NE5)', async () => {
      prisma.giftCard.findUnique.mockResolvedValue(
        makeCard({ recipientEmail: 'r@e.com', isActive: true }),
      );

      const result = await service.resendEmail('card-1');

      expect(events.emit).toHaveBeenCalledWith(
        'giftcard.purchased',
        expect.objectContaining({
          cardId: 'card-1',
          recipientEmail: 'r@e.com',
          forceResend: true,
        }),
      );
      expect(result).toEqual({ status: 'queued', recipientEmail: 'r@e.com' });
    });

    it('throws 404 when the card is missing or soft-deleted', async () => {
      prisma.giftCard.findUnique.mockResolvedValue(null);

      await expect(service.resendEmail('missing')).rejects.toThrow(NotFoundException);
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('throws 400 when the card has no recipient email', async () => {
      prisma.giftCard.findUnique.mockResolvedValue(makeCard({ recipientEmail: null }));

      await expect(service.resendEmail('card-1')).rejects.toThrow(BadRequestException);
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('throws when the card is deactivated', async () => {
      prisma.giftCard.findUnique.mockResolvedValue(makeCard({ isActive: false }));

      await expect(service.resendEmail('card-1')).rejects.toThrow();
      expect(events.emit).not.toHaveBeenCalled();
    });
  });

  // ── findOne (admin) ────────────────────────────────────────────────────────

  describe('findOne', () => {
    it('returns card with transaction log', async () => {
      const card = makeCard({ transactions: [makeTransaction()] });
      prisma.giftCard.findUnique.mockResolvedValue(card);

      const result = await service.findOne('card-1');

      expect(result).toEqual(card);
    });

    it('throws 404 for unknown id', async () => {
      prisma.giftCard.findUnique.mockResolvedValue(null);

      await expect(service.findOne('bad-id')).rejects.toThrow(NotFoundException);
    });

    it('throws 404 for soft-deleted card', async () => {
      prisma.giftCard.findUnique.mockResolvedValue(makeCard({ deletedAt: new Date() }));

      await expect(service.findOne('card-1')).rejects.toThrow(NotFoundException);
    });
  });

  // ── update (admin) ─────────────────────────────────────────────────────────

  describe('update', () => {
    it('deactivates card', async () => {
      prisma.giftCard.findUnique.mockResolvedValue(makeCard());
      prisma.giftCard.update.mockResolvedValue(makeCard({ isActive: false }));

      await service.update('card-1', { isActive: false });

      expect(prisma.giftCard.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { isActive: false } }),
      );
    });

    it('throws 404 when card does not exist', async () => {
      prisma.giftCard.findUnique.mockResolvedValue(null);

      await expect(service.update('bad-id', { isActive: true })).rejects.toThrow(NotFoundException);
    });
  });

  // ── list (admin) ───────────────────────────────────────────────────────────

  describe('list', () => {
    it('returns paginated result with defaults', async () => {
      prisma.giftCard.findMany.mockResolvedValue([makeCard()]);
      prisma.giftCard.count.mockResolvedValue(1);

      const result = await service.list({});

      expect(result.meta).toEqual({ page: 1, pageSize: 20, total: 1 });
      expect(result.data).toHaveLength(1);
    });

    it('filters by isActive', async () => {
      prisma.giftCard.findMany.mockResolvedValue([]);
      prisma.giftCard.count.mockResolvedValue(0);

      await service.list({ isActive: false });

      expect(prisma.giftCard.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ isActive: false }) }),
      );
    });

    it('rejects unknown sort field and falls back to createdAt', async () => {
      prisma.giftCard.findMany.mockResolvedValue([]);
      prisma.giftCard.count.mockResolvedValue(0);

      await service.list({ sortBy: 'injectedField; DROP TABLE' });

      expect(prisma.giftCard.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: { createdAt: 'desc' } }),
      );
    });

    it('lists store-credit cards when purchasedBy=null string', async () => {
      prisma.giftCard.findMany.mockResolvedValue([]);
      prisma.giftCard.count.mockResolvedValue(0);

      await service.list({ purchasedBy: 'null' });

      expect(prisma.giftCard.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ purchasedBy: null }) }),
      );
    });
  });
});
