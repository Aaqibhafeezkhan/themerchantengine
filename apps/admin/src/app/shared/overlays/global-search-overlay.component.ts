import { Dialog, DialogRef, DIALOG_DATA } from '@angular/cdk/dialog';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Inject,
  OnDestroy,
  Optional,
  ViewChild,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { NavItem } from '@admin-ui';
import {
  GlobalSearchService,
  type GlobalSearchGroup,
  type GlobalSearchType,
} from '@admin-services';
import { Subject, of, timer } from 'rxjs';
import {
  catchError,
  debounce,
  distinctUntilChanged,
  switchMap,
  takeUntil,
  tap,
} from 'rxjs/operators';

export interface GlobalSearchOverlayData {
  /** Flattened NavItem list the user may also jump to (fallback when query is empty). */
  navItems: NavItem[];
  /** Minimum chars before we hit the backend. Local nav filter still runs. */
  minChars?: number;
}

export type GlobalSearchOverlayResult =
  | { kind: 'nav'; to: string }
  | { kind: 'hit'; url: string }
  | { kind: 'see-all'; q: string };

interface FlatRow {
  type: 'nav' | GlobalSearchType | 'see-all';
  label: string;
  sublabel?: string;
  go: GlobalSearchOverlayResult;
}

const TYPE_LABELS: Record<GlobalSearchType, string> = {
  product: 'Products',
  order: 'Orders',
  customer: 'Customers',
  cms: 'CMS pages',
};

/**
 * Cmd+K overlay combining nav jumps (local filter) with cross-entity search
 * (backend fan-out, debounced 200 ms). Enter commits the active row; a
 * "See all results for …" footer navigates to `/search?q=…` for the full page.
 */
@Component({
  selector: 'app-global-search-overlay',
  standalone: true,
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="w-full max-w-xl mx-auto bg-surface border border-line">
      <input
        #searchInput
        type="search"
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
        aria-label="Search products, orders, customers, pages, or jump to a section"
        [attr.aria-controls]="listId"
        [attr.aria-activedescendant]="activeDescendantId()"
        role="combobox"
        aria-expanded="true"
        aria-haspopup="listbox"
        placeholder="Search or jump to…"
        class="w-full h-14 px-4 bg-surface text-ink text-sm border-b border-line placeholder:text-ink-muted focus-visible:outline-2 focus-visible:outline-ink focus-visible:-outline-offset-2"
        [ngModel]="query()"
        (ngModelChange)="onQueryChange($event)"
        (keydown.arrowDown)="move(1, $event)"
        (keydown.arrowUp)="move(-1, $event)"
        (keydown.enter)="commit($event)"
        data-testid="palette-input"
      />

      <div class="px-4 py-2 text-xs text-ink-muted flex items-center justify-between">
        <span role="status" aria-live="polite" aria-atomic="true">
          @if (busy()) {
            Searching…
          } @else if (query().length > 0 && query().length < minChars()) {
            Type at least {{ minChars() }} characters.
          } @else {
            {{ flat().length }} {{ flat().length === 1 ? 'result' : 'results' }}
          }
        </span>
        <span class="font-mono">esc to close</span>
      </div>

      @if (error()) {
        <p role="alert" class="px-4 py-3 text-xs text-status-error">{{ error() }}</p>
      }

      @if (flat().length === 0 && !busy()) {
        <p class="px-4 py-6 text-ink-muted text-sm" data-testid="palette-empty">
          No matches for "{{ query() }}".
        </p>
      } @else {
        <ul
          [id]="listId"
          role="listbox"
          aria-label="Search results"
          class="max-h-96 overflow-y-auto py-2"
          data-testid="palette-list"
        >
          @for (section of sections(); track section.label) {
            @if (section.label) {
              <li role="presentation" class="px-4 pt-3 pb-1">
                <span class="text-xs tracking-widest uppercase text-ink-muted">
                  {{ section.label }}
                </span>
              </li>
            }
            @for (row of section.rows; track row.index) {
              <li
                role="option"
                [id]="optionId(row.index)"
                [attr.aria-selected]="row.index === activeIndex() ? 'true' : 'false'"
                class="px-4 py-2 flex items-center justify-between gap-4 text-sm cursor-pointer"
                [class.bg-surface-elevated]="row.index === activeIndex()"
                [class.text-ink-emphasis]="row.index === activeIndex()"
                (mouseenter)="activeIndex.set(row.index)"
                (click)="select(row.row)"
                [attr.data-testid]="'palette-row-' + row.index"
              >
                <span class="truncate">{{ row.row.label }}</span>
                @if (row.row.sublabel) {
                  <span class="text-ink-muted text-xs truncate max-w-[55%]">{{
                    row.row.sublabel
                  }}</span>
                }
              </li>
            }
          }
        </ul>
      }
    </div>
  `,
})
export class GlobalSearchOverlayComponent implements OnDestroy {
  @ViewChild('searchInput') searchInput?: ElementRef<HTMLInputElement>;

  private readonly service = inject(GlobalSearchService);
  private readonly destroy$ = new Subject<void>();
  private readonly query$ = new Subject<string>();

  protected readonly listId = `palette-${Math.random().toString(36).slice(2, 8)}`;

  protected readonly query = signal('');
  protected readonly activeIndex = signal(0);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly groups = signal<readonly GlobalSearchGroup[]>([]);

  protected readonly minChars = () => this.data?.minChars ?? 2;

  protected readonly flat = computed<FlatRow[]>(() => {
    const q = this.query().trim();
    const rows: FlatRow[] = [];

    // nav items: local substring filter (empty query → show all)
    const navItems = this.data?.navItems ?? [];
    const navFiltered = q
      ? navItems.filter(
          (i) =>
            i.label.toLowerCase().includes(q.toLowerCase()) ||
            i.to.toLowerCase().includes(q.toLowerCase()),
        )
      : navItems;
    for (const n of navFiltered) {
      rows.push({
        type: 'nav',
        label: n.label,
        sublabel: n.to,
        go: { kind: 'nav', to: n.to },
      });
    }

    // search hits
    for (const g of this.groups()) {
      for (const h of g.items) {
        rows.push({
          type: g.type,
          label: h.title,
          sublabel: h.subtitle ?? undefined,
          go: { kind: 'hit', url: h.url },
        });
      }
    }

    if (q.length >= this.minChars()) {
      rows.push({
        type: 'see-all',
        label: `See all results for "${q}"`,
        sublabel: '/search',
        go: { kind: 'see-all', q },
      });
    }

    return rows;
  });

  protected readonly sections = computed(() => {
    const rows = this.flat();
    const order: Array<FlatRow['type']> = ['nav', 'product', 'order', 'customer', 'cms', 'see-all'];
    const buckets = new Map<FlatRow['type'], { index: number; row: FlatRow }[]>();
    rows.forEach((row, idx) => {
      const bucket = buckets.get(row.type) ?? [];
      bucket.push({ index: idx, row });
      buckets.set(row.type, bucket);
    });
    return order
      .filter((t) => buckets.has(t))
      .map((t) => ({
        label: this.sectionLabel(t),
        rows: buckets.get(t)!,
      }));
  });

  protected readonly activeDescendantId = computed(() => {
    const i = this.activeIndex();
    return this.flat()[i] ? this.optionId(i) : null;
  });

  constructor(
    private readonly ref: DialogRef<GlobalSearchOverlayResult>,
    @Optional() @Inject(DIALOG_DATA) public readonly data: GlobalSearchOverlayData,
  ) {
    this.query$
      .pipe(
        takeUntil(this.destroy$),
        debounce((v) => (v.length >= this.minChars() ? timer(200) : timer(0))),
        distinctUntilChanged(),
        tap((v) => {
          if (v.length < this.minChars()) {
            this.groups.set([]);
            this.busy.set(false);
            this.error.set(null);
          } else {
            this.busy.set(true);
            this.error.set(null);
          }
        }),
        switchMap((v) => {
          if (v.length < this.minChars()) return of({ groups: [] as GlobalSearchGroup[] });
          return this.service.search({ q: v, limit: 5 }).pipe(
            catchError(() => {
              this.error.set('Search failed. Try again.');
              return of({ groups: [] as GlobalSearchGroup[] });
            }),
          );
        }),
      )
      .subscribe((res) => {
        this.groups.set(res.groups);
        this.busy.set(false);
        this.activeIndex.set(0);
      });
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  protected onQueryChange(value: string): void {
    this.query.set(value);
    this.activeIndex.set(0);
    this.query$.next(value);
  }

  protected move(delta: number, event: Event): void {
    event.preventDefault();
    const list = this.flat();
    if (list.length === 0) return;
    const next = (this.activeIndex() + delta + list.length) % list.length;
    this.activeIndex.set(next);
  }

  protected commit(event: Event): void {
    event.preventDefault();
    const row = this.flat()[this.activeIndex()];
    if (row) this.select(row);
  }

  protected select(row: FlatRow): void {
    this.ref.close(row.go);
  }

  protected optionId(index: number): string {
    return `${this.listId}-opt-${index}`;
  }

  private sectionLabel(t: FlatRow['type']): string {
    if (t === 'nav') return 'Jump to';
    if (t === 'see-all') return '';
    return TYPE_LABELS[t as GlobalSearchType];
  }
}

export function openGlobalSearchOverlay(
  dialog: Dialog,
  data: GlobalSearchOverlayData,
): Promise<GlobalSearchOverlayResult | undefined> {
  const ref = dialog.open<GlobalSearchOverlayResult>(GlobalSearchOverlayComponent, {
    data,
    ariaModal: true,
    ariaLabel: 'Global search',
    hasBackdrop: true,
    disableClose: false,
  });
  return new Promise((resolve) => {
    const sub = ref.closed.subscribe((value) => {
      resolve(value);
      setTimeout(() => sub.unsubscribe(), 0);
    });
  });
}
