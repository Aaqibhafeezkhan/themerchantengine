import type { PaymentAction } from '@storefront-types';

/** Browser side effects, injected so the handler stays testable and SSR safe. */
export interface PaymentActionEnv {
  assign(url: string): void;
  submitForm(url: string, fields: Record<string, string>): void;
}

export type PaymentActionOutcome =
  | { kind: 'done' }
  | { kind: 'left' }
  | { kind: 'embedded'; action: Extract<PaymentAction, { type: 'embedded' }> };

/**
 * The one place the storefront reads `action.type`. It never looks at the
 * provider, so a new provider that returns one of these shapes needs no
 * change here.
 */
export function runPaymentAction(
  action: PaymentAction,
  env: PaymentActionEnv,
): PaymentActionOutcome {
  switch (action.type) {
    case 'none':
      return { kind: 'done' };
    case 'redirect':
      env.assign(action.url);
      return { kind: 'left' };
    case 'form_post':
      env.submitForm(action.url, action.fields);
      return { kind: 'left' };
    case 'embedded':
      return { kind: 'embedded', action };
  }
}

export const browserPaymentActionEnv: PaymentActionEnv = {
  assign: (url) => window.location.assign(url),
  submitForm: (url, fields) => {
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = url;
    for (const [name, value] of Object.entries(fields)) {
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = name;
      input.value = value;
      form.appendChild(input);
    }
    document.body.appendChild(form);
    form.submit();
  },
};
