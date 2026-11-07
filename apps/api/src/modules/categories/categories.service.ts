import { ConflictException, Inject, Injectable, Logger } from '@nestjs/common';
import { CategoryNotFoundException } from './category-not-found.exception';
import { CategoryHasProductsException } from './category-has-products.exception';
import { CategoryParentNotFoundException } from './category-parent-not-found.exception';
import { CategorySlugTakenException } from './category-slug-taken.exception';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type Redis from 'ioredis';
import { ProductStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { PaginatedResult } from '@common/interceptors/api-response.interceptor';
import { tryPickVariantUrl } from '@common/asset-variants';
import { sanitizeTranslatableHtml } from '@common/utils';
import {
  CATEGORIES_REDIS_CLIENT,
  CATEGORY_SLUG_CHANGED_EVENT,
  CATEGORY_TREE_CACHE_KEY,
  CATEGORY_TREE_TTL_SECONDS,
} from './categories.constants';
import type { CreateCategoryAdminDto } from './dto/create-category.dto';
import type { UpdateCategoryAdminDto } from './dto/update-category.dto';
import type { ReorderCategoriesAdminDto } from './dto/reorder-categories.dto';

// ── Types ──────────────────────────────────────────────────────────────────────

/**
 * Prisma select for the `Category.image` relation. Only the fields
 * `tryPickVariantUrl` reads, so the public payload never carries the row.
 */
const CATEGORY_IMAGE_SELECT = {
  select: { id: true, status: true, variants: true },
} as const;

type CategoryImageRow = {
  id: string;
  status: 'PENDING' | 'PROCESSING' | 'READY' | 'FAILED';
  variants: unknown;
} | null;

/**
 * Resolves a category's `image` relation to the public `card`-intent URL plus
 * its responsive srcset, and drops the relation itself.
 *
 * Uses the pure `tryPickVariantUrl` helper rather than injecting
 * `AssetsService`: `AssetsModule` already imports `CategoriesModule` and
 * `AssetsService` injects `CategoriesService` for the DR-07 delete guard, so
 * the DI route would be a module cycle. `getProductsInCategory` in this file
 * resolves product assets the same way.
 *
 * `tryPickVariantUrl` returns null for a non-READY or malformed asset, which
 * is the wanted degradation: the storefront falls back to its drawn glyph.
 */
function withImageUrl<T extends { image?: CategoryImageRow }>(row: T) {
  const { image, ...rest } = row;
  const variant = image ? tryPickVariantUrl(image, 'card') : null;
  return { ...rest, imageUrl: variant?.url ?? null, imageVariants: variant?.srcset ?? [] };
}

type RawCategory = {
  id: string;
  name: unknown;
  slug: string;
  description: unknown;
  parentId: string | null;
  imageId: string | null;
  sortOrder: number;
  isVisible: boolean;
  path: string;
  depth: number;
  metaTitle: unknown;
  metaDescription: unknown;
  createdAt: Date;
  updatedAt: Date;
};

export type CategoryTreeNode = RawCategory & {
  children: CategoryTreeNode[];
  productCount?: number;
  /** `card`-intent URL resolved from `imageId`, null when unresolvable. */
  imageUrl?: string | null;
  /** Responsive srcset for `imageUrl`, empty when unresolvable. */
  imageVariants?: { url: string; width: number; format: string }[];
};

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Builds a nested tree from a flat category list.
 * Categories must be sorted by depth ascending before calling.
 */
function buildTree(categories: (RawCategory & { productCount?: number })[]): CategoryTreeNode[] {
  const map = new Map<string, CategoryTreeNode>();

  for (const cat of categories) {
    map.set(cat.id, { ...cat, children: [] });
  }

  const roots: CategoryTreeNode[] = [];
  for (const cat of categories) {
    const node = map.get(cat.id)!;
    if (cat.parentId && map.has(cat.parentId)) {
      map.get(cat.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Scrub admin-authored rich text before it is stored.
 *
 * The admin authors a category description with the SAME
 * TranslatableRichTextComponent as a product description, but this service
 * stored it raw at all three write sites while products.service.ts sanitised
 * at four. `grep -c sanitize` returned 0 here and 5 there.
 *
 * That was a stored-XSS hole, latent only because nothing rendered the value as
 * HTML yet. It is closed in the same change that starts rendering product
 * descriptions with [innerHTML], because that change makes the pattern
 * copy-pasteable onto this field.
 */
function sanitizeDescription(value: unknown): object | undefined {
  if (value === undefined || value === null) return undefined;
  return sanitizeTranslatableHtml(value as Record<string, string>) as object;
}

@Injectable()
export class CategoriesService {
  private readonly logger = new Logger(CategoriesService.name);
  private readonly pageSize: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly events: EventEmitter2,
    @Inject(CATEGORIES_REDIS_CLIENT) private readonly redis: Redis,
  ) {
    this.pageSize = this.config.get<number>('DEFAULT_PAGE_SIZE', 20);
  }

  // ── Storefront ──────────────────────────────────────────────────────────────

  /**
   * Returns the full category tree (only visible, non-deleted categories).
   * Cached in Redis for 1 hour; invalidated on any mutation.
   */
  async getTree(): Promise<CategoryTreeNode[]> {
    const cached = await this.tryGetCache(CATEGORY_TREE_CACHE_KEY);
    if (cached) return cached as CategoryTreeNode[];

    const categories = await this.prisma.category.findMany({
      where: { isVisible: true },
      // `slug` is the tiebreak, not decoration. Every seeded category shares
      // `sortOrder: 0`, so (depth, sortOrder) alone leaves the order to the
      // physical row order, and the nav reshuffles between page loads for a
      // real customer as readily as it did between two screenshot runs.
      orderBy: [{ depth: 'asc' }, { sortOrder: 'asc' }, { slug: 'asc' }],
      include: { image: CATEGORY_IMAGE_SELECT },
    });

    const tree = buildTree(categories.map(withImageUrl) as RawCategory[]);
    await this.trySetCache(CATEGORY_TREE_CACHE_KEY, tree);
    return tree;
  }

  /**
   * Returns a single visible category by slug with its total product count.
   */
  async getBySlug(slug: string): Promise<CategoryTreeNode & { productCount: number }> {
    const category = await this.prisma.category.findFirst({
      where: { slug, isVisible: true },
      include: { image: CATEGORY_IMAGE_SELECT },
    });

    if (!category) throw new CategoryNotFoundException();

    const productCount = await this.prisma.productCategory.count({
      where: { categoryId: category.id },
    });

    return { ...(withImageUrl(category) as RawCategory), children: [], productCount };
  }

  /**
   * Returns products belonging to a category (by slug), paginated.
   * Storefront only returns ACTIVE products.
   *
   * Note: will delegate to ProductsService once that module is built.
   */
  async getProductsInCategory(
    slug: string,
    page = 1,
    pageSize = this.pageSize,
  ): Promise<PaginatedResult<unknown>> {
    const category = await this.prisma.category.findFirst({
      where: { slug, isVisible: true },
    });

    if (!category) throw new CategoryNotFoundException();

    const skip = (page - 1) * pageSize;

    // Mirror `ProductsService.listProducts` selection so storefront cards
    // rendered from this endpoint carry the same `primaryAsset` + `variants`
    // shape they get from `/v1/products`. Without this, home-rail cards that
    // pull through `/v1/categories/:slug/products` show the no-image fallback
    // and a zero price even when the product has assets and variants in
    // the DB.
    const [total, productCategories] = await Promise.all([
      this.prisma.productCategory.count({
        where: {
          categoryId: category.id,
          product: { status: ProductStatus.ACTIVE },
        },
      }),
      this.prisma.productCategory.findMany({
        where: {
          categoryId: category.id,
          product: { status: ProductStatus.ACTIVE },
        },
        include: {
          product: {
            select: {
              id: true,
              name: true,
              slug: true,
              shortDescription: true,
              status: true,
              brand: true,
              tags: true,
              isFeatured: true,
              sortOrder: true,
              publishedAt: true,
              assets: {
                where: { isPrimary: true },
                select: {
                  assetId: true,
                  sortOrder: true,
                  isPrimary: true,
                  asset: {
                    select: {
                      id: true,
                      url: true,
                      type: true,
                      alt: true,
                      status: true,
                      variants: true,
                    },
                  },
                },
                take: 1,
              },
              variants: {
                where: { isActive: true, deletedAt: null },
                select: {
                  id: true,
                  sku: true,
                  price: true,
                  compareAtPrice: true,
                  isDefault: true,
                },
                orderBy: [{ isDefault: 'desc' }, { price: 'asc' }, { id: 'asc' }],
              },
            },
          },
        },
        // Total order, because this one is paginated: every product shares
        // `sortOrder: 0`, and page 2 of an unspecified order can repeat a row
        // it already showed or skip one it never will.
        orderBy: [{ product: { sortOrder: 'asc' } }, { productId: 'asc' }],
        skip,
        take: pageSize,
      }),
    ]);

    type ListedAsset = {
      assetId: string;
      sortOrder: number;
      isPrimary: boolean;
      asset: {
        id: string;
        url: string;
        type: string;
        alt: unknown;
        status: 'PENDING' | 'PROCESSING' | 'READY' | 'FAILED';
        variants: unknown;
      } | null;
    };

    const data = productCategories.map((pc) => {
      const product = pc.product as typeof pc.product & { assets: ListedAsset[] };
      const first = product.assets[0];
      const variant = first?.asset ? tryPickVariantUrl(first.asset, 'card') : null;
      const primaryAsset = first?.asset
        ? {
            id: first.asset.id,
            assetId: first.assetId,
            url: variant?.url ?? '',
            type: first.asset.type,
            altText: first.asset.alt,
            isPrimary: first.isPrimary,
            sortOrder: first.sortOrder,
            assetVariants: variant?.srcset ?? [],
          }
        : null;
      return { ...product, primaryAsset };
    });

    return {
      data,
      meta: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
    };
  }

  // ── Admin ───────────────────────────────────────────────────────────────────

  /**
   * Which of `ids` name a real category. Lets another module validate a
   * caller-supplied category reference without reading the Category table
   * itself (§3.1).
   *
   * Deliberately counts soft-deleted rows as existing. `ProductCategory.category`
   * is `onDelete: Restrict` (schema.prisma:608), so soft-deleting a category
   * leaves its product assignments in place. Treating those ids as unknown
   * would make an unrelated save of a product that still carries one fail with
   * a validation error the operator cannot act on.
   */
  async findExistingIds(ids: readonly string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await this.prisma.category.findMany({
      where: {
        id: { in: [...new Set(ids)] },
        // Documented soft-delete bypass (prisma.service.ts:5-10): naming
        // `deletedAt` opts this query out of the automatic `deletedAt: null`
        // filter. `undefined` adds no condition of its own, so both live and
        // soft-deleted rows count as existing.
        deletedAt: undefined,
      },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  /**
   * Returns the full category tree (all categories, including hidden).
   * Always fresh — no cache.
   */
  async adminGetTree(): Promise<CategoryTreeNode[]> {
    const categories = await this.prisma.category.findMany({
      orderBy: [{ depth: 'asc' }, { sortOrder: 'asc' }, { slug: 'asc' }],
    });

    const counts = await this.prisma.productCategory.groupBy({
      by: ['categoryId'],
      _count: { categoryId: true },
    });

    const countMap = new Map(counts.map((c) => [c.categoryId, c._count.categoryId]));

    const withCounts = (categories as RawCategory[]).map((cat) => ({
      ...cat,
      productCount: countMap.get(cat.id) ?? 0,
    }));

    return buildTree(withCounts);
  }

  /**
   * Creates a new category. Computes `path` and `depth` from `parentId`.
   * Uses a two-step transaction: create → update path with generated ID.
   */
  async create(dto: CreateCategoryAdminDto): Promise<RawCategory> {
    await this.assertSlugFree(dto.slug);

    let parent: RawCategory | null = null;
    if (dto.parentId) {
      parent = (await this.prisma.category.findUnique({
        where: { id: dto.parentId },
      })) as RawCategory | null;

      if (!parent) throw new CategoryParentNotFoundException();
    }

    const category = await this.prisma.$transaction(async (tx) => {
      // Step 1 — create with placeholder path; Prisma generates the cuid id
      const created = await tx.category.create({
        data: {
          name: dto.name as object,
          slug: dto.slug,
          description: sanitizeDescription(dto.description),
          parentId: dto.parentId ?? null,
          imageId: dto.imageId ?? null,
          sortOrder: dto.sortOrder ?? 0,
          isVisible: dto.isVisible ?? true,
          metaTitle: dto.metaTitle as object | undefined,
          metaDescription: dto.metaDescription as object | undefined,
          path: '/',
          depth: 0,
        },
      });

      // Step 2 — set the correct materialized path now that we have the id
      const path = parent ? `${parent.path}${created.id}/` : `/${created.id}/`;
      const depth = parent ? parent.depth + 1 : 0;

      return tx.category.update({
        where: { id: created.id },
        data: { path, depth },
      });
    });

    await this.invalidateCache();
    return category as RawCategory;
  }

  /**
   * Updates a category.
   * When `parentId` changes:
   *   1. Validates no circular reference (§9.10).
   *   2. Recomputes path/depth for this category and all descendants.
   */
  async update(id: string, dto: UpdateCategoryAdminDto): Promise<RawCategory> {
    const category = (await this.prisma.category.findUnique({
      where: { id },
    })) as RawCategory | null;

    if (!category) throw new CategoryNotFoundException();

    if (dto.slug !== undefined && dto.slug !== category.slug) {
      await this.assertSlugFree(dto.slug, id);
    }

    const isMoving = 'parentId' in dto && dto.parentId !== category.parentId;

    if (isMoving) {
      if (dto.parentId) {
        await this.checkCircularRef(id, dto.parentId);
      }

      const updated = await this.moveCategory(category, dto);
      await this.invalidateCache();
      return updated;
    }

    const slugChanged = dto.slug !== undefined && dto.slug !== category.slug;
    const oldSlug = category.slug;

    // Simple field update (no parent change)
    const updated = await this.prisma.category.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name as object }),
        ...(dto.slug !== undefined && { slug: dto.slug }),
        ...(dto.description !== undefined && { description: sanitizeDescription(dto.description) }),
        ...(dto.imageId !== undefined && { imageId: dto.imageId }),
        ...(dto.sortOrder !== undefined && { sortOrder: dto.sortOrder }),
        ...(dto.isVisible !== undefined && { isVisible: dto.isVisible }),
        ...(dto.metaTitle !== undefined && { metaTitle: dto.metaTitle as object }),
        ...(dto.metaDescription !== undefined && {
          metaDescription: dto.metaDescription as object,
        }),
      },
    });

    await this.invalidateCache();

    if (slugChanged) {
      this.events.emit(CATEGORY_SLUG_CHANGED_EVENT, {
        categoryId: id,
        oldSlug,
        newSlug: dto.slug,
      });
    }

    return updated as RawCategory;
  }

  private async assertSlugFree(slug: string, exceptId?: string): Promise<void> {
    const clash = await this.prisma.category.findFirst({
      where: { slug, ...(exceptId && { id: { not: exceptId } }) },
      select: { id: true },
    });
    if (clash) throw new CategorySlugTakenException(slug);
  }

  /**
   * Soft-deletes a category.
   * Blocked if any products are associated with this category (§9.3).
   */
  async delete(id: string): Promise<void> {
    const category = await this.prisma.category.findUnique({ where: { id } });
    if (!category) throw new CategoryNotFoundException();

    const productCount = await this.prisma.productCategory.count({
      where: { categoryId: id },
    });

    if (productCount > 0) {
      throw new CategoryHasProductsException(productCount);
    }

    await this.prisma.category.update({
      where: { id },
      data: { deletedAt: new Date() },
    });

    await this.invalidateCache();
  }

  /**
   * Updates `sortOrder` for a set of sibling categories in a single transaction.
   */
  async reorder(dto: ReorderCategoriesAdminDto): Promise<void> {
    await this.prisma.$transaction(
      dto.items.map((item) =>
        this.prisma.category.update({
          where: { id: item.id },
          data: { sortOrder: item.sortOrder },
        }),
      ),
    );

    await this.invalidateCache();
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Circular reference guard (§9.10).
   * Rejects if `categoryId` appears as any path segment of the proposed parent.
   */
  private async checkCircularRef(categoryId: string, newParentId: string): Promise<void> {
    const newParent = (await this.prisma.category.findUnique({
      where: { id: newParentId },
    })) as RawCategory | null;

    if (!newParent) throw new CategoryParentNotFoundException();

    // path format: "/seg1/seg2/.../parentId/" — split and filter empty strings
    const pathSegments = newParent.path.split('/').filter(Boolean);

    if (pathSegments.includes(categoryId) || newParent.id === categoryId) {
      throw new ConflictException({
        error: {
          code: 'CATEGORY_DESCENDANT_AS_PARENT',
          message: 'Cannot set a descendant as parent',
        },
      });
    }
  }

  /**
   * Moves a category to a new parent (or to root when dto.parentId is null/undefined).
   * Updates the category's path/depth and propagates the change to all descendants.
   */
  private async moveCategory(
    category: RawCategory,
    dto: UpdateCategoryAdminDto,
  ): Promise<RawCategory> {
    let newParent: RawCategory | null = null;
    if (dto.parentId) {
      newParent = (await this.prisma.category.findUnique({
        where: { id: dto.parentId },
      })) as RawCategory | null;

      if (!newParent) throw new CategoryParentNotFoundException();
    }

    const oldPath = category.path;
    const newPath = newParent ? `${newParent.path}${category.id}/` : `/${category.id}/`;
    const newDepth = newParent ? newParent.depth + 1 : 0;
    const depthDelta = newDepth - category.depth;

    return this.prisma.$transaction(async (tx) => {
      // Find all descendants before updating the category itself
      const descendants = (await tx.category.findMany({
        where: {
          path: { startsWith: oldPath },
          id: { not: category.id },
        },
      })) as RawCategory[];

      // Update the moved category
      const updated = await tx.category.update({
        where: { id: category.id },
        data: {
          parentId: dto.parentId ?? null,
          path: newPath,
          depth: newDepth,
          ...(dto.name !== undefined && { name: dto.name as object }),
          ...(dto.slug !== undefined && { slug: dto.slug }),
          ...(dto.description !== undefined && {
            description: sanitizeDescription(dto.description),
          }),
          ...(dto.imageId !== undefined && { imageId: dto.imageId }),
          ...(dto.sortOrder !== undefined && { sortOrder: dto.sortOrder }),
          ...(dto.isVisible !== undefined && { isVisible: dto.isVisible }),
          ...(dto.metaTitle !== undefined && { metaTitle: dto.metaTitle as object }),
          ...(dto.metaDescription !== undefined && {
            metaDescription: dto.metaDescription as object,
          }),
        },
      });

      // Propagate path/depth change to all descendants
      for (const descendant of descendants) {
        const descendantNewPath = descendant.path.replace(oldPath, newPath);
        await tx.category.update({
          where: { id: descendant.id },
          data: {
            path: descendantNewPath,
            depth: descendant.depth + depthDelta,
          },
        });
      }

      return updated as RawCategory;
    });
  }

  private async tryGetCache(key: string): Promise<unknown | null> {
    try {
      const value = await this.redis.get(key);
      return value ? (JSON.parse(value) as unknown) : null;
    } catch (err) {
      this.logger.warn(`Cache GET failed for key "${key}": ${(err as Error).message}`);
      return null;
    }
  }

  private async trySetCache(key: string, value: unknown): Promise<void> {
    try {
      await this.redis.set(key, JSON.stringify(value), 'EX', CATEGORY_TREE_TTL_SECONDS);
    } catch (err) {
      this.logger.warn(`Cache SET failed for key "${key}": ${(err as Error).message}`);
    }
  }

  private async invalidateCache(): Promise<void> {
    try {
      await this.redis.del(CATEGORY_TREE_CACHE_KEY);
    } catch (err) {
      this.logger.warn(`Cache invalidation failed: ${(err as Error).message}`);
    }
  }

  // ── Asset references (S18 — DR-07) ────────────────────────────────────────
  /**
   * Returns categories whose `imageId` points at the given asset. Used by
   * `AssetsService.getReferences()` to support the DR-07 hard-delete guard.
   * Soft-delete filter applies via the global Prisma middleware.
   * Modular-isolation gate per constitution §3.1.
   */
  async findByImageId(
    assetId: string,
  ): Promise<Array<{ id: string; name: unknown; slug: string }>> {
    return this.prisma.category.findMany({
      where: { imageId: assetId },
      select: { id: true, name: true, slug: true },
    });
  }
}
