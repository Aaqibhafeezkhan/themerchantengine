import { ConflictException } from '@nestjs/common';

/**
 * A moderator tried to approve a question that is already published.
 *
 * Approving again would repeat the audit entry and the APPROVED event for no
 * change, so the call is refused.
 */
export class QuestionAlreadyPublishedException extends ConflictException {
  static readonly CODE = 'QUESTION_ALREADY_PUBLISHED' as const;

  constructor() {
    super({
      error: {
        code: QuestionAlreadyPublishedException.CODE,
        message: 'This question is already published',
      },
    });
  }
}
