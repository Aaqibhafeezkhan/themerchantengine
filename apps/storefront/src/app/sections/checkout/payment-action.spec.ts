import { describe, expect, it, vi } from 'vitest';
import { runPaymentAction, type PaymentActionEnv } from './payment-action';

function env(): PaymentActionEnv {
  return { assign: vi.fn(), submitForm: vi.fn() };
}

describe('runPaymentAction', () => {
  it('goes straight to the confirmation for a none action', () => {
    const e = env();
    expect(runPaymentAction({ type: 'none' }, e)).toEqual({ kind: 'done' });
    expect(e.assign).not.toHaveBeenCalled();
    expect(e.submitForm).not.toHaveBeenCalled();
  });

  it('leaves the page for a redirect action', () => {
    const e = env();
    expect(runPaymentAction({ type: 'redirect', url: 'https://pay.example/x' }, e)).toEqual({
      kind: 'left',
    });
    expect(e.assign).toHaveBeenCalledWith('https://pay.example/x');
  });

  it('posts the fields for a form_post action', () => {
    const e = env();
    const fields = { a: '1' };
    expect(
      runPaymentAction({ type: 'form_post', url: 'https://pay.example/p', fields }, e),
    ).toEqual({ kind: 'left' });
    expect(e.submitForm).toHaveBeenCalledWith('https://pay.example/p', fields);
  });

  it('hands an embedded action back to the page, which renders the provider component', () => {
    const e = env();
    const action = { type: 'embedded', clientToken: 'tok' } as const;
    expect(runPaymentAction(action, e)).toEqual({ kind: 'embedded', action });
    expect(e.assign).not.toHaveBeenCalled();
  });
});
