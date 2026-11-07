import { ConflictException } from '@nestjs/common';

/**
 * Create or update attempted to claim a `slug` already owned by another category.
 */
export class CategorySlugTakenException extends ConflictException {
  static readonly CODE = 'CATEGORY_SLUG_TAKEN' as const;

  constructor(slug: string) {
    super({
      error: {
        code: CategorySlugTakenException.CODE,
        message: `Slug "${slug}" is already taken`,
      },
    });
  }
}
