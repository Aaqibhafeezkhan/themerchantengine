import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ProductStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CategoriesService } from './categories.service';
import { CategorySlugTakenException } from './category-slug-taken.exception';
import { CategoryHasProductsException } from './category-has-products.exception';
import { CATEGORIES_REDIS_CLIENT } from './categories.constants';
import { CATEGORY_TREE_CACHE_KEY } from './categories.constants';

// ── Factories ─────────────────────────────────────────────────────────────────

/**
 * A READY Asset row shaped the way `tryPickVariantUrl` expects. The `card`
 * intent maps to the `small` variant, and `imageAssetVariantsSchema` is
 * `.strict()` and requires all four names in both formats, so a partial
 * payload resolves to null rather than to a URL.
 */
function artefact(name: string, format: string, width: number) {
  return {
    url: `https://cdn/${name}.${format}`,
    storagePath: `assets/${name}.${format}`,
    width,
    height: width,
    size: 1024,
  };
}

function makeReadyImage(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'asset-1',
    status: 'READY',
    variants: {
      thumbnail: {
        webp: artefact('thumbnail', 'webp', 150),
        avif: artefact('thumbnail', 'avif', 150),
      },
      small: { webp: artefact('card', 'webp', 400), avif: artefact('card', 'avif', 400) },
      medium: { webp: artefact('medium', 'webp', 800), avif: artefact('medium', 'avif', 800) },
      large: { webp: artefact('large', 'webp', 1600), avif: artefact('large', 'avif', 1600) },
    },
    ...overrides,
  };
}

function makeCategory(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'cat-1',
    name: { default: 'Electronics', en: 'Electronics' },
    slug: 'electronics',
    description: null,
    parentId: null,
    imageId: null,
    sortOrder: 0,
    isVisible: true,
    path: '/cat-1/',
    depth: 0,
    metaTitle: null,
    metaDescription: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  };
}

function makeChildCategory(overrides: Partial<Record<string, unknown>> = {}) {
  return makeCategory({
    id: 'cat-2',
    name: { default: 'Phones', en: 'Phones' },
    slug: 'phones',
    parentId: 'cat-1',
    path: '/cat-1/cat-2/',
    depth: 1,
    ...overrides,
  });
}

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockPrisma = {
  category: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  productCategory: {
    count: jest.fn(),
    findMany: jest.fn(),
    groupBy: jest.fn(),
  },
  $transaction: jest.fn(),
};

const mockRedis = {
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
};

const mockConfig = {
  get: jest.fn((key: string, defaultValue?: unknown) => {
    if (key === 'DEFAULT_PAGE_SIZE') return 20;
    return defaultValue;
  }),
};

const mockEventEmitter = { emit: jest.fn() };

// ─────────────────────────────────────────────────────────────────────────────

describe('CategoriesService', () => {
  let service: CategoriesService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CategoriesService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: ConfigService, useValue: mockConfig },
        { provide: EventEmitter2, useValue: mockEventEmitter },
        { provide: CATEGORIES_REDIS_CLIENT, useValue: mockRedis },
      ],
    }).compile();

    service = module.get<CategoriesService>(CategoriesService);
  });

  // ── getTree ─────────────────────────────────────────────────────────────────

  describe('getTree', () => {
    it('returns cached tree when Redis hit', async () => {
      const tree = [{ id: 'cat-1', children: [] }];
      mockRedis.get.mockResolvedValueOnce(JSON.stringify(tree));

      const result = await service.getTree();

      expect(result).toEqual(tree);
      expect(mockPrisma.category.findMany).not.toHaveBeenCalled();
    });

    it('builds tree from DB and caches on Redis miss', async () => {
      mockRedis.get.mockResolvedValueOnce(null);
      const root = makeCategory();
      const child = makeChildCategory();
      mockPrisma.category.findMany.mockResolvedValueOnce([root, child]);
      mockRedis.set.mockResolvedValueOnce('OK');

      const result = await service.getTree();

      expect(mockPrisma.category.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { isVisible: true } }),
      );
      expect(mockRedis.set).toHaveBeenCalledWith(
        CATEGORY_TREE_CACHE_KEY,
        expect.any(String),
        'EX',
        3600,
      );
      expect(result).toHaveLength(1);
      expect(result[0].children).toHaveLength(1);
    });

    it('hydrates imageId to imageUrl + imageVariants and strips the raw relation', async () => {
      // S5 / H4: `imageId` left the API as a bare string and nothing on the
      // storefront could turn it into a URL.
      mockRedis.get.mockResolvedValueOnce(null);
      mockPrisma.category.findMany.mockResolvedValueOnce([
        makeCategory({ imageId: 'asset-1', image: makeReadyImage() }),
      ]);
      mockRedis.set.mockResolvedValueOnce('OK');

      const result = await service.getTree();

      const node = result[0] as unknown as Record<string, unknown>;
      expect(node['imageUrl']).toContain('card.webp');
      expect(node['imageVariants']).toEqual(expect.arrayContaining([expect.anything()]));
      // The relation itself must not reach the public payload.
      expect(node).not.toHaveProperty('image');
    });

    it('yields a null imageUrl for a category with no image', async () => {
      mockRedis.get.mockResolvedValueOnce(null);
      mockPrisma.category.findMany.mockResolvedValueOnce([
        makeCategory({ imageId: null, image: null }),
      ]);
      mockRedis.set.mockResolvedValueOnce('OK');

      const result = await service.getTree();

      const node = result[0] as unknown as Record<string, unknown>;
      expect(node['imageUrl']).toBeNull();
      expect(node['imageVariants']).toEqual([]);
    });

    it('yields a null imageUrl for an image that is not READY', async () => {
      // The soft resolver degrades rather than throwing, so a still-processing
      // upload renders the glyph fallback instead of 500ing the whole tree.
      mockRedis.get.mockResolvedValueOnce(null);
      mockPrisma.category.findMany.mockResolvedValueOnce([
        makeCategory({ imageId: 'asset-1', image: makeReadyImage({ status: 'PROCESSING' }) }),
      ]);
      mockRedis.set.mockResolvedValueOnce('OK');

      const result = await service.getTree();

      expect((result[0] as unknown as Record<string, unknown>)['imageUrl']).toBeNull();
    });

    it('falls back to DB when Redis throws', async () => {
      mockRedis.get.mockRejectedValueOnce(new Error('Redis down'));
      mockPrisma.category.findMany.mockResolvedValueOnce([makeCategory()]);
      mockRedis.set.mockRejectedValueOnce(new Error('Redis down'));

      const result = await service.getTree();

      expect(result).toHaveLength(1);
    });
  });

  // ── getBySlug ───────────────────────────────────────────────────────────────

  /**
   * Every seeded category shares `sortOrder: 0`, so an order of
   * (depth, sortOrder) is not an order at all: Postgres returns rows in
   * whatever physical order it likes, and the nav reshuffles between page
   * loads. It surfaced as eighteen visual baselines that failed against
   * screenshots taken minutes earlier, all of them at the one viewport where
   * the category bar sits on a wrap boundary.
   *
   * Asserted on the query rather than on a returned order, because the
   * ordering is the database's job and a mocked findMany returns whatever it
   * was handed. `test/e2e/category-order.e2e-spec.ts` asserts the real order
   * against real rows.
   */
  describe('ordering is total', () => {
    it('breaks a sortOrder tie on slug in the public tree', async () => {
      mockRedis.get.mockResolvedValueOnce(null);
      mockPrisma.category.findMany.mockResolvedValueOnce([]);
      mockRedis.set.mockResolvedValueOnce('OK');

      await service.getTree();

      expect(mockPrisma.category.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [{ depth: 'asc' }, { sortOrder: 'asc' }, { slug: 'asc' }],
        }),
      );
    });

    it('breaks a sortOrder tie on slug in the admin tree', async () => {
      mockPrisma.category.findMany.mockResolvedValueOnce([]);
      mockPrisma.productCategory.groupBy.mockResolvedValueOnce([]);

      await service.adminGetTree();

      expect(mockPrisma.category.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [{ depth: 'asc' }, { sortOrder: 'asc' }, { slug: 'asc' }],
        }),
      );
    });

    it('breaks a sortOrder tie on productId in the paginated category listing', async () => {
      mockPrisma.category.findFirst.mockResolvedValueOnce(makeCategory());
      mockPrisma.productCategory.count.mockResolvedValueOnce(0);
      mockPrisma.productCategory.findMany.mockResolvedValueOnce([]);

      await service.getProductsInCategory('electronics', 2, 20);

      // Page 2 of an unspecified order can repeat a row it already showed.
      expect(mockPrisma.productCategory.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [{ product: { sortOrder: 'asc' } }, { productId: 'asc' }],
          skip: 20,
        }),
      );
    });
  });

  describe('getBySlug', () => {
    it('hydrates imageId the same way getTree does', async () => {
      mockPrisma.category.findFirst.mockResolvedValueOnce(
        makeCategory({ imageId: 'asset-1', image: makeReadyImage() }),
      );
      mockPrisma.productCategory.count.mockResolvedValueOnce(3);

      const result = (await service.getBySlug('electronics')) as unknown as Record<string, unknown>;

      expect(result['imageUrl']).toContain('card.webp');
      expect(result).not.toHaveProperty('image');
    });

    it('returns category with product count', async () => {
      mockPrisma.category.findFirst.mockResolvedValueOnce(makeCategory());
      mockPrisma.productCategory.count.mockResolvedValueOnce(5);

      const result = await service.getBySlug('electronics');

      expect(result.slug).toBe('electronics');
      expect(result.productCount).toBe(5);
    });

    it('throws NotFoundException for unknown slug', async () => {
      mockPrisma.category.findFirst.mockResolvedValueOnce(null);

      await expect(service.getBySlug('unknown')).rejects.toThrow(NotFoundException);
    });
  });

  // ── create ──────────────────────────────────────────────────────────────────

  describe('create', () => {
    it('rejects a slug already used by another category with a stable code', async () => {
      mockPrisma.category.findFirst.mockResolvedValueOnce(makeCategory({ slug: 'electronics' }));

      await expect(
        service.create({ name: { default: 'Electronics' }, slug: 'electronics' }),
      ).rejects.toThrow(CategorySlugTakenException);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('creates a root category with correct path /id/', async () => {
      const created = makeCategory({ id: 'new-id', path: '/', depth: 0 });
      const updated = makeCategory({ id: 'new-id', path: '/new-id/', depth: 0 });

      mockPrisma.$transaction.mockImplementationOnce(
        async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
          const tx = {
            category: {
              create: jest.fn().mockResolvedValueOnce(created),
              update: jest.fn().mockResolvedValueOnce(updated),
            },
          };
          return fn(tx as unknown as typeof mockPrisma);
        },
      );
      mockRedis.del.mockResolvedValueOnce(1);

      const result = await service.create({
        name: { default: 'Electronics' },
        slug: 'electronics',
      });

      expect(result.path).toBe('/new-id/');
      expect(result.depth).toBe(0);
    });

    it('creates a child category with parent path prefix', async () => {
      const parent = makeCategory({ id: 'parent-id', path: '/parent-id/', depth: 0 });
      const created = makeCategory({ id: 'child-id', path: '/', depth: 0 });
      const updated = makeCategory({ id: 'child-id', path: '/parent-id/child-id/', depth: 1 });

      mockPrisma.category.findUnique.mockResolvedValueOnce(parent);
      mockPrisma.$transaction.mockImplementationOnce(
        async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
          const tx = {
            category: {
              create: jest.fn().mockResolvedValueOnce(created),
              update: jest.fn().mockResolvedValueOnce(updated),
            },
          };
          return fn(tx as unknown as typeof mockPrisma);
        },
      );
      mockRedis.del.mockResolvedValueOnce(1);

      const result = await service.create({
        name: { default: 'Phones' },
        slug: 'phones',
        parentId: 'parent-id',
      });

      expect(result.path).toBe('/parent-id/child-id/');
      expect(result.depth).toBe(1);
    });

    it('throws NotFoundException when parentId does not exist', async () => {
      mockPrisma.category.findUnique.mockResolvedValueOnce(null);

      await expect(
        service.create({ name: { default: 'X' }, slug: 'x', parentId: 'ghost-id' }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ── description sanitize (§3.5) ────────────────────────────────────────────

  describe('description sanitize', () => {
    // The admin authors this field with the SAME rich-text editor as a product
    // description, but this service stored it raw at all three write sites
    // while products.service.ts sanitised at four. Stored XSS, latent only
    // because nothing rendered it as HTML yet. All three sites are asserted:
    // missing the move-parent one leaves a bypass through any update that also
    // changes parentId.
    const DIRTY = { en: '<p>ok</p><img src=x onerror="window.__pwn=1">' };

    function expectScrubbed(description: unknown): void {
      const value = (description as Record<string, string>)['en'];
      expect(value).toContain('<p>ok</p>');
      expect(value).not.toContain('onerror');
      expect(value).not.toContain('<img');
    }

    it('scrubs the description on create', async () => {
      const created = makeCategory({ id: 'new-id', path: '/', depth: 0 });
      const create = jest.fn().mockResolvedValueOnce(created);
      mockPrisma.$transaction.mockImplementationOnce(
        async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
          const tx = {
            category: {
              create,
              update: jest
                .fn()
                .mockResolvedValueOnce(makeCategory({ id: 'new-id', path: '/new-id/' })),
            },
          };
          return fn(tx as unknown as typeof mockPrisma);
        },
      );
      mockRedis.del.mockResolvedValueOnce(1);

      await service.create({ name: { default: 'X' }, slug: 'x', description: DIRTY });

      expectScrubbed(create.mock.calls[0][0].data.description);
    });

    it('rejects a slug change to one owned by another category', async () => {
      const existing = makeCategory({ id: 'cat-1', parentId: null, slug: 'old' });
      mockPrisma.category.findUnique.mockResolvedValueOnce(existing);
      mockPrisma.category.findFirst.mockResolvedValueOnce(
        makeCategory({ id: 'cat-2', slug: 'taken' }),
      );

      await expect(service.update('cat-1', { slug: 'taken' })).rejects.toThrow(
        CategorySlugTakenException,
      );
      expect(mockPrisma.category.update).not.toHaveBeenCalled();
    });

    it('scrubs the description on a plain update', async () => {
      const existing = makeCategory({ id: 'cat-1', parentId: null });
      mockPrisma.category.findUnique.mockResolvedValueOnce(existing);
      mockPrisma.category.update.mockResolvedValueOnce(existing);
      mockRedis.del.mockResolvedValueOnce(1);

      await service.update('cat-1', { description: DIRTY });

      expectScrubbed(mockPrisma.category.update.mock.calls[0][0].data.description);
    });

    it('scrubs the description on the move-parent update', async () => {
      const existing = makeCategory({ id: 'cat-1', parentId: null, path: '/cat-1/', depth: 0 });
      const parent = makeCategory({ id: 'parent-id', path: '/parent-id/', depth: 0 });
      mockPrisma.category.findUnique
        .mockResolvedValueOnce(existing)
        .mockResolvedValueOnce(parent)
        .mockResolvedValueOnce(parent);

      const update = jest
        .fn()
        .mockResolvedValueOnce(makeCategory({ id: 'cat-1', parentId: 'parent-id' }));
      mockPrisma.$transaction.mockImplementationOnce(
        async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
          const tx = {
            category: { findMany: jest.fn().mockResolvedValueOnce([]), update },
          };
          return fn(tx as unknown as typeof mockPrisma);
        },
      );
      mockRedis.del.mockResolvedValueOnce(1);

      await service.update('cat-1', { parentId: 'parent-id', description: DIRTY });

      expectScrubbed(update.mock.calls[0][0].data.description);
    });
  });

  // ── delete ──────────────────────────────────────────────────────────────────

  describe('delete', () => {
    it('soft-deletes a category with no products', async () => {
      mockPrisma.category.findUnique.mockResolvedValueOnce(makeCategory());
      mockPrisma.productCategory.count.mockResolvedValueOnce(0);
      mockPrisma.category.update.mockResolvedValueOnce(makeCategory({ deletedAt: new Date() }));
      mockRedis.del.mockResolvedValueOnce(1);

      await expect(service.delete('cat-1')).resolves.toBeUndefined();

      expect(mockPrisma.category.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ deletedAt: expect.any(Date) }),
        }),
      );
    });

    it('throws ConflictException when products are assigned', async () => {
      mockPrisma.category.findUnique.mockResolvedValueOnce(makeCategory());
      mockPrisma.productCategory.count.mockResolvedValueOnce(3);

      await expect(service.delete('cat-1')).rejects.toThrow(CategoryHasProductsException);
    });

    it('throws NotFoundException for unknown id', async () => {
      mockPrisma.category.findUnique.mockResolvedValueOnce(null);

      await expect(service.delete('ghost')).rejects.toThrow(NotFoundException);
    });
  });

  // ── checkCircularRef (via update) ────────────────────────────────────────────

  describe('circular reference guard (§9.10)', () => {
    it('throws ConflictException when proposed parent is a descendant', async () => {
      // cat-1 wants to move to cat-2 (its child).
      // cat-2.path = '/cat-1/cat-2/' → cat-1 appears as a path segment.
      const parent = makeCategory({ id: 'cat-1', path: '/cat-1/', depth: 0 });
      const child = makeChildCategory({
        id: 'cat-2',
        path: '/cat-1/cat-2/',
        depth: 1,
        parentId: 'cat-1',
      });

      // findUnique for the category being moved
      mockPrisma.category.findUnique.mockResolvedValueOnce(parent);
      // findUnique for the proposed parent (the child)
      mockPrisma.category.findUnique.mockResolvedValueOnce(child);

      await expect(service.update('cat-1', { parentId: 'cat-2' })).rejects.toThrow(
        ConflictException,
      );
    });

    it('throws ConflictException when category is set as its own parent', async () => {
      const cat = makeCategory({ id: 'cat-1', path: '/cat-1/' });

      mockPrisma.category.findUnique.mockResolvedValueOnce(cat);
      // proposed parent is cat itself
      mockPrisma.category.findUnique.mockResolvedValueOnce(cat);

      await expect(service.update('cat-1', { parentId: 'cat-1' })).rejects.toThrow(
        ConflictException,
      );
    });
  });

  // ── reorder ─────────────────────────────────────────────────────────────────

  describe('reorder', () => {
    it('updates sortOrder for all items in a transaction', async () => {
      mockPrisma.$transaction.mockResolvedValueOnce([]);
      mockRedis.del.mockResolvedValueOnce(1);

      await service.reorder({
        items: [
          { id: 'cat-1', sortOrder: 0 },
          { id: 'cat-2', sortOrder: 1 },
        ],
      });

      expect(mockPrisma.$transaction).toHaveBeenCalled();
    });
  });

  // ── adminGetTree ─────────────────────────────────────────────────────────────

  describe('adminGetTree', () => {
    it('returns full tree with product counts, no cache', async () => {
      const root = makeCategory();
      const child = makeChildCategory();
      mockPrisma.category.findMany.mockResolvedValueOnce([root, child]);
      mockPrisma.productCategory.groupBy.mockResolvedValueOnce([
        { categoryId: 'cat-1', _count: { categoryId: 2 } },
      ]);

      const result = await service.adminGetTree();

      expect(mockRedis.get).not.toHaveBeenCalled();
      expect(result).toHaveLength(1);
      expect(result[0].productCount).toBe(2);
      expect(result[0].children[0].productCount).toBe(0);
    });
  });

  // ── getProductsInCategory ────────────────────────────────────────────────────

  describe('getProductsInCategory', () => {
    it('returns paginated products for a visible category', async () => {
      mockPrisma.category.findFirst.mockResolvedValueOnce(makeCategory());
      mockPrisma.productCategory.count.mockResolvedValueOnce(10);
      mockPrisma.productCategory.findMany.mockResolvedValueOnce([
        {
          product: {
            id: 'p-1',
            name: { default: 'iPhone' },
            slug: 'iphone',
            status: ProductStatus.ACTIVE,
            sortOrder: 0,
            publishedAt: new Date(),
            // Prisma always materialises included relations, even as empty
            // arrays. The service's primary-asset projection at
            // `categories.service.ts:227` indexes into `product.assets[0]`
            // assuming this invariant. Mirror it here so the mock is faithful.
            assets: [],
            variants: [],
          },
        },
      ]);

      const result = await service.getProductsInCategory('electronics', 1, 20);

      expect(result.meta.total).toBe(10);
      expect(result.data).toHaveLength(1);
    });

    it('throws NotFoundException for unknown or invisible category', async () => {
      mockPrisma.category.findFirst.mockResolvedValueOnce(null);

      await expect(service.getProductsInCategory('ghost')).rejects.toThrow(NotFoundException);
    });
  });

  // ── findByImageId (S18 — DR-07) ─────────────────────────────────────────────

  describe('findByImageId', () => {
    it('returns categories whose imageId matches', async () => {
      const cat = makeCategory({ imageId: 'asset-9' });
      mockPrisma.category.findMany.mockResolvedValueOnce([
        { id: cat.id, name: cat.name, slug: cat.slug },
      ]);

      const result = await service.findByImageId('asset-9');

      expect(result).toEqual([{ id: 'cat-1', name: cat.name, slug: 'electronics' }]);
      expect(mockPrisma.category.findMany).toHaveBeenCalledWith({
        where: { imageId: 'asset-9' },
        select: { id: true, name: true, slug: true },
      });
    });

    it('returns empty when no category references the asset', async () => {
      mockPrisma.category.findMany.mockResolvedValueOnce([]);
      const result = await service.findByImageId('asset-none');
      expect(result).toEqual([]);
    });
  });
});
