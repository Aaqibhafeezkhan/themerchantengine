import {
  ChangeDetectionStrategy,
  Component,
  Injector,
  OnDestroy,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { RouterLink } from '@angular/router';
import {
  CDK_DROP_LIST,
  CdkDrag,
  CdkDragDrop,
  CdkDragHandle,
  CdkDropList,
  moveItemInArray,
} from '@angular/cdk/drag-drop';
import { BadgeComponent, ButtonComponent, SkeletonComponent } from '@admin-ui';
import { CategoriesService } from '@admin-services';
import { ApiError, ApiForbiddenError, ApiNotFoundError } from '@admin-types';
import { Subject, takeUntil } from 'rxjs';
import { AuthStore } from '../../core/stores/auth.store';
import { type CategoryNodeView, projectTree } from './categories.utils';
import { StoreSettingsStore } from '../../core/stores/store-settings.store';

/**
 * `/categories` — hierarchical category browser with sibling drag-reorder.
 *
 * Semantics: nested lists with disclosure buttons per row. We deliberately
 * do NOT claim `role="tree"` because we don't implement the APG tree
 * keyboard contract (roving tabindex + arrow nav) — tree role without
 * that contract actively mis-announces the widget to screen readers, so
 * plain lists + accessible disclosure buttons is the honest pattern.
 *
 * Expand/collapse is a local `expanded` Set keyed by node id; toggle
 * flips membership. A node renders its children only when expanded, so
 * the DOM is O(visible) rather than O(total).
 *
 * Drag-reorder uses CDK `cdkDropList` + `cdkDrag` on each sibling list
 * (root + each expanded parent's children). Each row exposes a dedicated
 * `cdkDragHandle` button with an `aria-label` + ArrowUp/ArrowDown keyboard
 * fallback so the surface stays WCAG 2.2 AA — CDK drag-drop is pointer-only
 * without the keyboard path. On drop or nudge the page optimistically
 * re-orders the local sibling list, PATCHes `/v1/admin/categories/reorder`,
 * and re-fetches the tree on 204; on error it rolls back to the pre-drop
 * order and surfaces the branded error banner.
 */
@Component({
  selector: 'app-categories-tree-page',
  standalone: true,
  imports: [
    NgTemplateOutlet,
    RouterLink,
    CdkDropList,
    CdkDrag,
    CdkDragHandle,
    BadgeComponent,
    ButtonComponent,
    SkeletonComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="p-6 md:p-10 flex flex-col gap-8" data-testid="categories-tree-page">
      <header class="flex items-end justify-between gap-6 flex-wrap">
        <div>
          <p class="text-xs tracking-widest uppercase text-ink-muted">Catalog</p>
          <h1 class="mt-2 text-4xl md:text-5xl font-bold tracking-tight">Categories</h1>
          <p class="mt-3 text-ink-muted text-sm max-w-xl">
            Organise products into a tree. Click a row to edit; use expand/collapse to navigate.
            @if (canReorder()) {
              Drag the handle or press ArrowUp / ArrowDown to reorder siblings.
            }
          </p>
        </div>
        @if (canManage()) {
          <app-button
            variant="primary"
            size="md"
            [routerLink]="['/categories/new']"
            data-testid="category-new"
          >
            New category
          </app-button>
        }
      </header>

      <div role="alert" aria-atomic="true" data-testid="categories-error">
        @if (error()) {
          <p class="border border-status-error text-ink p-3 text-xs">
            {{ error() }}
          </p>
        }
      </div>

      <div
        class="border border-line bg-surface"
        role="status"
        aria-label="Category tree"
        [attr.aria-busy]="loading() ? 'true' : null"
      >
        @if (loading()) {
          <div class="p-5 flex flex-col gap-3">
            <app-skeleton height="1rem" width="60%" />
            <app-skeleton height="1rem" width="50%" />
            <app-skeleton height="1rem" width="70%" />
            <app-skeleton height="1rem" width="40%" />
          </div>
        } @else if (tree().length === 0) {
          <p class="px-5 py-16 text-center text-ink-muted text-sm">
            No categories yet.
            @if (canManage()) {
              <a
                routerLink="/categories/new"
                class="ml-1 text-ink underline focus-visible:outline-2 focus-visible:outline-ink focus-visible:outline-offset-2"
              >
                Create the first one.
              </a>
            }
          </p>
        } @else {
          <ul
            cdkDropList
            #rootList="cdkDropList"
            [cdkDropListData]="tree()"
            [cdkDropListDisabled]="!canReorder() || reordering()"
            (cdkDropListDropped)="drop($event, null)"
            aria-label="Category hierarchy"
            class="divide-y divide-line"
            data-testid="categories-tree"
          >
            @for (node of tree(); track node.id) {
              <ng-container
                *ngTemplateOutlet="
                  rowTemplate;
                  context: { $implicit: node, parentId: null };
                  injector: dropListInjector(rootList)
                "
              ></ng-container>
            }
          </ul>
        }
      </div>
    </section>

    <ng-template #rowTemplate let-node let-parentId="parentId">
      <li
        cdkDrag
        [cdkDragDisabled]="!canReorder() || reordering()"
        [attr.data-testid]="'category-row-' + node.id"
      >
        <div
          class="flex items-center gap-3 px-4 py-3 hover:bg-surface-elevated focus-within:bg-surface-elevated"
          [style.paddingLeft.rem]="1 + node.depth * 1.5"
        >
          @if (canReorder()) {
            <button
              type="button"
              cdkDragHandle
              class="w-6 h-6 inline-flex items-center justify-center text-ink-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-ink focus-visible:outline-offset-2 disabled:opacity-40 cursor-grab active:cursor-grabbing"
              [attr.aria-label]="
                'Reorder ' + node.label + '. Use ArrowUp or ArrowDown to move between siblings.'
              "
              [attr.data-testid]="'drag-handle-' + node.id"
              [disabled]="reordering()"
              (keydown.arrowup)="onHandleKey($event, 'up', parentId, node.id)"
              (keydown.arrowdown)="onHandleKey($event, 'down', parentId, node.id)"
            >
              <span aria-hidden="true">⋮⋮</span>
            </button>
          }

          @if (node.children.length > 0) {
            <button
              type="button"
              class="w-6 h-6 inline-flex items-center justify-center text-ink-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-ink focus-visible:outline-offset-2"
              [attr.aria-label]="(isExpanded(node.id) ? 'Collapse ' : 'Expand ') + node.label"
              [attr.aria-controls]="'category-children-' + node.id"
              [attr.aria-expanded]="isExpanded(node.id)"
              (click)="toggle(node.id)"
              [attr.data-testid]="'category-toggle-' + node.id"
            >
              <span aria-hidden="true">{{ isExpanded(node.id) ? '▾' : '▸' }}</span>
            </button>
          } @else {
            <span class="w-6 h-6" aria-hidden="true"></span>
          }

          <a
            [routerLink]="['/categories', node.id]"
            class="flex-1 min-w-0 text-sm text-ink hover:underline focus-visible:outline-2 focus-visible:outline-ink focus-visible:outline-offset-2"
          >
            {{ node.label }}
            <span class="ml-2 text-ink-muted text-xs">/{{ node.slug }}</span>
          </a>

          @if (!node.isVisible) {
            <app-badge tone="warning" [ariaLabel]="node.label + ' is hidden from the storefront'">
              Hidden
            </app-badge>
          }
          <span class="text-xs text-ink-muted tabular-nums"> {{ node.productCount }} items </span>
        </div>

        @if (isExpanded(node.id) && node.children.length > 0) {
          <ul
            cdkDropList
            #childList="cdkDropList"
            [cdkDropListData]="node.children"
            [cdkDropListDisabled]="!canReorder() || reordering()"
            (cdkDropListDropped)="drop($event, node.id)"
            [id]="'category-children-' + node.id"
            [attr.aria-label]="node.label + ' subcategories'"
            class="divide-y divide-line"
          >
            @for (child of node.children; track child.id) {
              <ng-container
                *ngTemplateOutlet="
                  rowTemplate;
                  context: { $implicit: child, parentId: node.id };
                  injector: dropListInjector(childList)
                "
              ></ng-container>
            }
          </ul>
        }
      </li>
    </ng-template>
  `,
})
export class CategoriesTreePage implements OnInit, OnDestroy {
  private readonly categoriesService = inject(CategoriesService);
  private readonly authStore = inject(AuthStore);
  private readonly storeSettings = inject(StoreSettingsStore);
  private readonly destroy$ = new Subject<void>();
  private readonly parentInjector = inject(Injector);
  private readonly dropListInjectors = new WeakMap<CdkDropList, Injector>();

  readonly loading = signal(true);
  readonly reordering = signal(false);
  readonly error = signal<string | null>(null);
  readonly tree = signal<readonly CategoryNodeView[]>([]);
  private readonly expanded = signal<ReadonlySet<string>>(new Set());

  readonly canManage = computed(() =>
    this.authStore.hasAnyPermission(['categories:create', 'categories:manage']),
  );
  readonly canReorder = computed(() =>
    this.authStore.hasAnyPermission(['categories:update', 'categories:manage']),
  );

  ngOnInit(): void {
    this.fetch();
  }

  /**
   * The row template is declared once at the component root, so a `cdkDrag`
   * stamped from it cannot find its drop list through the element tree and
   * never registers. This injector hands each row the list it renders in.
   * Cached per list so the outlet does not re-stamp rows on every change.
   */
  dropListInjector(list: CdkDropList): Injector {
    let injector = this.dropListInjectors.get(list);
    if (!injector) {
      injector = Injector.create({
        providers: [{ provide: CDK_DROP_LIST, useValue: list }],
        parent: this.parentInjector,
      });
      this.dropListInjectors.set(list, injector);
    }
    return injector;
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  isExpanded(id: string): boolean {
    return this.expanded().has(id);
  }

  toggle(id: string): void {
    const next = new Set(this.expanded());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.expanded.set(next);
  }

  drop(event: CdkDragDrop<readonly CategoryNodeView[]>, parentId: string | null): void {
    if (event.previousIndex === event.currentIndex) return;
    this.reorderSiblings(parentId, event.previousIndex, event.currentIndex);
  }

  onHandleKey(
    event: Event,
    direction: 'up' | 'down',
    parentId: string | null,
    nodeId: string,
  ): void {
    event.preventDefault();
    event.stopPropagation();
    this.nudge(direction, parentId, nodeId);
  }

  nudge(direction: 'up' | 'down', parentId: string | null, nodeId: string): void {
    const siblings = this.siblingsOf(parentId);
    const currentIndex = siblings.findIndex((n) => n.id === nodeId);
    if (currentIndex < 0) return;
    const targetIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
    if (targetIndex < 0 || targetIndex >= siblings.length) return;
    this.reorderSiblings(parentId, currentIndex, targetIndex);
  }

  private reorderSiblings(parentId: string | null, fromIndex: number, toIndex: number): void {
    const snapshot = this.tree();
    const nextTree = this.applyMove(snapshot, parentId, fromIndex, toIndex);
    if (nextTree === snapshot) return;
    this.error.set(null);
    this.tree.set(nextTree);
    this.reordering.set(true);
    const siblings = this.siblingsOf(parentId, nextTree);
    const items = siblings.map((n, index) => ({ id: n.id, sortOrder: index }));
    this.categoriesService
      .reorder({
        items: items as [{ id: string; sortOrder: number }, ...{ id: string; sortOrder: number }[]],
      })
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: () => {
          this.reordering.set(false);
          this.fetch();
        },
        error: (err: unknown) => {
          this.reordering.set(false);
          this.tree.set(snapshot);
          this.error.set(this.formatError(err));
        },
      });
  }

  private siblingsOf(
    parentId: string | null,
    tree: readonly CategoryNodeView[] = this.tree(),
  ): readonly CategoryNodeView[] {
    if (parentId === null) return tree;
    const parent = this.findNode(tree, parentId);
    return parent?.children ?? [];
  }

  private findNode(nodes: readonly CategoryNodeView[], id: string): CategoryNodeView | null {
    for (const n of nodes) {
      if (n.id === id) return n;
      const nested = this.findNode(n.children, id);
      if (nested) return nested;
    }
    return null;
  }

  private applyMove(
    nodes: readonly CategoryNodeView[],
    parentId: string | null,
    fromIndex: number,
    toIndex: number,
  ): readonly CategoryNodeView[] {
    if (parentId === null) {
      const next = nodes.slice() as CategoryNodeView[];
      if (fromIndex < 0 || fromIndex >= next.length || toIndex < 0 || toIndex >= next.length) {
        return nodes;
      }
      moveItemInArray(next, fromIndex, toIndex);
      return next;
    }
    let moved = false;
    const walk = (list: readonly CategoryNodeView[]): readonly CategoryNodeView[] =>
      list.map((node) => {
        if (node.id === parentId) {
          const nextChildren = node.children.slice() as CategoryNodeView[];
          if (
            fromIndex < 0 ||
            fromIndex >= nextChildren.length ||
            toIndex < 0 ||
            toIndex >= nextChildren.length
          ) {
            return node;
          }
          moveItemInArray(nextChildren, fromIndex, toIndex);
          moved = true;
          return { ...node, children: nextChildren };
        }
        if (node.children.length > 0) {
          return { ...node, children: walk(node.children) };
        }
        return node;
      });
    const nextTree = walk(nodes);
    return moved ? nextTree : nodes;
  }

  private fetch(): void {
    this.loading.set(true);
    this.error.set(null);
    this.categoriesService
      .tree()
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (nodes) => {
          const projected = projectTree(
            nodes,
            this.authStore.locale(),
            this.storeSettings.defaultLocale(),
          );
          this.tree.set(projected);
          this.expanded.set(new Set(projected.map((n) => n.id)));
          this.loading.set(false);
        },
        error: (err: unknown) => {
          this.loading.set(false);
          this.error.set(this.formatError(err));
        },
      });
  }

  private formatError(err: unknown): string {
    if (err instanceof ApiForbiddenError) return 'You do not have permission to view categories.';
    if (err instanceof ApiNotFoundError) return 'Categories not found.';
    if (err instanceof ApiError && err.message) return err.message;
    return 'Could not load categories. Please retry.';
  }
}
