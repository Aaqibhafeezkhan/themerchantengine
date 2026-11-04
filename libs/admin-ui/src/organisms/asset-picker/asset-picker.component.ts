import { CommonModule } from '@angular/common';
import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import {
  AfterViewInit,
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
import { RouterLink } from '@angular/router';
import {
  AssetsService,
  type Asset,
  type AssetStatus,
  type AssetType,
  type AssetUploadEvent,
  type ListAssetsQuery,
} from '@admin-services';
import { Subject, Subscription, takeUntil } from 'rxjs';
import { ButtonComponent } from '../../atoms/button/button.component';
import { BadgeComponent } from '../../atoms/badge/badge.component';
import { DropzoneComponent, type DropzoneFileRejection } from '../dropzone/dropzone.component';
import { ASSET_PICKER_PERMISSIONS } from './asset-picker.token';
import { TRANSLATABLE_LOCALES } from '../../atoms/translatable-locales.token';
import { pickTranslation, type Translatable } from '@admin-types';

/**
 * Filter-derived MIME `accept` for the Upload-tab dropzone (spec §4.B3).
 * Mirrors the backend allowlist at `apps/api/src/modules/assets/assets.constants.ts:10`
 * (`ALLOWED_MIME_TYPES`). The picker test asserts parity against the six
 * expected MIMEs so a server-side allowlist change fails the build until
 * this constant is updated. `DOCUMENT` and `AUDIO` fall back to the full
 * allowlist since the backend exposes no document or audio MIMEs today;
 * the dropzone's MIME gate would reject anything else regardless.
 */
const FULL_ACCEPT = 'image/jpeg,image/png,image/webp,image/avif,video/mp4,video/webm';
export const ACCEPT_BY_TYPE: Readonly<Record<AssetType, string>> = {
  IMAGE: 'image/jpeg,image/png,image/webp,image/avif',
  VIDEO: 'video/mp4,video/webm',
  DOCUMENT: FULL_ACCEPT,
  AUDIO: FULL_ACCEPT,
};
export const ACCEPT_FALLBACK = FULL_ACCEPT;

const POLL_INTERVAL_MS = 1_000;
const POLL_CAP_MS = 30_000;

export type PickerUploadStatus =
  | 'UPLOADING'
  | 'PROCESSING'
  | 'READY'
  | 'STILL_PROCESSING'
  | 'FAILED';

export interface PickerUploadTile {
  tempId: string;
  file: File;
  progress: number;
  status: PickerUploadStatus;
  assetId?: string;
  asset?: Asset;
  error?: string;
}

/**
 * Picker public types. Defined in this file (not a separate types module)
 * so the constructor parameter annotation `data: AssetPickerOptions`
 * resolves to a same-file symbol — mirrors the `ConfirmDialog` pattern in
 * `dialog.component.ts` and avoids the JIT metadata-emit edge case where
 * a cross-file type-only import becomes `undefined` at runtime.
 */
export interface AssetPickerFilter {
  readonly type?: AssetType;
  readonly status?: AssetStatus;
}

export interface AssetPickerOptions {
  readonly mode: 'single' | 'multi';
  readonly title?: string;
  readonly filter?: AssetPickerFilter;
  readonly selectedIds?: readonly string[];
  readonly titleId?: string;
}

export type AssetPickerResult =
  | { kind: 'cancel' }
  | { kind: 'select-single'; asset: Asset }
  | { kind: 'select-multi'; assets: readonly Asset[] };

/**
 * Brand-styled asset-picker dialog built on @angular/cdk/dialog. CDK
 * provides focus trap + backdrop + Esc-to-close out of the box; we layer
 * brutalist styling, a search-and-filter row, a keyboard-navigable asset
 * grid, and single / multi select state on top.
 *
 * Constitution §3.1: no Prisma. The dialog injects `AssetsService` for data.
 * Constitution §3.9: the mode's surface, its ink, its emphasis ink for
 * emphasis, zero border-radius, three weights max (400 / 500 / 700).
 * Constitution §3.10: focus trap (CDK), Esc-to-close, arrow-key + Enter
 * navigation, axe-clean, ≥ 44 × 44 px tab targets on mobile.
 */

const PAGE_SIZE = 24;

const TYPE_OPTIONS: ReadonlyArray<{ value: AssetType | null; label: string }> = [
  { value: null, label: 'All' },
  { value: 'IMAGE', label: 'Images' },
  { value: 'VIDEO', label: 'Videos' },
  { value: 'DOCUMENT', label: 'Docs' },
  { value: 'AUDIO', label: 'Audio' },
];

const STATUS_OPTIONS: ReadonlyArray<{ value: AssetStatus | null; label: string }> = [
  { value: null, label: 'Any' },
  { value: 'READY', label: 'Ready' },
  { value: 'PROCESSING', label: 'Processing' },
  { value: 'PENDING', label: 'Pending' },
  { value: 'FAILED', label: 'Failed' },
];

let assetPickerComponentCounter = 0;

@Component({
  selector: 'app-asset-picker',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    RouterLink,
    ButtonComponent,
    BadgeComponent,
    DropzoneComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="w-full max-w-5xl bg-surface border border-line flex flex-col max-h-[85vh]"
      data-testid="asset-picker"
    >
      <header class="px-6 py-5 border-b border-line flex items-start justify-between gap-4">
        <div>
          <h2 [id]="titleId" class="text-xl md:text-2xl font-bold tracking-tight text-ink">
            {{ data.title ?? defaultTitle() }}
          </h2>
          <p class="mt-1 text-xs tracking-widest uppercase text-ink-muted">
            {{ data.mode === 'multi' ? 'Multi-select' : 'Single-select' }}
          </p>
        </div>
        <button
          type="button"
          class="text-xs tracking-widest uppercase text-ink-muted px-3 py-2 min-h-11 min-w-11 border border-transparent hover:text-ink focus-visible:outline-2 focus-visible:outline-ink focus-visible:outline-offset-2"
          (click)="cancel()"
          aria-label="Close picker"
          data-testid="asset-picker-close"
        >
          Close
        </button>
      </header>

      @if (canUpload()) {
        <div
          role="tablist"
          aria-label="Picker mode"
          class="px-6 pt-4 flex items-center gap-2 border-b border-line"
          data-testid="asset-picker-tablist"
          (keydown)="onTablistKeydown($event)"
        >
          <button
            #browseTab
            type="button"
            role="tab"
            [id]="browseTabId"
            [attr.aria-selected]="activeTab() === 'browse'"
            [attr.aria-controls]="browsePanelId"
            [tabindex]="activeTab() === 'browse' ? 0 : -1"
            class="text-xs tracking-widest uppercase px-3 py-2 min-h-11 border-b-2 mb-[-2px] focus-visible:outline-2 focus-visible:outline-ink focus-visible:outline-offset-2"
            [class.border-ink]="activeTab() === 'browse'"
            [class.text-ink]="activeTab() === 'browse'"
            [class.border-transparent]="activeTab() !== 'browse'"
            [class.text-ink-muted]="activeTab() !== 'browse'"
            (click)="setActiveTab('browse')"
            data-testid="asset-picker-tab-browse"
          >
            Browse
          </button>
          <button
            #uploadTab
            type="button"
            role="tab"
            [id]="uploadTabId"
            [attr.aria-selected]="activeTab() === 'upload'"
            [attr.aria-controls]="uploadPanelId"
            [tabindex]="activeTab() === 'upload' ? 0 : -1"
            class="text-xs tracking-widest uppercase px-3 py-2 min-h-11 border-b-2 mb-[-2px] focus-visible:outline-2 focus-visible:outline-ink focus-visible:outline-offset-2"
            [class.border-ink]="activeTab() === 'upload'"
            [class.text-ink]="activeTab() === 'upload'"
            [class.border-transparent]="activeTab() !== 'upload'"
            [class.text-ink-muted]="activeTab() !== 'upload'"
            (click)="setActiveTab('upload')"
            data-testid="asset-picker-tab-upload"
          >
            Upload
          </button>
        </div>
      }

      <div
        [attr.role]="canUpload() ? 'tabpanel' : null"
        [id]="browsePanelId"
        [attr.aria-labelledby]="canUpload() ? browseTabId : null"
        [hidden]="canUpload() && activeTab() !== 'browse'"
        [class.flex]="!canUpload() || activeTab() === 'browse'"
        class="flex-col flex-1 min-h-0"
        data-testid="asset-picker-browse-panel"
      >
        <div class="px-6 py-4 border-b border-line flex flex-col gap-3">
          <div role="search" aria-label="Search assets">
            <input
              #searchInput
              type="search"
              [(ngModel)]="searchValue"
              (ngModelChange)="onSearch($event)"
              placeholder="Search by id or alt text"
              class="w-full h-11 px-3 bg-surface text-ink text-sm border border-line placeholder:text-ink-muted focus-visible:outline-2 focus-visible:outline-ink focus-visible:-outline-offset-2"
              aria-label="Search assets"
              data-testid="asset-picker-search"
            />
          </div>

          <div class="flex items-center gap-2 flex-wrap" role="group" aria-label="Filter by type">
            @for (opt of typeOptions; track opt.value) {
              <button
                type="button"
                class="text-xs tracking-widest uppercase px-3 py-2 min-h-11 border focus-visible:outline-2 focus-visible:outline-ink focus-visible:outline-offset-2"
                [class.border-ink]="typeFilter() === opt.value"
                [class.text-ink]="typeFilter() === opt.value"
                [class.border-line]="typeFilter() !== opt.value"
                [class.text-ink-muted]="typeFilter() !== opt.value"
                [attr.aria-pressed]="typeFilter() === opt.value"
                [attr.data-testid]="'asset-picker-type-' + (opt.value ?? 'all')"
                (click)="setType(opt.value)"
              >
                {{ opt.label }}
              </button>
            }
          </div>

          <div class="flex items-center gap-2 flex-wrap" role="group" aria-label="Filter by status">
            @for (opt of statusOptions; track opt.value) {
              <button
                type="button"
                class="text-xs tracking-widest uppercase px-3 py-2 min-h-11 border focus-visible:outline-2 focus-visible:outline-ink focus-visible:outline-offset-2"
                [class.border-ink]="statusFilter() === opt.value"
                [class.text-ink]="statusFilter() === opt.value"
                [class.border-line]="statusFilter() !== opt.value"
                [class.text-ink-muted]="statusFilter() !== opt.value"
                [attr.aria-pressed]="statusFilter() === opt.value"
                [attr.data-testid]="'asset-picker-status-' + (opt.value ?? 'any')"
                (click)="setStatus(opt.value)"
              >
                {{ opt.label }}
              </button>
            }
          </div>
        </div>

        <div class="flex-1 overflow-y-auto px-6 py-4" [attr.aria-busy]="loading()">
          <p class="sr-only" role="status" aria-live="polite" data-testid="asset-picker-status">
            {{ statusLine() }}
          </p>
          @if (loading()) {
            <p
              class="text-sm text-ink-muted text-center py-12"
              data-testid="asset-picker-loading"
              aria-hidden="true"
            >
              Loading assets…
            </p>
          } @else if (error()) {
            <p
              class="border border-status-error text-ink p-3 text-xs"
              data-testid="asset-picker-error"
            >
              {{ error() }}
            </p>
          } @else if (visible().length === 0) {
            <p
              class="text-sm text-ink-muted text-center py-12"
              data-testid="asset-picker-empty"
              aria-hidden="true"
            >
              No assets match the current filters.
            </p>
          } @else {
            <div
              #grid
              role="listbox"
              [attr.aria-multiselectable]="data.mode === 'multi'"
              aria-label="Assets"
              [attr.aria-activedescendant]="activeOptionId()"
              class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3"
              data-testid="asset-picker-grid"
              (keydown)="onGridKeydown($event)"
            >
              @for (a of visible(); track a.id; let i = $index) {
                <button
                  type="button"
                  role="option"
                  [id]="optionId(a.id)"
                  [attr.aria-selected]="isSelected(a.id)"
                  [tabindex]="i === activeIndex() ? 0 : -1"
                  class="w-full text-start border bg-surface focus-visible:outline-2 focus-visible:outline-ink focus-visible:outline-offset-2"
                  [class.border-ink]="isSelected(a.id)"
                  [class.border-line]="!isSelected(a.id)"
                  [class.ring-1]="i === activeIndex()"
                  [class.ring-ink]="i === activeIndex()"
                  [attr.data-testid]="'asset-picker-card-' + a.id"
                  (click)="onPick(a, i)"
                  (focus)="activeIndex.set(i)"
                >
                  <div
                    class="aspect-square bg-surface-elevated overflow-hidden flex items-center justify-center"
                  >
                    @if (isImageAsset(a) && tileSrc(a); as src) {
                      <img [src]="src" alt="" class="w-full h-full object-cover" />
                    } @else {
                      <span class="text-xs tracking-widest uppercase text-ink-muted">
                        {{ a.type }}
                      </span>
                    }
                  </div>
                  <div class="px-3 py-2 flex items-center justify-between gap-2">
                    <span class="text-xs text-ink-muted truncate" [title]="a.id">
                      {{ altText(a) || a.id }}
                    </span>
                    @if (data.mode === 'multi' && isSelected(a.id)) {
                      <span
                        class="text-xs tracking-widest uppercase text-ink-emphasis"
                        aria-hidden="true"
                        >Selected</span
                      >
                    }
                  </div>
                </button>
              }
            </div>
          }
        </div>

        <footer
          class="px-6 py-4 border-t border-line flex items-center justify-between gap-4 flex-wrap"
        >
          <p class="text-xs text-ink-muted tabular-nums" data-testid="asset-picker-meta">
            @if (total() > 0) {
              Showing {{ visible().length }} of {{ total() }}
              @if (data.mode === 'multi') {
                · {{ selectedIds().size }} selected
              }
            } @else {
              &nbsp;
            }
          </p>
          <nav class="flex items-center gap-2" aria-label="Asset picker pagination">
            <app-button
              variant="secondary"
              size="sm"
              [disabled]="page() <= 1 || loading()"
              (clicked)="goToPage(page() - 1)"
              ariaLabel="Previous page"
              testId="asset-picker-prev"
            >
              Prev
            </app-button>
            <app-button
              variant="secondary"
              size="sm"
              [disabled]="page() >= totalPages() || loading()"
              (clicked)="goToPage(page() + 1)"
              ariaLabel="Next page"
              testId="asset-picker-next"
            >
              Next
            </app-button>
            @if (data.mode === 'multi') {
              <app-button
                variant="primary"
                size="sm"
                [disabled]="selectedIds().size === 0"
                (clicked)="commitMulti()"
                testId="asset-picker-confirm"
              >
                Select {{ selectedIds().size }}
              </app-button>
            }
          </nav>
        </footer>
      </div>

      @if (canUpload()) {
        <div
          role="tabpanel"
          [id]="uploadPanelId"
          [attr.aria-labelledby]="uploadTabId"
          [hidden]="activeTab() !== 'upload'"
          [class.flex]="activeTab() === 'upload'"
          class="flex-col flex-1 min-h-0"
          data-testid="asset-picker-upload-panel"
        >
          <p
            class="sr-only"
            role="status"
            aria-live="polite"
            data-testid="asset-picker-upload-status"
          >
            {{ uploadStatusLine() }}
          </p>

          <div class="px-6 py-4 flex flex-col gap-4">
            <app-dropzone
              [multiple]="data.mode === 'multi'"
              [accept]="acceptForFilter()"
              [busy]="hasInFlightUpload()"
              (filesAdded)="onUploadFilesAdded($event)"
              (filesRejected)="onUploadFilesRejected($event)"
              testId="asset-picker-dropzone"
            />

            @if (uploadTiles().length > 0) {
              <ul
                class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3"
                role="list"
                aria-label="Upload queue"
                [attr.aria-busy]="hasInFlightUpload() ? 'true' : null"
                data-testid="asset-picker-upload-queue"
              >
                @for (tile of uploadTiles(); track tile.tempId) {
                  <li
                    class="flex flex-col gap-2 border border-line p-3 bg-surface"
                    [attr.aria-busy]="
                      tile.status === 'UPLOADING' || tile.status === 'PROCESSING' ? 'true' : null
                    "
                    [attr.data-testid]="'asset-picker-upload-tile-' + tile.tempId"
                  >
                    <p
                      class="text-xs text-ink truncate"
                      [title]="tile.file.name"
                      [attr.data-testid]="'asset-picker-upload-name-' + tile.tempId"
                    >
                      {{ tile.file.name }}
                    </p>
                    <app-badge
                      [tone]="uploadTone(tile.status)"
                      [ariaLabel]="'Status: ' + uploadLabel(tile.status)"
                      [attr.data-testid]="'asset-picker-upload-status-' + tile.tempId"
                    >
                      {{ uploadLabel(tile.status) }}
                    </app-badge>

                    @if (tile.status === 'UPLOADING') {
                      <div
                        role="progressbar"
                        [attr.aria-valuenow]="tile.progress"
                        aria-valuemin="0"
                        aria-valuemax="100"
                        [attr.aria-label]="'Upload progress for ' + tile.file.name"
                        class="h-1 bg-surface-elevated overflow-hidden"
                        [attr.data-testid]="'asset-picker-upload-progress-' + tile.tempId"
                      >
                        <div
                          class="h-full bg-surface-emphasis"
                          [style.inline-size.%]="tile.progress"
                        ></div>
                      </div>
                    }

                    @if (tile.error) {
                      <p
                        class="text-xs text-ink"
                        [attr.data-testid]="'asset-picker-upload-error-' + tile.tempId"
                      >
                        {{ tile.error }}
                      </p>
                    }

                    <div class="flex items-center gap-2 flex-wrap">
                      @if (tile.status === 'FAILED') {
                        <app-button
                          variant="secondary"
                          size="sm"
                          [ariaLabel]="'Retry upload for ' + tile.file.name"
                          (clicked)="retryTile(tile.tempId)"
                          [testId]="'asset-picker-upload-retry-' + tile.tempId"
                        >
                          Retry
                        </app-button>
                      }
                      @if (tile.status === 'STILL_PROCESSING' && tile.assetId) {
                        <a
                          [routerLink]="['/assets', tile.assetId]"
                          class="text-xs tracking-widest uppercase px-3 py-2 min-h-11 inline-flex items-center border border-line hover:border-ink focus-visible:outline-2 focus-visible:outline-ink focus-visible:outline-offset-2 text-ink"
                          [attr.aria-label]="'View ' + tile.file.name + ' in library'"
                          [attr.data-testid]="'asset-picker-upload-view-' + tile.tempId"
                        >
                          View in library
                        </a>
                      }
                      <app-button
                        variant="secondary"
                        size="sm"
                        [ariaLabel]="'Dismiss ' + tile.file.name"
                        (clicked)="dismissTile(tile.tempId)"
                        [testId]="'asset-picker-upload-dismiss-' + tile.tempId"
                      >
                        Dismiss
                      </app-button>
                    </div>
                  </li>
                }
              </ul>
            }
          </div>
        </div>
      }
    </div>
  `,
})
export class AssetPickerComponent implements AfterViewInit, OnDestroy {
  @ViewChild('searchInput') searchInput?: ElementRef<HTMLInputElement>;
  @ViewChild('grid') grid?: ElementRef<HTMLElement>;
  @ViewChild('browseTab') browseTabRef?: ElementRef<HTMLButtonElement>;
  @ViewChild('uploadTab') uploadTabRef?: ElementRef<HTMLButtonElement>;

  readonly titleId: string;
  readonly idPrefix: string;
  readonly browseTabId: string;
  readonly uploadTabId: string;
  readonly browsePanelId: string;
  readonly uploadPanelId: string;
  readonly typeOptions = TYPE_OPTIONS;
  readonly statusOptions = STATUS_OPTIONS;
  /** ngModel binding for the search box. */
  searchValue = '';

  protected readonly query = signal('');
  protected readonly typeFilter = signal<AssetType | null>(null);
  protected readonly statusFilter = signal<AssetStatus | null>(null);
  protected readonly page = signal(1);
  protected readonly assets = signal<readonly Asset[]>([]);
  protected readonly total = signal(0);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly selectedIds = signal<ReadonlySet<string>>(new Set());
  protected readonly activeIndex = signal(0);
  protected readonly activeTab = signal<'browse' | 'upload'>('browse');
  protected readonly uploadTiles = signal<readonly PickerUploadTile[]>([]);

  protected readonly visible = computed<readonly Asset[]>(() => {
    const q = this.query().trim().toLowerCase();
    if (!q) return this.assets();
    return this.assets().filter(
      (a) => a.id.toLowerCase().includes(q) || this.altText(a).toLowerCase().includes(q),
    );
  });

  protected readonly totalPages = computed(() => Math.max(1, Math.ceil(this.total() / PAGE_SIZE)));

  protected readonly canUpload = computed(() => {
    const set = this.permissions?.();
    return set ? set.has('assets:create') : false;
  });

  protected readonly hasInFlightUpload = computed(() =>
    this.uploadTiles().some((t) => t.status === 'UPLOADING' || t.status === 'PROCESSING'),
  );

  protected readonly acceptForFilter = computed(() => {
    const t = this.data?.filter?.type;
    return t ? ACCEPT_BY_TYPE[t] : ACCEPT_FALLBACK;
  });

  private readonly assetsService = inject(AssetsService);
  private readonly permissions = inject(ASSET_PICKER_PERMISSIONS, { optional: true });
  private readonly localeTabs = inject(TRANSLATABLE_LOCALES);
  private readonly destroy$ = new Subject<void>();
  private searchDebounce: ReturnType<typeof setTimeout> | null = null;
  private nextTempIdSeq = 0;
  private readonly uploadSubs = new Map<string, Subscription>();
  private readonly pollSubs = new Map<string, Subscription>();
  private readonly pollTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pollDeadlines = new Map<string, number>();

  constructor(
    private readonly ref: DialogRef<AssetPickerResult>,
    @Optional() @Inject(DIALOG_DATA) public readonly data: AssetPickerOptions,
  ) {
    const instance = ++assetPickerComponentCounter;
    this.idPrefix = `asset-picker-${instance}`;
    this.titleId = data?.titleId ?? `${this.idPrefix}-title`;
    this.browseTabId = `${this.idPrefix}-tab-browse`;
    this.uploadTabId = `${this.idPrefix}-tab-upload`;
    this.browsePanelId = `${this.idPrefix}-panel-browse`;
    this.uploadPanelId = `${this.idPrefix}-panel-upload`;
    if (data?.filter?.type) this.typeFilter.set(data.filter.type);
    if (data?.filter?.status) this.statusFilter.set(data.filter.status);
    if (data?.mode === 'multi' && data.selectedIds) {
      this.selectedIds.set(new Set(data.selectedIds));
    }
    this.fetch();
  }

  ngAfterViewInit(): void {
    // Defer focus so CDK has finished mounting the dialog container.
    queueMicrotask(() => this.searchInput?.nativeElement.focus());
  }

  ngOnDestroy(): void {
    if (this.searchDebounce) clearTimeout(this.searchDebounce);
    this.destroy$.next();
    this.destroy$.complete();
    this.uploadSubs.forEach((s) => s.unsubscribe());
    this.uploadSubs.clear();
    this.pollSubs.forEach((s) => s.unsubscribe());
    this.pollSubs.clear();
    this.pollTimers.forEach((t) => clearTimeout(t));
    this.pollTimers.clear();
  }

  protected defaultTitle(): string {
    return this.data?.mode === 'multi' ? 'Select assets' : 'Select an asset';
  }

  protected isImageAsset(asset: Asset): boolean {
    return asset.type === 'IMAGE' || (asset.mimeType?.startsWith('image/') ?? false);
  }

  /**
   * AV3 — picker tile thumbnail URL via the canonical resolver shim. Returns
   * `null` for PROCESSING / PENDING / FAILED rows or rows whose `variants`
   * payload is missing — the template falls through to the type-label
   * `<span>` block in those cases. DR-06 second amendment 2026-05-01.
   */
  protected tileSrc(asset: Asset): string | null {
    return this.assetsService.tryPublicVariantUrl(asset, 'thumbnail')?.url ?? null;
  }

  protected altText(asset: Asset): string {
    // A design-system primitive cannot reach the operator's AuthStore, so alt
    // text resolves in the store's default locale, which is the first entry of
    // the same token that feeds every Translatable editor.
    const locale = this.localeTabs()[0]?.code ?? '';
    return pickTranslation(
      asset.alt as Translatable | string | null | undefined,
      locale,
      '',
      locale,
    );
  }

  protected isSelected(id: string): boolean {
    return this.selectedIds().has(id);
  }

  protected optionId(assetId: string): string {
    return `${this.idPrefix}-option-${assetId}`;
  }

  protected activeOptionId(): string | null {
    const list = this.visible();
    const target = list[this.activeIndex()];
    return target ? this.optionId(target.id) : null;
  }

  /**
   * Visually-hidden status string consumed by `aria-live`. Keeps screen-
   * reader announcements scoped to a short summary instead of the entire
   * grid container, avoiding the runaway-announcement trap when the
   * grid re-renders.
   */
  protected statusLine(): string {
    if (this.loading()) return 'Loading assets…';
    const err = this.error();
    if (err) return `Error loading assets: ${err}`;
    const total = this.total();
    if (total === 0) return 'No assets match the current filters.';
    const visibleCount = this.visible().length;
    return `Showing ${visibleCount} of ${total} assets.`;
  }

  /**
   * Client-side filter over the currently-loaded page — no server-side
   * search is wired (`ListAssetsQuery` does not expose a search key
   * today). Debounce keeps the `visible()` recompute off every keystroke.
   * S18/S19 consumers should drive narrowing through the type/status
   * filter buttons (which DO refetch) when a server-side cut is needed.
   */
  protected onSearch(value: string): void {
    if (this.searchDebounce) clearTimeout(this.searchDebounce);
    this.searchDebounce = setTimeout(() => {
      this.query.set(value);
      this.activeIndex.set(0);
    }, 120);
  }

  protected setType(value: AssetType | null): void {
    if (this.typeFilter() === value) return;
    this.typeFilter.set(value);
    this.page.set(1);
    this.activeIndex.set(0);
    this.fetch();
  }

  protected setStatus(value: AssetStatus | null): void {
    if (this.statusFilter() === value) return;
    this.statusFilter.set(value);
    this.page.set(1);
    this.activeIndex.set(0);
    this.fetch();
  }

  protected goToPage(next: number): void {
    if (next < 1 || next > this.totalPages()) return;
    this.page.set(next);
    this.activeIndex.set(0);
    this.fetch();
  }

  protected onPick(asset: Asset, index: number): void {
    this.activeIndex.set(index);
    if (this.data.mode === 'single') {
      this.ref.close({ kind: 'select-single', asset });
      return;
    }
    const next = new Set(this.selectedIds());
    if (next.has(asset.id)) next.delete(asset.id);
    else next.add(asset.id);
    this.selectedIds.set(next);
  }

  protected commitMulti(): void {
    const ids = this.selectedIds();
    if (ids.size === 0) return;
    const assets = this.assets().filter((a) => ids.has(a.id));
    this.ref.close({ kind: 'select-multi', assets });
  }

  protected cancel(): void {
    this.ref.close({ kind: 'cancel' });
  }

  protected onGridKeydown(event: KeyboardEvent): void {
    const list = this.visible();
    if (list.length === 0) return;
    const cols = this.gridColumns();
    let next = this.activeIndex();
    switch (event.key) {
      case 'ArrowRight':
        next = Math.min(list.length - 1, next + 1);
        break;
      case 'ArrowLeft':
        next = Math.max(0, next - 1);
        break;
      case 'ArrowDown':
        next = Math.min(list.length - 1, next + cols);
        break;
      case 'ArrowUp':
        next = Math.max(0, next - cols);
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = list.length - 1;
        break;
      case 'Enter':
      case ' ': {
        const target = list[this.activeIndex()];
        if (target) this.onPick(target, this.activeIndex());
        event.preventDefault();
        return;
      }
      default:
        return;
    }
    if (next !== this.activeIndex()) {
      event.preventDefault();
      this.activeIndex.set(next);
      // Move browser focus to the newly active card.
      queueMicrotask(() => {
        const cards =
          this.grid?.nativeElement.querySelectorAll<HTMLButtonElement>('button[role="option"]');
        cards?.[next]?.focus();
      });
    }
  }

  /** Reads the current grid column count from the rendered template (2 / 3 / 4 by viewport). */
  private gridColumns(): number {
    const el = this.grid?.nativeElement;
    if (!el) return 2;
    const computed = getComputedStyle(el).gridTemplateColumns;
    if (!computed) return 2;
    const cols = computed.split(' ').filter((c) => c.trim().length > 0).length;
    return Math.max(1, cols);
  }

  private fetch(): void {
    this.loading.set(true);
    this.error.set(null);
    const query: ListAssetsQuery = {
      page: this.page(),
      pageSize: PAGE_SIZE,
    };
    if (this.typeFilter()) query.type = this.typeFilter() as AssetType;
    if (this.statusFilter()) query.status = this.statusFilter() as AssetStatus;
    this.assetsService
      .list(query)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (res) => {
          this.assets.set(res.data);
          this.total.set(res.meta.total);
          this.loading.set(false);
          this.activeIndex.set(0);
        },
        error: (err: unknown) => {
          this.loading.set(false);
          this.error.set(this.formatError(err));
        },
      });
  }

  private formatError(err: unknown): string {
    if (err && typeof err === 'object' && 'message' in err) {
      const msg = (err as { message?: unknown }).message;
      if (typeof msg === 'string' && msg.length > 0) return msg;
    }
    return 'Could not load assets.';
  }

  // ── Tablist ────────────────────────────────────────────────────────────

  protected setActiveTab(tab: 'browse' | 'upload'): void {
    if (!this.canUpload() && tab === 'upload') return;
    if (this.activeTab() === tab) return;
    this.activeTab.set(tab);
    queueMicrotask(() => {
      const ref = tab === 'browse' ? this.browseTabRef : this.uploadTabRef;
      ref?.nativeElement.focus();
    });
  }

  protected onTablistKeydown(event: KeyboardEvent): void {
    if (!this.canUpload()) return;
    let next: 'browse' | 'upload' | null = null;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = this.activeTab() === 'browse' ? 'upload' : 'browse';
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        next = this.activeTab() === 'upload' ? 'browse' : 'upload';
        break;
      case 'Home':
        next = 'browse';
        break;
      case 'End':
        next = 'upload';
        break;
      default:
        return;
    }
    if (next && next !== this.activeTab()) {
      event.preventDefault();
      this.setActiveTab(next);
    }
  }

  // ── Upload flow ────────────────────────────────────────────────────────

  protected uploadStatusLine(): string {
    const tiles = this.uploadTiles();
    if (tiles.length === 0) return 'Upload tab. Drop files to add new assets.';
    const inFlight = tiles.filter(
      (t) => t.status === 'UPLOADING' || t.status === 'PROCESSING',
    ).length;
    const ready = tiles.filter((t) => t.status === 'READY').length;
    const failed = tiles.filter((t) => t.status === 'FAILED').length;
    const stillProcessing = tiles.filter((t) => t.status === 'STILL_PROCESSING').length;
    const parts: string[] = [];
    if (inFlight > 0) parts.push(`${inFlight} in progress`);
    if (ready > 0) parts.push(`${ready} ready`);
    if (stillProcessing > 0) parts.push(`${stillProcessing} still processing`);
    if (failed > 0) parts.push(`${failed} failed`);
    return parts.length === 0 ? 'Upload queue idle.' : `Upload queue: ${parts.join(', ')}.`;
  }

  protected uploadLabel(status: PickerUploadStatus): string {
    switch (status) {
      case 'UPLOADING':
        return 'Uploading';
      case 'PROCESSING':
        return 'Processing';
      case 'READY':
        return 'Ready';
      case 'STILL_PROCESSING':
        return 'Still processing';
      case 'FAILED':
        return 'Failed';
    }
  }

  protected uploadTone(status: PickerUploadStatus): 'success' | 'warning' | 'error' | 'info' {
    switch (status) {
      case 'READY':
        return 'success';
      case 'FAILED':
        return 'error';
      case 'STILL_PROCESSING':
        return 'warning';
      case 'PROCESSING':
      case 'UPLOADING':
        return 'info';
    }
  }

  protected onUploadFilesAdded(files: File[]): void {
    if (!this.canUpload() || files.length === 0) return;
    for (const file of files) {
      const tile = this.appendTile(file, 'UPLOADING');
      this.startUpload(tile.tempId);
    }
  }

  protected onUploadFilesRejected(rejections: DropzoneFileRejection[]): void {
    if (!this.canUpload() || rejections.length === 0) return;
    for (const rejection of rejections) {
      this.appendTile(rejection.file, 'FAILED', this.formatRejection(rejection));
    }
  }

  protected retryTile(tempId: string): void {
    const tile = this.findTile(tempId);
    if (!tile || tile.status !== 'FAILED') return;
    this.patchTile(tempId, {
      status: 'UPLOADING',
      progress: 0,
      error: undefined,
      assetId: undefined,
      asset: undefined,
    });
    this.startUpload(tempId);
  }

  protected dismissTile(tempId: string): void {
    const sub = this.uploadSubs.get(tempId);
    if (sub) {
      sub.unsubscribe();
      this.uploadSubs.delete(tempId);
    }
    const pollSub = this.pollSubs.get(tempId);
    if (pollSub) {
      pollSub.unsubscribe();
      this.pollSubs.delete(tempId);
    }
    const timer = this.pollTimers.get(tempId);
    if (timer) {
      clearTimeout(timer);
      this.pollTimers.delete(tempId);
    }
    this.pollDeadlines.delete(tempId);
    this.uploadTiles.update((tiles) => tiles.filter((t) => t.tempId !== tempId));
  }

  private appendTile(file: File, status: PickerUploadStatus, error?: string): PickerUploadTile {
    const tempId = `pt-${++this.nextTempIdSeq}`;
    const tile: PickerUploadTile = {
      tempId,
      file,
      progress: 0,
      status,
      ...(error ? { error } : {}),
    };
    this.uploadTiles.update((tiles) => [...tiles, tile]);
    return tile;
  }

  private patchTile(tempId: string, patch: Partial<PickerUploadTile>): void {
    this.uploadTiles.update((tiles) =>
      tiles.map((t) => (t.tempId === tempId ? { ...t, ...patch } : t)),
    );
  }

  private findTile(tempId: string): PickerUploadTile | null {
    return this.uploadTiles().find((t) => t.tempId === tempId) ?? null;
  }

  private startUpload(tempId: string): void {
    const tile = this.findTile(tempId);
    if (!tile) return;
    let assetRef: Asset | null = null;
    const sub = this.assetsService
      .uploadWithProgress(tile.file)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (event: AssetUploadEvent) => {
          if (event.kind === 'progress') {
            const ratio = event.progress.ratio ?? 0;
            this.patchTile(tempId, {
              progress: Math.max(0, Math.min(100, Math.round(ratio * 100))),
            });
            return;
          }
          assetRef = event.asset;
          this.patchTile(tempId, {
            status: 'PROCESSING',
            progress: 100,
            assetId: event.asset.id,
            asset: event.asset,
          });
          if (event.asset.status === 'READY') {
            this.markTileReady(tempId, event.asset);
          }
        },
        error: (err: unknown) => {
          this.uploadSubs.delete(tempId);
          this.patchTile(tempId, { status: 'FAILED', error: this.formatUploadError(err) });
        },
        complete: () => {
          this.uploadSubs.delete(tempId);
          if (assetRef) {
            const current = this.findTile(tempId);
            if (current && current.status === 'PROCESSING') {
              this.startPolling(tempId, assetRef.id);
            }
          }
        },
      });
    this.uploadSubs.set(tempId, sub);
  }

  private startPolling(tempId: string, assetId: string): void {
    this.pollDeadlines.set(tempId, Date.now() + POLL_CAP_MS);
    this.schedulePoll(tempId, assetId);
  }

  private schedulePoll(tempId: string, assetId: string): void {
    const timer = setTimeout(() => {
      this.pollTimers.delete(tempId);
      this.runPoll(tempId, assetId);
    }, POLL_INTERVAL_MS);
    this.pollTimers.set(tempId, timer);
  }

  private runPoll(tempId: string, assetId: string): void {
    const tile = this.findTile(tempId);
    if (!tile || tile.status !== 'PROCESSING') return;
    const deadline = this.pollDeadlines.get(tempId) ?? 0;
    if (Date.now() >= deadline) {
      this.patchTile(tempId, { status: 'STILL_PROCESSING' });
      this.pollDeadlines.delete(tempId);
      return;
    }
    const sub = this.assetsService
      .get(assetId)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (asset) => {
          this.pollSubs.delete(tempId);
          if (asset.status === 'READY') {
            this.markTileReady(tempId, asset);
            return;
          }
          if (asset.status === 'FAILED') {
            this.patchTile(tempId, { status: 'FAILED', error: 'Processing failed.' });
            this.pollDeadlines.delete(tempId);
            return;
          }
          this.schedulePoll(tempId, assetId);
        },
        error: (err: unknown) => {
          this.pollSubs.delete(tempId);
          this.patchTile(tempId, { status: 'FAILED', error: this.formatUploadError(err) });
          this.pollDeadlines.delete(tempId);
        },
      });
    this.pollSubs.set(tempId, sub);
  }

  private markTileReady(tempId: string, asset: Asset): void {
    this.patchTile(tempId, {
      status: 'READY',
      progress: 100,
      assetId: asset.id,
      asset,
    });
    this.pollDeadlines.delete(tempId);
    if (this.data.mode === 'single') {
      // Auto-resolve the picker on the first READY in single mode (spec §4.B5).
      this.ref.close({ kind: 'select-single', asset });
      return;
    }
    // Multi mode: append to selection, switch back to Browse, refetch list so
    // the new tile is grid-visible (spec §4.B5). Use `setActiveTab` so the
    // post-switch focus move fires — leaving focus inside the now-hidden
    // Upload panel would orphan it on the auto-switch path (a11y NIT-3).
    const next = new Set(this.selectedIds());
    next.add(asset.id);
    this.selectedIds.set(next);
    this.setActiveTab('browse');
    this.fetch();
  }

  private formatRejection(rejection: DropzoneFileRejection): string {
    if (rejection.reason === 'size') return 'File exceeds the 10 MB upload limit.';
    return 'File type is not allowed.';
  }

  private formatUploadError(err: unknown): string {
    if (err && typeof err === 'object' && 'message' in err) {
      const msg = (err as { message?: unknown }).message;
      if (typeof msg === 'string' && msg.length > 0) return msg;
    }
    return 'Upload failed.';
  }
}
