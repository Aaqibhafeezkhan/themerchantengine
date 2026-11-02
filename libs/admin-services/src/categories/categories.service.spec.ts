import { provideHttpClient, withFetch } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ADMIN_API_BASE_URL } from '../shared';
import { CategoriesService } from './categories.service';

const categoryFixture = {
  id: '14f5c9a4-1a1a-4a4a-8a8a-111111111111',
  name: { default: 'Footwear' },
  slug: 'footwear',
  children: [
    {
      id: '24f5c9a4-1a1a-4a4a-8a8a-222222222222',
      name: { default: 'Sneakers' },
      slug: 'sneakers',
      parentId: '14f5c9a4-1a1a-4a4a-8a8a-111111111111',
    },
  ],
};

const VALID_ID_A = '14f5c9a4-1a1a-4a4a-8a8a-111111111111';
const VALID_ID_B = '24f5c9a4-1a1a-4a4a-8a8a-222222222222';

describe('CategoriesService', () => {
  let service: CategoriesService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withFetch()),
        provideHttpClientTesting(),
        { provide: ADMIN_API_BASE_URL, useValue: '/api' },
        CategoriesService,
      ],
    });
    service = TestBed.inject(CategoriesService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('tree() unwraps array envelope with nested children', (done) => {
    service.tree().subscribe((tree) => {
      expect(tree).toHaveLength(1);
      expect(tree[0]?.children).toHaveLength(1);
      done();
    });
    http.expectOne('/api/v1/admin/categories').flush({ data: [categoryFixture] });
  });

  it('create() sends validation errors through the Observable error channel', (done) => {
    service.create({ name: { default: 'X' }, slug: 'Not A Slug' }).subscribe({
      next: () => done.fail('should not emit for invalid input'),
      error: (err: unknown) => {
        expect(err).toBeDefined();
        done();
      },
    });
    http.expectNone('/api/v1/admin/categories');
  });

  it('reorder() PATCHes the dedicated /reorder route', (done) => {
    service
      .reorder({
        items: [
          { id: VALID_ID_A, sortOrder: 0 },
          { id: VALID_ID_B, sortOrder: 1 },
        ],
      })
      .subscribe(() => done());
    const req = http.expectOne('/api/v1/admin/categories/reorder');
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual({
      items: [
        { id: VALID_ID_A, sortOrder: 0 },
        { id: VALID_ID_B, sortOrder: 1 },
      ],
    });
    expect(req.request.withCredentials).toBe(true);
    req.flush(null);
  });

  it('reorder() strips extra keys before sending', (done) => {
    service
      .reorder({
        items: [
          { id: VALID_ID_A, sortOrder: 0, label: 'foo' } as unknown as {
            id: string;
            sortOrder: number;
          },
        ],
      })
      .subscribe(() => done());
    const req = http.expectOne('/api/v1/admin/categories/reorder');
    const body = req.request.body as { items: { id: string; sortOrder: number; label?: string }[] };
    expect(body.items[0]).toEqual({ id: VALID_ID_A, sortOrder: 0 });
    expect(body.items[0]).not.toHaveProperty('label');
    req.flush(null);
  });

  it('reorder() sends validation errors through the Observable error channel', (done) => {
    service.reorder({ items: [] as never }).subscribe({
      next: () => done.fail('should not emit for invalid input'),
      error: (err: unknown) => {
        expect(err).toBeDefined();
        done();
      },
    });
    http.expectNone('/api/v1/admin/categories/reorder');
  });

  it('reorder() sends invalid ids through the Observable error channel', (done) => {
    service.reorder({ items: [{ id: 'not a valid id!', sortOrder: 0 }] as never }).subscribe({
      next: () => done.fail('should not emit for invalid input'),
      error: (err: unknown) => {
        expect(err).toBeDefined();
        done();
      },
    });
    http.expectNone('/api/v1/admin/categories/reorder');
  });

  it('reorder() sends negative sort orders through the Observable error channel', (done) => {
    service.reorder({ items: [{ id: VALID_ID_A, sortOrder: -1 }] }).subscribe({
      next: () => done.fail('should not emit for invalid input'),
      error: (err: unknown) => {
        expect(err).toBeDefined();
        done();
      },
    });
    http.expectNone('/api/v1/admin/categories/reorder');
  });

  it('reorder() sends non-integer sort orders through the Observable error channel', (done) => {
    service.reorder({ items: [{ id: VALID_ID_A, sortOrder: 1.5 }] }).subscribe({
      next: () => done.fail('should not emit for invalid input'),
      error: (err: unknown) => {
        expect(err).toBeDefined();
        done();
      },
    });
    http.expectNone('/api/v1/admin/categories/reorder');
  });

  it('reorder() propagates a 403 HTTP error to the subscriber', (done) => {
    service.reorder({ items: [{ id: VALID_ID_A, sortOrder: 0 }] }).subscribe({
      next: () => done.fail('should not emit on 403'),
      error: (err: { status: number }) => {
        expect(err.status).toBe(403);
        done();
      },
    });
    http
      .expectOne('/api/v1/admin/categories/reorder')
      .flush(
        { error: { code: 'FORBIDDEN', message: 'nope' } },
        { status: 403, statusText: 'Forbidden' },
      );
  });

  it('reorder() propagates a 400 HTTP error to the subscriber', (done) => {
    service.reorder({ items: [{ id: VALID_ID_A, sortOrder: 0 }] }).subscribe({
      next: () => done.fail('should not emit on 400'),
      error: (err: { status: number }) => {
        expect(err.status).toBe(400);
        done();
      },
    });
    http
      .expectOne('/api/v1/admin/categories/reorder')
      .flush(
        { error: { code: 'VALIDATION', message: 'bad' } },
        { status: 400, statusText: 'Bad Request' },
      );
  });

  it('update() sends validation errors through the Observable error channel', (done) => {
    service.update(VALID_ID_A, { slug: 'Not A Slug' }).subscribe({
      next: () => done.fail('should not emit for invalid input'),
      error: (err: unknown) => {
        expect(err).toBeDefined();
        done();
      },
    });
    http.expectNone(`/api/v1/admin/categories/${VALID_ID_A}`);
  });

  it('delete() DELETEs for soft-delete semantics', (done) => {
    service.delete(categoryFixture.id).subscribe(() => done());
    const req = http.expectOne(`/api/v1/admin/categories/${categoryFixture.id}`);
    expect(req.request.method).toBe('DELETE');
    req.flush(null);
  });
});
