import { isPlatformBrowser } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  inject,
  OnInit,
  PLATFORM_ID,
  signal,
} from '@angular/core';
import { Meta, Title } from '@angular/platform-browser';
import { Router, RouterLink } from '@angular/router';

import { CartService } from '@storefront-services';
import type { Cart, CartLine } from '@storefront-types';

import { LocaleService } from '../../../locale.service';
import { AuthStateService } from '../../../services/auth-state.service';
import { WishlistStateService } from '../../../services/wishlist-state.service';
import { APP_ROUTES } from '../../../../lib/routes';
import { ButtonComponent } from '../../../ui/button.component';
import { SpinnerComponent } from '../../../ui/spinner.component';
import {
  CartLineComponent,
  type CartLineQtyChange,
} from '../../../sections/cart/cart-line.component';
import { CartTotalsComponent } from '../../../sections/cart/cart-totals.component';
import {
  CouponFormComponent,
  type AppliedCoupon,
} from '../../../sections/cart/coupon-form.component';
import {
  GiftCardFormComponent,
  type AppliedGiftCard,
} from '../../../sections/cart/gift-card-form.component';
import { pageTitle } from '../../../../lib/seo';

type PageState = 'loading' | 'ready' | 'error';

const MUTATION_ERROR_TIMEOUT_MS = 4000;

/**
 * S8 cart page. SSR-rendered shell + browser-side hydration of the cart.
 *
 * The cart fetch happens at hydration (not on the SSR server) so the SSR HTML
 * stays cookie-context-free per agent_docs/storefront/architecture.md. The
 * `<meta name="robots" content="noindex,nofollow">` keeps the page out of
 * search indices — cart is a per-session user surface, not canonical content.
 *
 * Cart mutations re-fetch the full cart from the API after every successful
 * call (CartService syncs the itemCount signal too) — no optimistic UI, so
 * combined-tender mutations (coupon + gift-card) stay consistent with the
 * server-side total per the S8 risk register (plan.md:367 + tasks.md S8.8).
 *
 * The save-for-later action gates to authenticated callers because the
 * underlying endpoint (`POST /v1/cart/items/:id/save-for-later`) carries
 * `@RequireAuth()` per `apps/api/src/modules/cart/cart.controller.ts:181`.
 * The page exposes that gate as a sign-in pill rather than dispatching a
 * 401-bound API call. S9 lands the auth flow; until then, anonymous users
 * see the gate copy with a `from=/cart` redirect link to `/auth/login`.
 */
@Component({
  selector: 'app-cart-page',
  standalone: true,
  imports: [
    ButtonComponent,
    CartLineComponent,
    CartTotalsComponent,
    CouponFormComponent,
    GiftCardFormComponent,
    RouterLink,
    SpinnerComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <header class="header">
        <h1 class="title">{{ strings().cart.page.title }}</h1>
      </header>

      @switch (state()) {
        @case ('loading') {
          <div class="loading" data-testid="cart-loading" role="status" aria-live="polite">
            <app-spinner size="md" />
            <span>{{ strings().cart.page.loading }}</span>
          </div>
        }
        @case ('error') {
          <div class="error" data-testid="cart-error" role="alert">
            <p>{{ strings().cart.page.loadError }}</p>
            <app-button
              variant="secondary"
              size="md"
              testId="cart-error-retry"
              (clicked)="reload()"
            >
              {{ strings().cart.page.retry }}
            </app-button>
          </div>
        }
        @case ('ready') {
          <!-- Outside the empty / non-empty branch: moving the last line
               empties the cart, and the confirmation has to survive that. -->
          @if (moveMessage()) {
            <p class="move-status" role="status" aria-live="polite" data-testid="cart-move-status">
              {{ moveMessage() }}
              <a class="move-link" [routerLink]="wishlistHref()">
                {{ strings().cart.page.movedToWishlistLink }}
              </a>
            </p>
          }
          @if (isEmpty()) {
            <div class="empty" data-testid="cart-empty">
              <h2 class="empty-title">{{ strings().cart.page.emptyTitle }}</h2>
              <p class="empty-body">{{ strings().cart.page.emptyBody }}</p>
              <a class="empty-cta" [routerLink]="homeHref()" data-testid="cart-empty-cta">
                {{ strings().cart.page.emptyCta }}
              </a>
            </div>
          } @else {
            <div class="grid">
              <section
                class="items"
                [attr.aria-label]="strings().cart.page.itemsRegionLabel"
                data-testid="cart-items"
              >
                @for (line of items(); track line.id) {
                  <cart-line
                    [line]="line"
                    [authed]="authed()"
                    [disabled]="pendingMutation()"
                    (qtyChange)="onQtyChange($event)"
                    (remove)="onRemove($event)"
                    (saveForLater)="onSaveForLater($event)"
                  />
                }

                @if (mutationError()) {
                  <p class="mutation-error" role="alert" data-testid="cart-mutation-error">
                    {{ mutationError() }}
                  </p>
                }

                @if (!authed()) {
                  <p class="auth-gate" data-testid="cart-save-auth-gate">
                    {{ strings().cart.page.saveForLaterAuthGate }}
                    <a
                      [routerLink]="loginPath()"
                      [queryParams]="loginQueryParams()"
                      class="auth-link"
                    >
                      {{ strings().cart.page.saveForLaterAuthCta }}
                    </a>
                  </p>
                }
              </section>

              <aside class="aside">
                <cart-coupon-form
                  [applied]="appliedCoupon()"
                  [pending]="pendingMutation()"
                  [error]="couponError()"
                  (apply)="onApplyCoupon($event)"
                  (remove)="onRemoveCoupon()"
                  (edited)="couponError.set(null)"
                />
                <cart-gift-card-form
                  [applied]="appliedGiftCard()"
                  [pending]="pendingMutation()"
                  [error]="giftCardError()"
                  (apply)="onApplyGiftCard($event)"
                  (remove)="onRemoveGiftCard()"
                  (edited)="giftCardError.set(null)"
                />
                <cart-totals [cart]="cart()!" [pending]="pendingMutation()" />
              </aside>
            </div>
          }
        }
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .page {
        display: flex;
        flex-direction: column;
        gap: 1.5rem;
        padding-block: 1.5rem;
        padding-inline: 1rem;
        max-inline-size: 1280px;
        margin-inline: auto;
      }
      .header {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
      }
      .title {
        margin: 0;
        font-family: var(
          --brand-font-display
        ); /* agent_docs/storefront/brand-tokens.md page title */
        font-size: clamp(var(--brand-text-display-mobile), 4vw, var(--brand-text-display));
        font-weight: 700;
        color: var(--brand-text);
      }
      .loading {
        display: inline-flex;
        gap: 0.5rem;
        align-items: center;
        color: var(--brand-text-muted);
        padding-block: 2rem;
      }
      .error {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
        padding-block: 2rem;
        align-items: start;
      }
      .empty {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
        align-items: start;
        padding-block: 2.5rem;
      }
      .empty-title {
        margin: 0;
        font-family: var(
          --brand-font-display
        ); /* agent_docs/storefront/brand-tokens.md section title */
        font-size: var(--brand-text-section);
        font-weight: 600;
        color: var(--brand-text);
      }
      .empty-body {
        margin: 0;
        font-size: var(--brand-text-body);
        color: var(--brand-text-muted);
      }
      .empty-cta {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-block-size: 44px;
        padding-block: 0.625rem;
        padding-inline: 1.25rem;
        background-color: var(--brand-primary);
        color: var(--brand-on-primary);
        border-radius: var(--brand-radius-md);
        text-decoration: none;
        font-weight: 600;
      }
      .empty-cta:focus-visible {
        outline: 2px solid var(--brand-text);
        outline-offset: 2px;
      }
      .grid {
        display: grid;
        gap: 1.25rem;
        grid-template-columns: 1fr;
      }
      @media (min-width: 960px) {
        .grid {
          grid-template-columns: minmax(0, 1fr) 360px;
          gap: 2rem;
        }
      }
      .items {
        display: flex;
        flex-direction: column;
      }
      .aside {
        display: flex;
        flex-direction: column;
        gap: 1rem;
      }
      .move-status {
        margin: 0;
        padding-block: 0.5rem;
        font-size: var(--brand-text-secondary);
        color: var(--brand-success-text);
      }
      .move-link {
        color: inherit;
        text-decoration: underline;
      }
      .mutation-error {
        margin: 0;
        margin-block-start: 0.75rem;
        padding-block: 0.625rem;
        padding-inline: 0.875rem;
        background-color: var(--brand-surface-strong);
        color: var(--brand-error);
        border-inline-start: 3px solid var(--brand-error);
        border-radius: var(--brand-radius-sm);
        font-size: var(--brand-text-micro);
      }
      .auth-gate {
        margin: 0;
        margin-block-start: 1rem;
        padding-block: 0.625rem;
        padding-inline: 0.875rem;
        background-color: var(--brand-surface-strong);
        color: var(--brand-text-muted);
        font-size: var(--brand-text-micro);
        border-radius: var(--brand-radius-sm);
      }
      .auth-link {
        color: var(--brand-primary);
        text-decoration: underline;
        margin-inline-start: 0.25rem;
      }
    `,
  ],
})
export class CartPageComponent implements OnInit {
  private readonly localeService = inject(LocaleService);
  private readonly cartSvc = inject(CartService);
  private readonly authState = inject(AuthStateService);
  private readonly router = inject(Router);
  private readonly title = inject(Title);
  private readonly meta = inject(Meta);
  private readonly platformId = inject(PLATFORM_ID);
  private readonly wishlistState = inject(WishlistStateService);

  protected readonly state = signal<PageState>('loading');
  protected readonly cart = signal<Cart | null>(null);
  protected readonly pendingMutation = signal<boolean>(false);
  protected readonly couponError = signal<string | null>(null);
  protected readonly giftCardError = signal<string | null>(null);
  protected readonly mutationError = signal<string | null>(null);
  protected readonly moveMessage = signal<string | null>(null);
  protected readonly authed = this.authState.isAuthed;

  protected readonly strings = this.localeService.strings;

  protected readonly items = (): CartLine[] => this.cart()?.items ?? [];
  protected readonly isEmpty = (): boolean => (this.cart()?.items?.length ?? 0) === 0;

  protected readonly appliedCoupon = (): AppliedCoupon | null => {
    // The backend emits couponCode (string) + discounts[] with type:'coupon'
    // rather than a nested coupon: { code, discount } object. Derive the
    // applied coupon from couponCode + the matching coupon discount line.
    // storefront-api-reference.md §Cart — CartResponse shape.
    const cart = this.cart();
    if (!cart) return null;
    const couponCode = cart.couponCode;
    if (!couponCode) return null;
    const couponLine = cart.discounts?.find((d) => d.type === 'coupon');
    return {
      code: couponCode,
      discount: couponLine ? Number(couponLine.amount) : 0,
    };
  };
  protected readonly appliedGiftCard = (): AppliedGiftCard | null => {
    const g = this.cart()?.giftCard;
    return g ? { code: g.code, balanceApplied: g.balanceApplied } : null;
  };

  protected readonly homeHref = (): string => APP_ROUTES.home(this.localeService.locale());
  protected readonly wishlistHref = (): string =>
    APP_ROUTES.account.wishlist(this.localeService.locale());
  // Bug 2 fix — `[routerLink]` directive treats its bound value as a path
  // segment and percent-encodes `?` / `=`, producing
  // `/en/auth/login%3Ffrom%3D%252Fen%252Fcart` (404). Split path from query so
  // Angular's URL serializer encodes each part with the correct rules.
  protected readonly loginPath = (): string => APP_ROUTES.auth.login(this.localeService.locale());
  protected readonly loginQueryParams = (): { from: string } => ({
    from: APP_ROUTES.cart(this.localeService.locale()),
  });

  ngOnInit(): void {
    this.title.setTitle(pageTitle(this.strings().cart.page.title, this.strings().brand.name));
    this.meta.updateTag({ name: 'robots', content: 'noindex,nofollow' });

    if (isPlatformBrowser(this.platformId)) {
      void this.loadCart();
    }
  }

  protected reload(): void {
    void this.loadCart();
  }

  protected async loadCart(): Promise<void> {
    this.state.set('loading');
    try {
      const c = await this.cartSvc.get();
      this.cart.set(c);
      this.state.set('ready');
    } catch {
      this.state.set('error');
    }
  }

  protected async onQtyChange(change: CartLineQtyChange): Promise<void> {
    await this.runMutation(() =>
      this.cartSvc.updateItem(change.itemId, { quantity: change.quantity }),
    );
  }

  protected async onRemove(itemId: string): Promise<void> {
    await this.runMutation(() => this.cartSvc.removeItem(itemId));
  }

  /**
   * Move the line into the wishlist. The endpoint keeps its `save-for-later`
   * path, but that is all it has ever done: add the product to the wishlist
   * and delete the cart item. There is no saved-for-later pool on the cart.
   */
  protected async onSaveForLater(itemId: string): Promise<void> {
    if (!this.authed()) {
      void this.router.navigate([this.loginPath()], { queryParams: this.loginQueryParams() });
      return;
    }
    this.moveMessage.set(null);
    const before = this.items().length;
    await this.runMutation(() => this.cartSvc.saveForLater(itemId));
    if (this.mutationError() || this.items().length >= before) return;
    this.moveMessage.set(this.strings().cart.page.movedToWishlist);
    // The cart line carries no productId on the wire, so re-read membership
    // rather than guessing which product just became wishlisted.
    void this.wishlistState.hydrate();
  }

  protected async onApplyCoupon(code: string): Promise<void> {
    this.couponError.set(null);
    this.pendingMutation.set(true);
    try {
      const c = await this.cartSvc.applyCoupon({ code });
      this.cart.set(c);
    } catch (err: unknown) {
      this.couponError.set(this.couponErrorMessageFor(err));
    } finally {
      this.pendingMutation.set(false);
    }
  }

  /**
   * Map a coupon-apply failure to a localized message. Backend collapses all
   * four reasons (not-found, expired, usage-exceeded, exclusive-collision)
   * to a single `COUPON_INVALID` code by §8.1 API6 anti-enumeration design —
   * the user-visible copy stays flat regardless of reason. The dispatch is
   * structurally code-aware so the contract is honored even when both branches
   * resolve to the same string. See
   * `specs/features/full-stack-audit-2026-05-14/plan.md` §1.1 row #16.
   */
  private couponErrorMessageFor(err: unknown): string {
    const code =
      err !== null && typeof err === 'object' && 'code' in err
        ? String((err as { code: string }).code)
        : null;
    if (code === 'COUPON_INVALID') return this.strings().cart.page.couponInvalid;
    return this.strings().cart.page.couponInvalid;
  }

  protected async onRemoveCoupon(): Promise<void> {
    this.couponError.set(null);
    await this.runMutation(() => this.cartSvc.removeCoupon());
  }

  protected async onApplyGiftCard(code: string): Promise<void> {
    this.giftCardError.set(null);
    this.pendingMutation.set(true);
    try {
      const c = await this.cartSvc.applyGiftCard({ code });
      this.cart.set(c);
    } catch (err: unknown) {
      this.giftCardError.set(this.giftCardErrorMessageFor(err));
    } finally {
      this.pendingMutation.set(false);
    }
  }

  /**
   * Map a gift-card-apply failure to a localized message. Backend collapses
   * all three reasons (not-found, soft-deleted-or-inactive, expired) to a
   * single `GIFT_CARD_INVALID` code by §8.1 API6 anti-enumeration design —
   * the user-visible copy stays flat regardless of reason. The dispatch is
   * structurally code-aware so the contract is honored even when both branches
   * resolve to the same string. See
   * `specs/features/full-stack-audit-2026-05-14/plan.md` §1.1 row #17.
   */
  private giftCardErrorMessageFor(err: unknown): string {
    const code =
      err !== null && typeof err === 'object' && 'code' in err
        ? String((err as { code: string }).code)
        : null;
    if (code === 'GIFT_CARD_INVALID') return this.strings().cart.page.giftCardInvalid;
    return this.strings().cart.page.giftCardInvalid;
  }

  protected async onRemoveGiftCard(): Promise<void> {
    this.giftCardError.set(null);
    this.pendingMutation.set(true);
    try {
      await this.cartSvc.removeGiftCard();
      const c = await this.cartSvc.get();
      this.cart.set(c);
    } catch (err) {
      this.surfaceMutationError(err);
    } finally {
      this.pendingMutation.set(false);
    }
  }

  private async runMutation(call: () => Promise<Cart>): Promise<void> {
    this.mutationError.set(null);
    this.pendingMutation.set(true);
    try {
      const c = await call();
      this.cart.set(c);
    } catch (err) {
      this.surfaceMutationError(err);
    } finally {
      this.pendingMutation.set(false);
    }
  }

  private surfaceMutationError(err: unknown): void {
    // Declared error code (`CART_INSUFFICIENT_STOCK` from
    // `apps/api/src/modules/cart/cart-insufficient-stock.exception.ts`) gets
    // a dedicated localized string in both FR + EN. Other typed errors and
    // network failures fall back to the generic mutation copy. See
    // `specs/features/full-stack-audit-2026-05-14/plan.md` §1.1 row #5.
    const code =
      err !== null && typeof err === 'object' && 'code' in err
        ? String((err as { code: string }).code)
        : null;
    const strings = this.strings().cart.page;
    const msg =
      code === 'CART_INSUFFICIENT_STOCK' ? strings.mutationOutOfStock : strings.mutationError;
    this.mutationError.set(msg);
    if (typeof setTimeout === 'function') {
      setTimeout(() => this.mutationError.set(null), MUTATION_ERROR_TIMEOUT_MS);
    }
  }
}

export default CartPageComponent;
