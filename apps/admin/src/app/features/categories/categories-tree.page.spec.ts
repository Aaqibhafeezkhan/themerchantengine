import { ApiError, ApiForbiddenError, ApiNotFoundError } from '@admin-types';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { CategoriesService } from '@admin-services';
import { CdkDrag, CdkDropList } from '@angular/cdk/drag-drop';
import type { CdkDragDrop } from '@angular/cdk/drag-drop';
import { By } from '@angular/platform-browser';
import { axe, toHaveNoViolations } from 'jest-axe';
import { Subject, of, throwError } from 'rxjs';
import { AuthStore } from '../../core/stores/auth.store';
import { BOOTSTRAP_LOCALE } from '../../core/tokens';
import { CategoriesTreePage } from './categories-tree.page';

expect.extend(toHaveNoViolations);

describe('CategoriesTreePage', () => {
  let fixture: ComponentFixture<CategoriesTreePage>;
  let page: CategoriesTreePage;
  let treeSpy: jest.Mock;
  let reorderSpy: jest.Mock;

  const treeFixture = [
    {
      id: 'a',
      name: { default: 'Alpha', en: 'Alpha' },
      slug: 'alpha',
      productCount: 3,
      isVisible: true,
      children: [
        {
          id: 'a1',
          name: { default: 'Alpha 1', en: 'Alpha 1' },
          slug: 'alpha-1',
          productCount: 1,
          isVisible: false,
          children: [],
        },
        {
          id: 'a2',
          name: { default: 'Alpha 2', en: 'Alpha 2' },
          slug: 'alpha-2',
          productCount: 1,
          isVisible: true,
          children: [],
        },
      ],
    },
    {
      id: 'b',
      name: { default: 'Bravo', en: 'Bravo' },
      slug: 'bravo',
      productCount: 0,
      isVisible: true,
      children: [],
    },
    {
      id: 'c',
      name: { default: 'Charlie', en: 'Charlie' },
      slug: 'charlie',
      productCount: 0,
      isVisible: true,
      children: [],
    },
  ];

  function configure(permissions: string[] = ['categories:view']) {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: '**', children: [] }]),
        { provide: BOOTSTRAP_LOCALE, useValue: 'fr' },
        {
          provide: CategoriesService,
          useValue: { tree: treeSpy, reorder: reorderSpy },
        },
      ],
    });
    TestBed.inject(AuthStore).setSession({
      user: {
        id: 'u',
        email: 'a@b',
        permissions,
        roles: [],
        status: 'active',
      },
    });
    fixture = TestBed.createComponent(CategoriesTreePage);
    page = fixture.componentInstance;
    fixture.detectChanges();
  }

  function dropEvent(previousIndex: number, currentIndex: number): CdkDragDrop<unknown> {
    return { previousIndex, currentIndex } as unknown as CdkDragDrop<unknown>;
  }

  beforeEach(() => {
    treeSpy = jest.fn(() => of(treeFixture));
    reorderSpy = jest.fn(() => of(undefined));
  });

  it('loads the tree and auto-expands the top level', () => {
    configure();
    expect(page.loading()).toBe(false);
    expect(page.tree()).toHaveLength(3);
    expect(page.isExpanded('a')).toBe(true);
    expect(page.isExpanded('a1')).toBe(false);
  });

  it('toggle flips an id in the expanded set', () => {
    configure();
    page.toggle('a1');
    expect(page.isExpanded('a1')).toBe(true);
    page.toggle('a1');
    expect(page.isExpanded('a1')).toBe(false);
  });

  it('surfaces ApiForbiddenError with a permission-safe message', () => {
    treeSpy = jest.fn(() =>
      throwError(() => new ApiForbiddenError({ code: 'FORBIDDEN', message: 'nope' })),
    );
    configure();
    expect(page.error()).toContain('permission');
  });

  it('surfaces ApiNotFoundError as the categories-not-found error', () => {
    treeSpy = jest.fn(() =>
      throwError(() => new ApiNotFoundError({ code: 'NOT_FOUND', message: 'missing' })),
    );
    configure();
    expect(page.error()).toBe('Categories not found.');
  });

  it('canManage is false without create/manage permissions', () => {
    configure(['categories:view']);
    expect(page.canManage()).toBe(false);
  });

  it('canManage is true with categories:create', () => {
    configure(['categories:view', 'categories:create']);
    expect(page.canManage()).toBe(true);
  });

  it('canReorder is false with only categories:view', () => {
    configure(['categories:view']);
    expect(page.canReorder()).toBe(false);
  });

  it('canReorder is true with categories:update', () => {
    configure(['categories:view', 'categories:update']);
    expect(page.canReorder()).toBe(true);
  });

  it('canReorder is true with categories:manage', () => {
    configure(['categories:manage']);
    expect(page.canReorder()).toBe(true);
  });

  it('drag-handle buttons are absent when canReorder is false', () => {
    configure(['categories:view']);
    const handles = fixture.nativeElement.querySelectorAll('[data-testid^="drag-handle-"]');
    expect(handles.length).toBe(0);
  });

  it('drag-handle buttons render for every visible row when canReorder is true', () => {
    configure(['categories:update']);
    const handles = fixture.nativeElement.querySelectorAll('[data-testid^="drag-handle-"]');
    // Tree has 3 roots and an expanded Alpha with 2 children = 5 visible rows.
    expect(handles.length).toBe(5);
  });

  it('every row is registered with the drop list of its own sibling group', () => {
    configure(['categories:update']);
    const rows = fixture.debugElement.queryAll(By.directive(CdkDrag));
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      const drag = row.injector.get(CdkDrag);
      expect(drag.dropContainer).toBeTruthy();
      const list = fixture.debugElement
        .queryAll(By.directive(CdkDropList))
        .find((l) => l.nativeElement === row.nativeElement.parentElement);
      expect(drag.dropContainer).toBe(list?.injector.get(CdkDropList));
    }
  });

  it('drop calls reorder with the new sibling order and re-fetches on success', () => {
    configure(['categories:update']);
    treeSpy.mockClear();
    page.drop(dropEvent(0, 2), null);
    expect(reorderSpy).toHaveBeenCalledTimes(1);
    const payload = reorderSpy.mock.calls[0][0];
    expect(payload.items.map((i: { id: string }) => i.id)).toEqual(['b', 'c', 'a']);
    expect(payload.items.map((i: { sortOrder: number }) => i.sortOrder)).toEqual([0, 1, 2]);
    expect(treeSpy).toHaveBeenCalledTimes(1);
  });

  it('drop is a no-op when previousIndex equals currentIndex', () => {
    configure(['categories:update']);
    page.drop(dropEvent(1, 1), null);
    expect(reorderSpy).not.toHaveBeenCalled();
  });

  it('drop performs the optimistic move before reorder resolves', () => {
    const gate = new Subject<void>();
    reorderSpy = jest.fn(() => gate.asObservable());
    configure(['categories:update']);
    page.drop(dropEvent(0, 2), null);
    expect(page.tree().map((n) => n.id)).toEqual(['b', 'c', 'a']);
    gate.next();
    gate.complete();
  });

  it('drop rolls back to pre-drop order and surfaces error when reorder fails', () => {
    reorderSpy = jest.fn(() =>
      throwError(() => new ApiError({ code: 'SERVER', message: 'boom', status: 500 })),
    );
    configure(['categories:update']);
    const snapshot = page.tree().map((n) => n.id);
    page.drop(dropEvent(0, 2), null);
    expect(page.tree().map((n) => n.id)).toEqual(snapshot);
    expect(page.error()).toBe('boom');
  });

  it('drop surfaces ApiForbiddenError with permission copy and rolls back', () => {
    reorderSpy = jest.fn(() =>
      throwError(() => new ApiForbiddenError({ code: 'FORBIDDEN', message: 'nope' })),
    );
    configure(['categories:update']);
    page.drop(dropEvent(0, 2), null);
    expect(page.error()).toContain('permission');
    expect(page.tree()[0]?.id).toBe('a');
  });

  it('drop falls back to generic copy for an unknown error shape', () => {
    reorderSpy = jest.fn(() => throwError(() => new Error('raw')));
    configure(['categories:update']);
    page.drop(dropEvent(0, 2), null);
    expect(page.error()).toContain('Could not load categories');
  });

  it('nudge up moves a root node up one position and PATCHes with new order', () => {
    const gate = new Subject<void>();
    reorderSpy = jest.fn(() => gate.asObservable());
    configure(['categories:update']);
    page.nudge('up', null, 'c');
    expect(page.tree().map((n) => n.id)).toEqual(['a', 'c', 'b']);
    const payload = reorderSpy.mock.calls[0][0];
    expect(payload.items.map((i: { id: string }) => i.id)).toEqual(['a', 'c', 'b']);
    gate.next();
    gate.complete();
  });

  it('nudge down moves a root node down one position and PATCHes with new order', () => {
    const gate = new Subject<void>();
    reorderSpy = jest.fn(() => gate.asObservable());
    configure(['categories:update']);
    page.nudge('down', null, 'a');
    expect(page.tree().map((n) => n.id)).toEqual(['b', 'a', 'c']);
    const payload = reorderSpy.mock.calls[0][0];
    expect(payload.items.map((i: { id: string }) => i.id)).toEqual(['b', 'a', 'c']);
    gate.next();
    gate.complete();
  });

  it('nudge up is a no-op at the top boundary', () => {
    configure(['categories:update']);
    page.nudge('up', null, 'a');
    expect(reorderSpy).not.toHaveBeenCalled();
  });

  it('nudge down is a no-op at the bottom boundary', () => {
    configure(['categories:update']);
    page.nudge('down', null, 'c');
    expect(reorderSpy).not.toHaveBeenCalled();
  });

  it('nudge on a child uses the parent sibling list, not the root list', () => {
    const gate = new Subject<void>();
    reorderSpy = jest.fn(() => gate.asObservable());
    configure(['categories:update']);
    page.nudge('up', 'a', 'a2');
    const rootIds = page.tree().map((n) => n.id);
    expect(rootIds).toEqual(['a', 'b', 'c']);
    const alphaChildren = page.tree()[0]?.children.map((n) => n.id);
    expect(alphaChildren).toEqual(['a2', 'a1']);
    const payload = reorderSpy.mock.calls[0][0];
    expect(payload.items.map((i: { id: string }) => i.id)).toEqual(['a2', 'a1']);
    gate.next();
    gate.complete();
  });

  it('nudge rolls back on reorder error', () => {
    reorderSpy = jest.fn(() =>
      throwError(() => new ApiError({ code: 'SERVER', message: 'boom', status: 500 })),
    );
    configure(['categories:update']);
    const before = page.tree().map((n) => n.id);
    page.nudge('up', null, 'c');
    expect(page.tree().map((n) => n.id)).toEqual(before);
    expect(page.error()).toBe('boom');
  });

  it('has no axe violations on the loaded view', async () => {
    configure();
    const results = await axe(fixture.nativeElement);
    expect(results).toHaveNoViolations();
  });

  it('has no axe violations when drag handles are visible', async () => {
    configure(['categories:update']);
    const results = await axe(fixture.nativeElement);
    expect(results).toHaveNoViolations();
  });

  it('has no axe violations in the reorder-error state', async () => {
    reorderSpy = jest.fn(() =>
      throwError(() => new ApiError({ code: 'SERVER', message: 'boom', status: 500 })),
    );
    configure(['categories:update']);
    page.drop(dropEvent(0, 2), null);
    fixture.detectChanges();
    const results = await axe(fixture.nativeElement);
    expect(results).toHaveNoViolations();
  });
});
