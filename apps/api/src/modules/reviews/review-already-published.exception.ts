import { ConflictException } from '@nestjs/common';

/**
 * A moderator tried to approve a review that is already published.
 *
 * Approving again would repeat the audit entry and the APPROVED event
 * (rating recompute and notifications) for no change, so the call is refused.
 */
export class ReviewAlreadyPublishedException extends ConflictException {
  static readonly CODE = 'REVIEW_ALREADY_PUBLISHED' as const;

  constructor() {
    super({
      error: {
        code: ReviewAlreadyPublishedException.CODE,
        message: 'This review is already published',
      },
    });
  }
}
