import { BadRequestException } from '@nestjs/common';

export type PromotionInvalidCode =
  | 'PROMOTION_PERCENT_OUT_OF_RANGE'
  | 'PROMOTION_DATES_INVALID'
  | 'PROMOTION_COUPON_CODE_INVALID';

const MESSAGES: Record<PromotionInvalidCode, string> = {
  PROMOTION_PERCENT_OUT_OF_RANGE: 'A percentage promotion value must be between 0 and 100',
  PROMOTION_DATES_INVALID: 'The end date must be after the start date',
  PROMOTION_COUPON_CODE_INVALID:
    'A coupon code uses letters, digits, dashes and underscores only, 3 to 32 characters',
};

/** Admin submitted a promotion whose fields contradict each other or break a format rule. */
export class PromotionInvalidException extends BadRequestException {
  constructor(code: PromotionInvalidCode) {
    super({ error: { code, message: MESSAGES[code] } });
  }
}
