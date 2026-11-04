import { Dialog, DialogRef, DIALOG_DATA } from '@angular/cdk/dialog';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Inject,
  Optional,
  ViewChild,
  computed,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { NavItem } from '../sidebar/sidebar.component';

export interface CommandPaletteData {
  items: NavItem[];
  emptyLabel?: string;
  placeholder?: string;
}

export interface CommandPaletteResult {
  item: NavItem;
}

/**
 * Cmd+K global search / route-picker overlay. Filters a list of NavItem
 * entries by label; the component is generic, and callers wire it to a
 * richer data source (e.g. GET /v1/admin/search) when needed.
 */
@Component({
  selector: 'app-command-palette',
  standalone: true,
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="w-full max-w-xl mx-auto bg-surface border border-line">
      <input
        #searchInput
        type="text"
        [placeholder]="data.placeholder ?? 'Jump to…'"
        class="w-full h-14 px-4 bg-surface text-ink tabular text-sm border-b border-line placeholder:text-ink-muted focus-visible:outline-2 focus-visible:outline-ink focus-visible:-outline-offset-2"
        [ngModel]="query()"
        (ngModelChange)="onQuery($event)"
        (keydown.arrowDown)="move(1, $event)"
        (keydown.arrowUp)="move(-1, $event)"
        (keydown.enter)="commit($event)"
        data-testid="palette-input"
      />
      @if (filtered().length === 0) {
        <p class="px-4 py-6 text-ink-muted tabular text-sm">
          {{ data.emptyLabel ?? 'No matches.' }}
        </p>
      } @else {
        <ul
          role="listbox"
          aria-label="Search results"
          class="max-h-80 overflow-y-auto py-2"
          data-testid="palette-list"
        >
          @for (item of filtered(); track item.to; let i = $index) {
            <li
              role="option"
              [attr.aria-selected]="i === activeIndex() ? 'true' : 'false'"
              class="px-4 py-2 flex items-center justify-between tabular text-sm cursor-pointer"
              [class.bg-surface-elevated]="i === activeIndex()"
              [class.text-ink-emphasis]="i === activeIndex()"
              (mouseenter)="activeIndex.set(i)"
              (click)="select(item)"
            >
              <span>{{ item.label }}</span>
              <span class="text-ink-muted text-xs">{{ item.to }}</span>
            </li>
          }
        </ul>
      }
    </div>
  `,
})
export class CommandPaletteComponent {
  @ViewChild('searchInput') searchInput?: ElementRef<HTMLInputElement>;

  protected readonly query = signal('');
  protected readonly activeIndex = signal(0);

  protected readonly filtered = computed<NavItem[]>(() => {
    const q = this.query().trim().toLowerCase();
    if (!q) return this.data.items;
    return this.data.items.filter(
      (i) => i.label.toLowerCase().includes(q) || i.to.toLowerCase().includes(q),
    );
  });

  constructor(
    private readonly ref: DialogRef<CommandPaletteResult>,
    @Optional() @Inject(DIALOG_DATA) public readonly data: CommandPaletteData,
  ) {}

  protected onQuery(value: string): void {
    this.query.set(value);
    this.activeIndex.set(0);
  }

  protected move(delta: number, event: Event): void {
    event.preventDefault();
    const list = this.filtered();
    if (list.length === 0) return;
    const next = (this.activeIndex() + delta + list.length) % list.length;
    this.activeIndex.set(next);
  }

  protected commit(event: Event): void {
    event.preventDefault();
    const list = this.filtered();
    const item = list[this.activeIndex()];
    if (item) this.select(item);
  }

  protected select(item: NavItem): void {
    this.ref.close({ item });
  }
}

/** Helper to open the command palette and navigate on selection. */
export function openCommandPalette(
  dialog: Dialog,
  data: CommandPaletteData,
): Promise<CommandPaletteResult | undefined> {
  const ref = dialog.open<CommandPaletteResult>(CommandPaletteComponent, {
    data,
    role: 'dialog',
    ariaModal: true,
    ariaLabel: 'Command palette',
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
