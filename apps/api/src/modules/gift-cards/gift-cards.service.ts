import { randomBytes } from 'crypto';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { roundMoney } from '@common/money';
import { PrismaService } from '../../prisma/prisma.service';
import { GiftCardInvalidException } from './gift-card-invalid.exception';
import { GiftCardNotFoundException } from './gift-card-not-found.exception';
import { GiftCardInsufficientBalanceException } from './gift-card-insufficient-balance.exception';
import { GiftCardAmountInvalidException } from './gift-card-amount-invalid.exception';
import { GiftCardDeactivatedException } from './gift-card-deactivated.exception';
import { GiftCardCurrencyNotEnabledException } from './gift-card-currency-not-enabled.exception';
import { CurrenciesService } from '../currencies/currencies.service';
import type { PaginatedResult } from '@common/interceptors/api-response.interceptor';
import type { CreateGiftCardAdminDto } from './dto/create-gift-card.dto';
import type { UpdateGiftCardAdminDto } from './dto/update-gift-card.dto';
import type { ListGiftCardsAdminDto } from './dto/query-gift-card.dto';
import type { AdjustGiftCardBalanceDto } from './dto/adjust-balance.dto';
import {
  CODE_ALPHABET,
  CODE_LENGTH,
  DEFAULT_SORT_FIELD,
  DEFAULT_SORT_ORDER,
  GIFT_CARD_EVENTS,
  GIFT_CARD_SORT_FIELDS,
} from './gift-cards.constants';

const RESTORE_NOTE = 'Order cancellation restore';

// ── Public interface types ─────────────────────────────────────────────────────

export type GiftCardBalanceResult = {
  currentBalance: number;
  currency: string;
  expiresAt: Date | null;
};

export type RedeemResult = {
  transactionId: string;
  amountDebited: number;
  remainingBalance: number;
};

// ── Service ────────────────────────────────────────────────────────────────────

@Injectable()
export class GiftCardsService {
  private readonly logger = new Logger(GiftCardsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
    private readonly currencies: CurrenciesService,
  ) {}

  // ── Storefront: balance check (public) ─────────────────────────────────────

  /**
   * Returns current balance for a gift card code.
   *
   * Always throws a generic 400 on any failure — invalid code,
   * inactive card, or expired card — to prevent enumeration (spec §8.1 API6).
   */
  async checkBalance(code: string): Promise<GiftCardBalanceResult> {
    const card = await this.prisma.giftCard.findUnique({
      where: { code },
      select: {
        isActive: true,
        deletedAt: true,
        currentBalance: true,
        currency: true,
        expiresAt: true,
      },
    });

    if (!card || !card.isActive || card.deletedAt) {
      throw new GiftCardInvalidException();
    }

    if (card.expiresAt && card.expiresAt < new Date()) {
      throw new GiftCardInvalidException();
    }

    return {
      currentBalance: toNum(card.currentBalance),
      currency: card.currency,
      expiresAt: card.expiresAt,
    };
  }

  // ── Storefront: purchase (removed, DR-30) ─────────────────────────────────
  //
  // `purchase()` created a gift card straight from a request body: any
  // signed-in customer could name any `initialBalance` and get a card worth
  // it, with no payment captured and no order attached. Its own docblock said
  // payment capture was the Payments module's job; nothing ever called the
  // Payments module. The route is gone and so is this method, so a future
  // controller cannot re-expose it by accident. Admin issuance
  // (`create`, below) stays, behind `gift_cards:manage`.

  // ── Public: redeem (called by Orders module at checkout) ───────────────────

  /**
   * Atomically decrements the gift card balance.
   *
   * Uses Prisma updateMany with `currentBalance >= amount` predicate — this
   * maps to the SQL pattern in spec §9.4 C2:
   *   UPDATE gift_cards SET current_balance = current_balance - $amount
   *   WHERE id = $id AND current_balance >= $amount AND is_active = true
   *
   * If affected rows = 0 the balance is insufficient (or card is invalid).
   * Caller must pass orderId for the immutable ledger entry.
   */
  async redeem(
    code: string,
    amount: number,
    orderId: string,
    orderCurrency?: string,
  ): Promise<RedeemResult> {
    if (amount <= 0) {
      throw new GiftCardAmountInvalidException('Redeem amount must be positive');
    }

    const card = await this.prisma.giftCard.findUnique({
      where: { code },
      select: {
        id: true,
        isActive: true,
        deletedAt: true,
        expiresAt: true,
        currentBalance: true,
        currency: true,
      },
    });

    if (!card || !card.isActive || card.deletedAt) {
      throw new GiftCardInvalidException();
    }

    if (card.expiresAt && card.expiresAt < new Date()) {
      throw new GiftCardInvalidException();
    }

    // A card denominated in another currency cannot be spent against this
    // order. Nothing checked this before, so a 100-unit card in one currency paid 100 units of an
    // order in another at 1:1, a silent windfall on the exchange rate.
    // Latent while the store ran one currency; live from the moment the
    // default moved and pre-cutover cards remained redeemable.
    if (orderCurrency && card.currency !== orderCurrency) {
      throw new GiftCardInvalidException();
    }

    // Atomic decrement — spec §9.4 C2
    const result = await this.prisma.giftCard.updateMany({
      where: {
        id: card.id,
        isActive: true,
        deletedAt: null,
        currentBalance: { gte: amount },
      },
      data: { currentBalance: { decrement: amount } },
    });

    if (result.count === 0) {
      throw new GiftCardInsufficientBalanceException('Insufficient gift card balance');
    }

    // Append immutable ledger entry (negative = debit)
    const tx = await this.prisma.giftCardTransaction.create({
      data: {
        giftCardId: card.id,
        amount: -amount,
        orderId,
        note: 'Order redemption',
      },
    });

    // Quantised, because this figure is emitted on the REDEEMED event and
    // rendered into the customer's receipt. It is derived by subtraction from
    // the balance read BEFORE the atomic decrement, so at three decimals an
    // unrounded float here shows the customer a remaining balance that differs
    // from the stored one.
    const remainingBalance = roundMoney(toNum(card.currentBalance) - amount);

    this.logger.log(
      `redeem: code=${code} cardId=${card.id} amount=${amount} orderId=${orderId} remaining=${remainingBalance}`,
    );

    // Emit redeemed event so the MailModule listener can fire a receipt to
    // the original purchaser. Pulled separately (not joined on the atomic
    // updateMany) so we don't add SELECT overhead to the contested decrement.
    this.events.emit(GIFT_CARD_EVENTS.REDEEMED, {
      cardId: card.id,
      code,
      amount,
      remainingBalance,
      // The card's own currency, already selected above. The extra query and
      // its literal-currency tail are gone: the column is non-nullable with a
      // default, so the fallback was unreachable and, being a literal, wrong.
      currency: card.currency,
      orderId,
    });

    return {
      transactionId: tx.id,
      amountDebited: amount,
      remainingBalance,
    };
  }

  /**
   * Gives back what an order spent from gift cards. Called once when the order
   * is cancelled. The ledger is the source: every debit row of the order is
   * credited back unless a restore row already exists for that card, so a
   * second call changes nothing.
   */
  async restoreForOrder(orderId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const rows = await tx.giftCardTransaction.findMany({
        where: { orderId },
        select: { giftCardId: true, amount: true, note: true },
      });

      const restored = new Set(
        rows.filter((r) => r.note === RESTORE_NOTE).map((r) => r.giftCardId),
      );
      const spent = new Map<string, number>();
      for (const row of rows) {
        if (row.note === RESTORE_NOTE || toNum(row.amount) >= 0) continue;
        spent.set(row.giftCardId, roundMoney((spent.get(row.giftCardId) ?? 0) - toNum(row.amount)));
      }

      for (const [giftCardId, amount] of spent) {
        if (restored.has(giftCardId)) continue;
        await tx.giftCard.updateMany({
          where: { id: giftCardId },
          data: { currentBalance: { increment: amount } },
        });
        await tx.giftCardTransaction.create({
          data: { giftCardId, amount, orderId, note: RESTORE_NOTE },
        });
        this.logger.log(`restore: cardId=${giftCardId} amount=${amount} orderId=${orderId}`);
      }
    });
  }

  // ── Admin: CRUD ────────────────────────────────────────────────────────────

  async list(query: ListGiftCardsAdminDto): Promise<PaginatedResult<unknown>> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const sortField = GIFT_CARD_SORT_FIELDS.has(query.sortBy ?? '')
      ? query.sortBy!
      : DEFAULT_SORT_FIELD;
    const sortOrder = query.sortOrder === 'asc' ? 'asc' : DEFAULT_SORT_ORDER;

    const where = {
      deletedAt: null,
      ...(query.isActive !== undefined && { isActive: query.isActive }),
      ...(query.recipientEmail !== undefined && { recipientEmail: query.recipientEmail }),
      ...(query.purchasedBy !== undefined && {
        purchasedBy: query.purchasedBy === 'null' ? null : query.purchasedBy,
      }),
    };

    const [data, total] = await Promise.all([
      this.prisma.giftCard.findMany({
        where,
        orderBy: { [sortField]: sortOrder },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          code: true,
          initialBalance: true,
          currentBalance: true,
          currency: true,
          recipientEmail: true,
          recipientName: true,
          purchasedBy: true,
          isActive: true,
          expiresAt: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      this.prisma.giftCard.count({ where }),
    ]);

    return { data, meta: { page, pageSize, total } };
  }

  /**
   * Normalise an operator-supplied currency and reject anything the store does
   * not accept. The admin form used to default to USD and really created USD
   * cards in a single-currency store; the form is now a select over the enabled set and
   * this is the server-side half of that fix. Storefront `purchase` is out of
   * scope here — it does not take operator input the same way.
   */
  private async assertCurrencyEnabled(currency: string): Promise<string> {
    const normalized = currency.toUpperCase();
    const { data } = await this.currencies.list();
    const enabled = data.filter((c) => c.enabled).map((c) => c.code);

    if (!enabled.includes(normalized)) {
      throw new GiftCardCurrencyNotEnabledException(normalized, enabled);
    }
    return normalized;
  }

  /** Admin: issue a gift card or store-credit (purchasedBy omitted = store credit). */
  async issue(dto: CreateGiftCardAdminDto): Promise<unknown> {
    const currency = await this.assertCurrencyEnabled(dto.currency);
    const code = dto.code ?? generateCode();

    // Guard against duplicate codes (rare but possible on custom codes)
    const existing = await this.prisma.giftCard.findUnique({
      where: { code },
      select: { id: true },
    });
    if (existing) {
      throw new BadRequestException({
        error: {
          code: 'GIFT_CARD_CODE_TAKEN',
          message: `Gift card code "${code}" is already in use`,
        },
      });
    }

    const card = await this.prisma.giftCard.create({
      data: {
        code,
        initialBalance: dto.initialBalance,
        currentBalance: dto.initialBalance,
        currency,
        recipientEmail: dto.recipientEmail ?? null,
        recipientName: dto.recipientName ?? null,
        personalMessage: dto.personalMessage ?? undefined,
        purchasedBy: dto.purchasedBy ?? null,
        expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
        isActive: dto.isActive ?? true,
        transactions: {
          create: {
            amount: dto.initialBalance,
            note: dto.purchasedBy ? 'Admin issued' : 'Store credit issued',
          },
        },
      },
      include: { transactions: true },
    });

    this.logger.log(
      `issue: code=${code} balance=${dto.initialBalance} storeCredit=${!dto.purchasedBy}`,
    );

    // NE5: notify the recipient. A purchaser-backed grant is an admin-issued
    // gift card (purchase email); a purchaser-less grant with a recipient is a
    // store-credit grant. No recipient on file → nothing to send.
    if (card.recipientEmail) {
      if (card.purchasedBy) {
        this.events.emit(GIFT_CARD_EVENTS.PURCHASED, {
          cardId: card.id,
          code: card.code,
          recipientEmail: card.recipientEmail,
          recipientName: card.recipientName,
          personalMessage: card.personalMessage,
          initialBalance: toNum(card.initialBalance),
          currency: card.currency,
          purchaserUserId: card.purchasedBy,
        });
      } else {
        this.events.emit(GIFT_CARD_EVENTS.STORE_CREDIT_ISSUED, {
          cardId: card.id,
          code: card.code,
          recipientEmail: card.recipientEmail,
          balance: toNum(card.initialBalance),
          currency: card.currency,
        });
      }
    }

    return card;
  }

  /** Admin: detail view — card + full transaction log. */
  async findOne(id: string): Promise<unknown> {
    const card = await this.prisma.giftCard.findUnique({
      where: { id },
      include: {
        transactions: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!card || card.deletedAt) {
      throw new GiftCardNotFoundException(id);
    }

    return card;
  }

  /** Admin: activate or deactivate a gift card (isActive only). */
  async update(id: string, dto: UpdateGiftCardAdminDto): Promise<unknown> {
    await this.ensureExists(id);

    return this.prisma.giftCard.update({
      where: { id },
      data: {
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
      },
      include: {
        transactions: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });
  }

  /**
   * Admin: adjust the balance by a signed delta. Positive = credit,
   * negative = debit. Appends a ledger entry carrying the operator's
   * reason so the audit trail explains the manual correction.
   *
   * Atomicity: debits use `WHERE currentBalance >= |amount|` (spec §9.4
   * C2) so two concurrent debits cannot overdraw. Credits have no such
   * floor and use `increment`. The ledger entry is created in the same
   * Prisma transaction as the balance write.
   */
  async adjustBalance(id: string, dto: AdjustGiftCardBalanceDto): Promise<unknown> {
    const card = await this.prisma.giftCard.findUnique({
      where: { id },
      select: { id: true, deletedAt: true, currentBalance: true, isActive: true },
    });
    if (!card || card.deletedAt) {
      throw new GiftCardNotFoundException(id);
    }
    if (!card.isActive) {
      throw new GiftCardDeactivatedException('Cannot adjust the balance of a deactivated card');
    }
    if (dto.amount === 0) {
      throw new GiftCardAmountInvalidException('Adjustment amount must be non-zero');
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      if (dto.amount > 0) {
        await tx.giftCard.update({
          where: { id },
          data: { currentBalance: { increment: dto.amount } },
        });
      } else {
        const debit = Math.abs(dto.amount);
        const result = await tx.giftCard.updateMany({
          where: {
            id,
            isActive: true,
            deletedAt: null,
            currentBalance: { gte: debit },
          },
          data: { currentBalance: { decrement: debit } },
        });
        if (result.count === 0) {
          throw new GiftCardInsufficientBalanceException(
            'Insufficient balance for this adjustment',
          );
        }
      }

      await tx.giftCardTransaction.create({
        data: {
          giftCardId: id,
          amount: dto.amount,
          note: dto.reason,
          ...(dto.referenceId ? { orderId: dto.referenceId } : {}),
        },
      });

      return tx.giftCard.findUnique({
        where: { id },
        include: { transactions: { orderBy: { createdAt: 'asc' } } },
      });
    });

    this.logger.log(`adjustBalance: id=${id} delta=${dto.amount} reason="${dto.reason}"`);
    return updated;
  }

  /**
   * Admin: re-trigger the purchase email for a card (NE5). Validates the card +
   * recipient + active state, then re-emits PURCHASED with `forceResend` so the
   * mail dispatch engine sends a genuine new email (the resolver omits the dedupe
   * key for a forced resend — a stable cardId key would no-op the resend inside
   * the BullMQ retention window). Each resend is intentionally a fresh send; the
   * admin route rate-limit bounds abuse but does not collapse rapid double-clicks.
   */
  async resendEmail(id: string): Promise<{ status: 'queued'; recipientEmail: string }> {
    const card = await this.prisma.giftCard.findUnique({
      where: { id },
      select: {
        id: true,
        code: true,
        deletedAt: true,
        recipientEmail: true,
        recipientName: true,
        personalMessage: true,
        initialBalance: true,
        currency: true,
        purchasedBy: true,
        isActive: true,
      },
    });
    if (!card || card.deletedAt) {
      throw new GiftCardNotFoundException(id);
    }
    if (!card.recipientEmail) {
      throw new BadRequestException({
        error: {
          code: 'GIFT_CARD_NO_RECIPIENT',
          message: 'Gift card has no recipient email on file',
        },
      });
    }
    if (!card.isActive) {
      throw new GiftCardDeactivatedException('Cannot email a deactivated card');
    }
    this.events.emit(GIFT_CARD_EVENTS.PURCHASED, {
      cardId: card.id,
      code: card.code,
      recipientEmail: card.recipientEmail,
      recipientName: card.recipientName,
      personalMessage: card.personalMessage,
      initialBalance: toNum(card.initialBalance),
      currency: card.currency,
      purchaserUserId: card.purchasedBy,
      forceResend: true,
    });
    this.logger.log(`resendEmail: id=${id} code=${card.code} to=${card.recipientEmail}`);
    return { status: 'queued', recipientEmail: card.recipientEmail };
  }

  /**
   * Issues store credit to a customer as a gift card (§4.9 refund flow).
   * purchasedBy is intentionally null — store-issued credit per §4.12.
   */
  async issueStoreCredit(
    customerId: string,
    amount: number,
    currency: string,
  ): Promise<{ id: string; code: string }> {
    const user = await this.prisma.user.findUnique({
      where: { id: customerId },
      select: { email: true },
    });

    const code = generateCode();
    const card = await this.prisma.giftCard.create({
      data: {
        code,
        initialBalance: amount,
        currentBalance: amount,
        currency,
        recipientEmail: user?.email ?? null,
        purchasedBy: null,
        isActive: true,
        transactions: {
          create: { amount, note: 'Store credit issued — return refund' },
        },
      },
      select: { id: true, code: true },
    });

    this.logger.log(`issueStoreCredit: customerId=${customerId} amount=${amount} code=${code}`);
    return card;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async ensureExists(id: string): Promise<void> {
    const card = await this.prisma.giftCard.findUnique({
      where: { id },
      select: { id: true, deletedAt: true },
    });
    if (!card || card.deletedAt) {
      throw new GiftCardNotFoundException(id);
    }
  }
}

// ── Utilities ──────────────────────────────────────────────────────────────────

/** Generates a cryptographically random 16-char uppercase alphanumeric code. */
function generateCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return code;
}

/** Safely converts a Prisma Decimal or number to a JS number. */
function toNum(value: { toNumber(): number } | number): number {
  return typeof value === 'object' ? value.toNumber() : value;
}
