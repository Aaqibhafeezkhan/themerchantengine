import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

/**
 * Presentational topbar. Mobile (below `md`): hamburger, wordmark, the theme
 * toggle (`topbarStart`) and the user slot (`topbarUser`), which carries the
 * account menu and sign-out. `md` and up: notifications joins in, sized to fit a 260 px sidebar plus this header in the
 * narrowest width that breakpoint promises (768 px, `agent_docs/admin/
 * responsive-rules.md`). The store identity chip and the search trigger are
 * both desktop conveniences rather than a distinct action, so they wait for
 * `lg` (1024 px): the identity chip is decorative (see below), and the search
 * trigger duplicates the always-live Cmd/Ctrl+K shortcut, so hiding its button
 * between `md` and `lg` drops no capability, only one discovery affordance,
 * for the width range that has no room to spare for it.
 *
 * The store's name and mark render here in `--ink-muted`, the colour of the
 * engine label they replace on desktop. The store's own palette never follows
 * them in: this is the admin, and constitution §3.9 keeps the admin on the
 * Badii Studio floor in both colour modes. The mobile wordmark is the engine's
 * identity and stays.
 *
 * The block has a fixed inline size and truncates. A visual baseline masks it,
 * and a mask paints the located element's bounding box, so a variable width
 * would couple every masked baseline to the store name of whichever scenario
 * fixture recorded it.
 *
 * Slots:
 *   <span topbarStart>...</span>   — visible at every width, mobile included
 *                                     (the theme toggle lives here)
 *   <span topbarEnd>...</span>     — desktop-only (md+), after search,
 *                                     before user menu (notifications lives here)
 *   <span topbarUser>...</span>    — visible at every width: the account menu
 *                                     and sign-out, which a phone must reach
 */
@Component({
  selector: 'app-topbar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header
      class="h-16 border-b border-line flex items-center gap-1 md:gap-6 px-3 md:px-8 bg-surface"
      data-testid="app-topbar"
    >
      <button
        type="button"
        class="md:hidden inline-flex items-center justify-center w-11 h-11 -ml-2 text-ink focus-visible:outline-2 focus-visible:outline-ink focus-visible:-outline-offset-2"
        [attr.aria-label]="'Open navigation'"
        [attr.aria-expanded]="mobileMenuOpen() ? 'true' : 'false'"
        (click)="menuToggled.emit()"
        data-testid="topbar-menu-button"
      >
        <span aria-hidden="true" class="flex flex-col gap-1.5">
          <span class="block w-5 h-px bg-surface-emphasis"></span>
          <span class="block w-5 h-px bg-surface-emphasis"></span>
          <span class="block w-5 h-px bg-surface-emphasis"></span>
        </span>
      </button>

      <span class="md:hidden flex items-center gap-2 text-ink">
        <span aria-hidden="true" class="inline-block w-2.5 h-2.5 bg-brand-mark shrink-0"></span>
        <span class="text-sm font-bold uppercase tracking-tight whitespace-nowrap"
          >The Merchant Engine</span
        >
      </span>
      <span
        class="hidden lg:flex w-56 shrink-0 items-center gap-2 overflow-hidden text-ink-muted text-xs tracking-widest uppercase"
        data-testid="topbar-store-identity"
      >
        @if (storeLogoUrl()) {
          <!--
            Decorative: the store's name sits right beside it, so a screen
            reader that announced the mark as well would say it twice.
          -->
          <img
            [src]="storeLogoUrl()"
            alt=""
            aria-hidden="true"
            class="h-5 w-auto max-w-24 object-contain"
            data-testid="topbar-store-logo"
          />
        }
        <span class="truncate" [title]="storeName()" data-testid="topbar-store-name"
          >{{ storeName() || 'merchants-engine' }} · admin</span
        >
      </span>

      <div class="flex-1"></div>

      <!--
        The one projected slot that is NOT desktop-only: shell-identity.journey.spec.ts
        pins the theme toggle visible at every width, mobile included, so it
        stays outside the md-gated wrapper below and app-shell.component.ts
        feeds it through this slot rather than topbarEnd.
      -->
      <ng-content select="[topbarStart]"></ng-content>

      <!--
        Everything in this wrapper is desktop-only per the class doc above
        ("Mobile: hamburger, wordmark, and the theme toggle"). 'hidden
        md:contents' keeps that below md: the wrapper and its children render
        nothing (and take no header width), and at md and up 'display:
        contents' lets each projected child participate directly in the
        header's own flex layout, so the gap-3/md:gap-6 spacing between them
        is unchanged. Without this wrapper the slotted content (search,
        notifications, account menu, sign-out) rendered unconditionally and
        overflowed a 360 px viewport: the header has no room for that many
        controls at once below md, and the mobile nav (hamburger) is this
        component's answer for navigation, not for these actions.
      -->
      <div class="hidden md:contents">
        <button
          type="button"
          class="hidden lg:inline-flex items-center gap-2 min-h-[44px] px-3 border border-line text-ink-muted hover:text-ink hover:border-ink focus-visible:outline-2 focus-visible:outline-ink focus-visible:outline-offset-2"
          (click)="searchRequested.emit()"
          data-testid="topbar-search"
        >
          <span class="text-sm">Search</span>
          <span class="text-xs tracking-widest uppercase border border-line px-1.5 py-0.5">
            {{ searchShortcut() }}
          </span>
        </button>

        <ng-content select="[topbarEnd]"></ng-content>
      </div>

      <!--
        Outside the wrapper on purpose. The topbarUser slot carries the account
        menu and sign-out, and an operator who cannot sign out on a phone has
        no way to end their session at all: the mobile drawer is navigation
        only, and nothing else in the shell offers it. Hiding it below md
        traded an overflow for a lost capability, which is the wrong trade. It
        is the controls that duplicate something else, the search trigger
        behind a live shortcut and the decorative identity chip, that give up
        their width instead.
      -->
      <ng-content select="[topbarUser]"></ng-content>
    </header>
  `,
})
export class TopbarComponent {
  readonly mobileMenuOpen = input<boolean>(false);
  /** The store's own name, already resolved to a string by the caller. */
  readonly storeName = input<string>('');
  /** A URL the browser can load, or null. Never an asset id. */
  readonly storeLogoUrl = input<string | null>(null);
  /** Displayed hint in the search button. Default uses Mac keyboard glyph. */
  readonly searchShortcut = input<string>('Ctrl K');

  readonly menuToggled = output<void>();
  readonly searchRequested = output<void>();
}
