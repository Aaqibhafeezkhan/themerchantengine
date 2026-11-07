import { ApiConflictError, ApiForbiddenError, ApiNotFoundError } from '@admin-types';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter, type ParamMap } from '@angular/router';
import { AssetsService, CategoriesService } from '@admin-services';
import * as adminUi from '@admin-ui';
import { axe, toHaveNoViolations } from 'jest-axe';
import { BehaviorSubject, of, throwError } from 'rxjs';
import { AuthStore } from '../../core/stores/auth.store';
import { BOOTSTRAP_LOCALE } from '../../core/tokens';
import { CategoryFormPage } from './category-form.page';

expect.extend(toHaveNoViolations);

describe('CategoryFormPage', () => {
  let fixture: ComponentFixture<CategoryFormPage>;
  let page: CategoryFormPage;
  let treeSpy: jest.Mock;
  let createSpy: jest.Mock;
  let updateSpy: jest.Mock;
  let deleteSpy: jest.Mock;
  let confirmSpy: jest.SpyInstance;
  let paramMap$: BehaviorSubject<ParamMap>;

  const treeFixture = [
    {
      id: 'a',
      name: { default: 'Alpha', en: 'Alpha' },
      slug: 'alpha',
      productCount: 0,
      isVisible: true,
      parentId: null,
      children: [
        {
          id: 'a1',
          name: { default: 'Alpha 1', en: 'Alpha 1' },
          slug: 'alpha-1',
          productCount: 0,
          isVisible: true,
          parentId: 'a',
          children: [],
        },
      ],
    },
  ];

  function configure(
    id: string | null,
    perms: string[] = [
      'categories:view',
      'categories:create',
      'categories:update',
      'categories:delete',
    ],
  ) {
    paramMap$ = new BehaviorSubject<ParamMap>(convertToParamMap(id ? { id } : {}));
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: '**', children: [] }]),
        { provide: BOOTSTRAP_LOCALE, useValue: 'fr' },
        {
          provide: CategoriesService,
          useValue: { tree: treeSpy, create: createSpy, update: updateSpy, delete: deleteSpy },
        },
        {
          provide: AssetsService,
          useValue: { tryPublicVariantUrl: () => null, get: () => of(null) },
        },
        { provide: ActivatedRoute, useValue: { paramMap: paramMap$.asObservable() } },
      ],
    });
    TestBed.inject(AuthStore).setSession({
      user: { id: 'u', email: 'a@b', permissions: perms, roles: [], status: 'active' },
    });
    fixture = TestBed.createComponent(CategoryFormPage);
    page = fixture.componentInstance;
    fixture.detectChanges();
  }

  beforeEach(() => {
    treeSpy = jest.fn(() => of(treeFixture));
    createSpy = jest.fn((body: { slug: string }) =>
      of({ ...treeFixture[0], id: 'new', slug: body.slug }),
    );
    updateSpy = jest.fn((_id: string, body: Record<string, unknown>) =>
      of({ ...treeFixture[0], ...body }),
    );
    deleteSpy = jest.fn(() => of(undefined));
    confirmSpy = jest.spyOn(adminUi, 'openConfirmDialog').mockResolvedValue(true);
  });

  afterEach(() => confirmSpy.mockRestore());

  it('create mode starts with an empty form + parent picker options', () => {
    configure(null);
    expect(page.mode()).toBe('create');
    expect(page.form.controls.slug.value).toBe('');
    expect(page.parentOptions().map((o) => o.id)).toEqual(['a', 'a1']);
  });

  it('edit mode seeds the form from the tree + excludes self from parent list', () => {
    configure('a');
    expect(page.mode()).toBe('edit');
    expect(page.form.controls.slug.value).toBe('alpha');
    // "a" (self) AND its subtree ("a1") excluded from parent picker.
    expect(page.parentOptions()).toEqual([]);
  });

  it('slug validator rejects uppercase', () => {
    configure(null);
    page.form.controls.slug.setValue('NotSlug');
    page.form.controls.slug.markAsTouched();
    expect(page.slugError()).toContain('Lowercase');
  });

  it('save in create mode POSTs and redirects to the new category', () => {
    configure(null);
    page.form.setValue({
      name: { default: 'New', en: 'New' },
      slug: 'new-cat',
      parentId: null,
      description: { default: '' },
      isVisible: true,
      imageId: null,
    });
    page.form.markAsDirty();
    page.save();
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'new-cat', isVisible: true }),
    );
  });

  it('opens the asset picker and stores the selected id on the form', async () => {
    const pickSpy = jest.spyOn(adminUi, 'openAssetPicker').mockResolvedValue({
      kind: 'select-single',
      asset: {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        type: 'IMAGE',
        status: 'READY',
        mimeType: 'image/png',
        fileSize: 1,
        storagePath: '',
        url: 'http://x',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      } as never,
    });
    configure(null);
    await page.pickImage();
    expect(pickSpy).toHaveBeenCalled();
    expect(page.form.controls.imageId.value).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    pickSpy.mockRestore();
  });

  it('clears the image id when the operator removes the selection', () => {
    configure(null);
    page.form.controls.imageId.setValue('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    page.clearImage();
    expect(page.form.controls.imageId.value).toBeNull();
  });

  it('leaves imageId untouched when the asset picker is cancelled', async () => {
    const pickSpy = jest.spyOn(adminUi, 'openAssetPicker').mockResolvedValue({ kind: 'cancel' });
    configure(null);
    await page.pickImage();
    expect(page.form.controls.imageId.value).toBeNull();
    pickSpy.mockRestore();
  });

  it('save in edit mode is a no-op when pristine', () => {
    configure('a');
    page.save();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('save in edit mode PATCHes when dirty', () => {
    configure('a');
    page.form.controls.slug.setValue('renamed');
    page.form.controls.slug.markAsDirty();
    page.save();
    expect(updateSpy).toHaveBeenCalledWith('a', expect.objectContaining({ slug: 'renamed' }));
  });

  it('delete requires confirm + calls service.delete', async () => {
    configure('a');
    await page.confirmDelete();
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(deleteSpy).toHaveBeenCalledWith('a');
  });

  it('delete ApiConflictError maps to the assigned-products error', async () => {
    deleteSpy = jest.fn(() =>
      throwError(
        () => new ApiConflictError({ code: 'CATEGORY_HAS_PRODUCTS', message: 'assigned' }),
      ),
    );
    configure('a');
    await page.confirmDelete();
    expect(page.error()).toContain('products still reference');
  });

  it('delete with an unknown conflict code does not claim products are assigned', async () => {
    deleteSpy = jest.fn(() =>
      throwError(() => new ApiConflictError({ code: 'CONFLICT', message: 'other' })),
    );
    configure('a');
    await page.confirmDelete();
    expect(page.error()).not.toContain('products still reference');
  });

  it('save ApiConflictError maps to slug conflict', () => {
    updateSpy = jest.fn(() =>
      throwError(() => new ApiConflictError({ code: 'CATEGORY_SLUG_TAKEN', message: 'taken' })),
    );
    configure('a');
    page.form.controls.slug.setValue('taken');
    page.form.controls.slug.markAsDirty();
    page.save();
    expect(page.error()).toContain('Slug conflict');
  });

  it('save with an unknown conflict code does not blame the slug', () => {
    updateSpy = jest.fn(() =>
      throwError(() => new ApiConflictError({ code: 'CONFLICT', message: 'cycle' })),
    );
    configure('a');
    page.form.controls.slug.setValue('taken');
    page.form.controls.slug.markAsDirty();
    page.save();
    expect(page.error()).not.toContain('Slug conflict');
  });

  it('save ApiForbiddenError maps to the permission-specific error', () => {
    updateSpy = jest.fn(() =>
      throwError(() => new ApiForbiddenError({ code: 'FORBIDDEN', message: 'nope' })),
    );
    configure('a');
    page.form.controls.slug.setValue('taken');
    page.form.controls.slug.markAsDirty();
    page.save();
    expect(page.error()).toContain('permission');
  });

  it('save ApiNotFoundError maps to category-not-found', () => {
    updateSpy = jest.fn(() =>
      throwError(() => new ApiNotFoundError({ code: 'NOT_FOUND', message: 'missing' })),
    );
    configure('a');
    page.form.controls.slug.setValue('taken');
    page.form.controls.slug.markAsDirty();
    page.save();
    expect(page.error()).toBe('Category not found.');
  });

  it('not-found id surfaces a clear error', () => {
    configure('zzz');
    expect(page.error()).toBe('Category not found.');
  });

  it('has no axe violations in edit mode', async () => {
    configure('a');
    const results = await axe(fixture.nativeElement);
    expect(results).toHaveNoViolations();
  });
});
