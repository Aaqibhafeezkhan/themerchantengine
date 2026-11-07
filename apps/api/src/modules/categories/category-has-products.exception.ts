import { ConflictException } from '@nestjs/common';

/**
 * Delete refused because products are still assigned to the category.
 */
export class CategoryHasProductsException extends ConflictException {
  static readonly CODE = 'CATEGORY_HAS_PRODUCTS' as const;

  constructor(productCount: number) {
    super({
      error: {
        code: CategoryHasProductsException.CODE,
        message: `Cannot delete category: ${productCount} product(s) are assigned to it. Reassign them first.`,
      },
    });
  }
}
