import { randomUUID } from 'node:crypto';

import { expect, test } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';

import {
  STOREFRONT_API_BASE,
  apiHeaders,
  attachConsoleBaseline,
  authCookieHeader,
  describeEveryLocale,
  fixtureShippableAddress,
  reloadAndAssertClean,
  signInAsAdmin,
  signUpViaApi,
  waitForHydration,
  type AuthSession,
  type ConsoleBaseline,
  type StorefrontLocale,
} from './support';
import { getChromeStrings } from '../../storefront/src/i18n';

/**
 * Issue #45: the provider-agnostic card step, driven end to end with the
 * `fake_embedded` test provider. The API registers it only under
 * PAYMENT_FAKE_PROVIDERS, which the storefront e2e web server turns on.
 *
 * Happy path: the registered component renders, submit sends the shopper to
 * the order page, the order shows as paid. Unhappy path: the decline card
 * shows the localised declined message and the order stays payable.
 */

const PASSWORD = 'Fixture-Test-123!';
const DECLINE_CARD = '4000000000000002';

test.describe.configure({ mode: 'serial' });

describeEveryLocale('embedded card payment', (locale) => {
  let baseline: ConsoleBaseline;

  test.beforeEach(({ page }) => {
    baseline = attachConsoleBaseline(page);
  });

  test.afterEach(() => baseline.assertClean());

  test('a good card pays the order and the order page shows it paid', async ({ page, request }) => {
    const method = await createFakeMethod(request, locale);
    try {
      await reachEmbeddedCardStep(page, request, locale, method.code);
      await expect(page.getByTestId('fake-card-number')).toBeVisible({ timeout: 30_000 });

      await page.getByTestId('fake-pay').click();
      await page.waitForURL(/\/order-confirmation\//, { timeout: 60_000 });

      const strings = getChromeStrings(locale);
      const labels = strings.orderConfirmation.paymentStatus as Record<string, string>;
      await expect(page.getByTestId('order-confirmation-payment-status')).toHaveText(
        labels['CAPTURED'] ?? 'CAPTURED',
        { timeout: 60_000 },
      );

      await reloadAndAssertClean(page, new URL(page.url()).pathname, baseline);
      await expect(page.getByTestId('order-confirmation-payment-status')).toHaveText(
        labels['CAPTURED'] ?? 'CAPTURED',
      );
    } finally {
      await removeFakeMethod(request, method.id, locale);
    }
  });

  test('a declined card shows the localised error, then a good card pays', async ({
    page,
    request,
  }) => {
    const method = await createFakeMethod(request, locale);
    try {
      await reachEmbeddedCardStep(page, request, locale, method.code);
      await expect(page.getByTestId('fake-card-number')).toBeVisible({ timeout: 30_000 });
      await waitForHydration(page);

      await page.getByTestId('fake-card-number').fill(DECLINE_CARD);
      await page.getByTestId('fake-pay').click();

      const strings = getChromeStrings(locale);
      await expect(page.getByTestId('fake-error')).toHaveText(
        strings.checkout.errors.paymentCardDeclined,
      );
      await expect(page).toHaveURL(/\/checkout/);

      await page.getByTestId('fake-card-number').fill('4242424242424242');
      await page.getByTestId('fake-pay').click();
      await page.waitForURL(/\/order-confirmation\//, { timeout: 60_000 });

      const labels = strings.orderConfirmation.paymentStatus as Record<string, string>;
      await expect(page.getByTestId('order-confirmation-payment-status')).toHaveText(
        labels['CAPTURED'] ?? 'CAPTURED',
        { timeout: 60_000 },
      );

      await reloadAndAssertClean(page, new URL(page.url()).pathname, baseline);
    } finally {
      await removeFakeMethod(request, method.id, locale);
    }
  });
});

async function createFakeMethod(
  request: APIRequestContext,
  locale: StorefrontLocale,
): Promise<{ id: string; code: string }> {
  const admin = await signInAsAdmin(request);
  const code = `fake_card_${randomUUID().slice(0, 8)}`;
  const res = await request.post(`${STOREFRONT_API_BASE}/v1/admin/payment-methods`, {
    headers: apiHeaders(admin, locale as 'fr' | 'en'),
    data: {
      code,
      name: { default: 'Fake card' },
      provider: 'fake_embedded',
      isActive: true,
      sortOrder: 0,
    },
  });
  expect(
    res.status(),
    `POST /v1/admin/payment-methods must create the fake_embedded method: ${await res.text()}`,
  ).toBe(201);
  const body = (await res.json()) as { data?: { id?: string } };
  expect(body.data?.id).toBeTruthy();
  return { id: body.data?.id as string, code };
}

async function removeFakeMethod(
  request: APIRequestContext,
  id: string,
  locale: StorefrontLocale,
): Promise<void> {
  // Soft delete keeps the shared test DB free of an active fake method that would change the default method of other suites.
  // Best effort: after a timeout the request context is closed, and a throw here would hide the real failure.
  try {
    const admin = await signInAsAdmin(request);
    await request.delete(`${STOREFRONT_API_BASE}/v1/admin/payment-methods/${id}`, {
      headers: apiHeaders(admin, locale as 'fr' | 'en'),
    });
  } catch {
    // Nothing more to do; the method code is unique per run.
  }
}

/** Signs up, fills the cart, walks the checkout steps and places the order. */
async function reachEmbeddedCardStep(
  page: Page,
  request: APIRequestContext,
  locale: StorefrontLocale,
  methodCode: string,
): Promise<void> {
  const session = await signUpViaApi(request, {
    email: `fake-card+${randomUUID().slice(0, 8)}@fixture.test`,
    password: PASSWORD,
    firstName: 'Fake',
    lastName: 'Card',
  });
  const headers = {
    Cookie: authCookieHeader(session),
    'X-Requested-With': 'XMLHttpRequest',
    'Accept-Language': locale,
  };
  await createDefaultAddress(request, session, locale);
  await addFirstVariantToCart(request, headers, locale);

  await page.context().addCookies(session.cookies);
  await page.goto(`/${locale}/checkout`);
  await expect(page.getByTestId('checkout-page')).toBeVisible({ timeout: 60_000 });
  await waitForHydration(page);

  for (const step of [1, 2, 3]) {
    await page
      .locator(`[data-testid="checkout-step-shell"][data-step="${step}"] .step-actions button`)
      .click();
  }

  await page.getByTestId(`payment-method-option-${methodCode}`).click();
  await page
    .locator('[data-testid="checkout-step-shell"][data-step="4"] .step-actions button')
    .click();
  await page.getByTestId('place-order-accept-terms').check();
  await page.locator('[data-testid="place-order-form"] button[type="submit"]').click();
  await expect(page.getByTestId('checkout-embedded-payment')).toBeVisible({ timeout: 60_000 });
}

async function createDefaultAddress(
  request: APIRequestContext,
  session: AuthSession,
  locale: string,
): Promise<void> {
  const res = await request.post(`${STOREFRONT_API_BASE}/v1/users/me/addresses`, {
    headers: {
      Cookie: authCookieHeader(session),
      'X-Requested-With': 'XMLHttpRequest',
      'Accept-Language': locale,
    },
    data: {
      label: 'Home',
      ...fixtureShippableAddress({ fullName: 'Fake Card' }),
      isDefaultShipping: true,
      isDefaultBilling: true,
    },
  });
  expect(res.status(), 'POST /v1/users/me/addresses must create the checkout address').toBe(201);
}

/** First seeded variant that is in stock, so the add cannot be refused. */
async function addFirstVariantToCart(
  request: APIRequestContext,
  headers: Record<string, string>,
  locale: string,
): Promise<void> {
  const res = await request.get(`${STOREFRONT_API_BASE}/v1/products?pageSize=24`, {
    headers: { 'Accept-Language': locale },
  });
  expect(res.status(), 'GET /v1/products must answer 200 for the seeded catalogue').toBe(200);
  const body = (await res.json()) as { data?: unknown };
  const rows: unknown[] = Array.isArray(body.data) ? body.data : [];

  let fallback: string | null = null;
  let inStock: string | null = null;
  for (const row of rows) {
    const variants = (row as { variants?: unknown }).variants;
    for (const entry of Array.isArray(variants) ? variants : []) {
      const variant = entry as { id?: unknown; availability?: unknown };
      if (typeof variant.id !== 'string') continue;
      fallback ??= variant.id;
      if (variant.availability === 'IN_STOCK') {
        inStock = variant.id;
        break;
      }
    }
    if (inStock) break;
  }
  const variantId = inStock ?? fallback;
  expect(variantId, 'the seeded catalogue must expose a purchasable variant').not.toBeNull();

  const add = await request.post(`${STOREFRONT_API_BASE}/v1/cart/items`, {
    headers,
    data: { variantId, quantity: 1 },
  });
  expect([200, 201], 'POST /v1/cart/items must succeed').toContain(add.status());
}
