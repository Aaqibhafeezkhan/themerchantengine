---
title: Checkout and orders
description: "Read the checkout settings, quote shipping for an address, place a cash-on-delivery order with an idempotency key and retry it safely, read the order back as a guest or a customer, track it, cancel it, fetch its invoice, and map every error code to text in each locale."
primaryQuery: place an order rest api idempotency key guest checkout shipping rates error codes
updated: 2026-11-07
schema: TechArticle
---

This step turns a cart into an order. A storefront reads the public checkout settings, quotes shipping for the address the customer typed, sends one `POST /v1/orders` with an `X-Idempotency-Key`, and repeats that exact request, key included, whenever it has to retry. That is obligation six of [the contract](./index.md#the-ten-obligations). The API answers every refusal with a stable `code` and an English `message`; the storefront owns the text it shows for each code in each locale, which is obligation seven. The rules behind the key are on the conventions page under [Idempotency keys](../customize/conventions.md#idempotency-keys); this page shows them running.

Every example below ran against a local engine serving the `demo` fixture (locales `en` and `fr`, EUR, a flat 10,00 € rate for France, cash on delivery as the only tender, guest checkout on). The public shape of every route is `https://api.shop.example/api/v1/...`.

## The request

Checkout is four calls. The first two are public reads, the third is the order, the fourth reads it back.

### 1. Checkout settings

`GET /v1/checkout/settings` is public and needs no cookie. It returns whether a guest may check out, which fields the operator requires, and the tenders the store offers. It is the only way a storefront learns the payment methods: there is no customer route on the payments module, and the `code` you send back on the order must come from this list. The route is `Cache-Control: no-store` on purpose (an operator flip has to apply on the next load), so read it when the checkout page opens, not at build time.

```bash
curl https://api.shop.example/api/v1/checkout/settings -H 'Accept-Language: en'
```

### 2. Shipping rates

`POST /v1/shipping/rates` is public too. Send the destination and the cart lines; the answer is the list of methods that serve that address, with the price for this cart. The `methodId` is what the order carries as `shippingMethodId`. An address no zone covers returns an empty list, not an error, so the checkout page can say "we do not ship there" before the order is attempted. The full body is on [the shipping reference](../reference/storefront-api/shipping.md).

```bash
curl -X POST https://api.shop.example/api/v1/shipping/rates \
  -H 'Content-Type: application/json' -H 'Accept-Language: en' \
  -d '{"country":"FR","postalCode":"75002","items":[{"weight":0,"quantity":1}],"subtotal":89}'
```

### 3. The order

`POST /v1/orders` takes the cart the caller owns and turns it into an order. What identifies the caller is a cookie, never the body:

- A guest is the `sessionId` cookie the cart set (see [Cart](./04-cart.md)). The body must also carry `guestEmail` and an inline `shippingAddress`.
- A signed-in customer is the Better Auth session cookie (see [Auth and session](./02-auth-and-session.md)). The body carries `shippingAddressId` for a saved address, or an inline `shippingAddress`; `guestEmail` is ignored on this path by design.

The headers that matter:

- `X-Idempotency-Key`: required, a UUID v4, one per checkout attempt. Generate it once when the checkout page is ready and keep it until the order succeeds. Send the same key with the same body on every retry.
- `Accept-Language`: the locale the line labels, the shipping method name and the payment method name are snapshotted in. An order placed under `fr` keeps `Livraison standard` for good; the product names in the response stay translatable and follow the reader's locale.
- `Content-Type: application/json`, and `credentials: 'include'` from a browser so both cookies travel.

The body, from `apps/api/src/modules/orders/dto/create-order.dto.ts`. Every field is optional at the validation layer; the service decides what a guest and a customer must send. Optional means omitted, not sent empty: the validators run on any value that is present, so a field the customer left blank is left out of the JSON, never sent as `""` or `null`. A guest body with `"guestEmail": ""` answers `VALIDATION_ERROR` (`guestEmail must be an email`), while the same body without the key answers `ORDER_GUEST_EMAIL_REQUIRED`, the code your form should be handling; both are pasted under Error codes. The other way round is worse: `"shippingMethodId": ""` passes the string check and the order is placed with the zone's default method, so a blank select must not reach the body.

- `guestEmail`: the contact address of a guest order. Normalised to lower case; it is also the secret the tracking route checks.
- `shippingAddress`: `fullName`, `phone`, `addressLine1`, `city`, `country` (two upper-case letters), optional `addressLine2`, `state`, `postalCode`. `shippingAddressId` instead, for a customer's saved address.
- `billingAddress` or `billingAddressId`: optional, defaults to the shipping address.
- `shippingMethodId`: a `methodId` from the rates call. Omitted, the zone's default method is used.
- `paymentMethodCode`: a `code` from the settings call. Optional when the store offers exactly one tender, required when it offers several.
- `couponCode`, `giftCardCode`: optional. A coupon that no longer applies is dropped silently; a gift card named here that is invalid refuses the order.
- `notes`: free text for the operator.

The service validates in this order, and stops at the first failure: the guest gate (guest checkout enabled, email, address, cart cookie), the idempotency key, the cart (not empty, every line in stock), the address, the shipping method, the payment method, then the coupon and the gift card. Stock is decremented atomically per line at the end; a line that lost its stock in between answers `ORDER_INSUFFICIENT_STOCK` and every earlier decrement is rolled back.

```bash
KEY=$(uuidgen)
curl -X POST https://api.shop.example/api/v1/orders \
  -b jar -c jar \
  -H 'Content-Type: application/json' -H 'Accept-Language: en' \
  -H "X-Idempotency-Key: $KEY" \
  -d '{"guestEmail":"w-checkout@l5.example","shippingAddress":{"fullName":"Camille Martin","phone":"+33612345678","addressLine1":"10 rue de l Exemple","city":"Paris","postalCode":"75002","country":"FR"},"shippingMethodId":"sm-domestic-standard","paymentMethodCode":"cod"}'
```

The same call from code, in Node 22 or a browser. The key is created once, outside the function, so a retry reuses it:

```js
const API = 'https://api.shop.example/api';

// Once per checkout attempt. Keep it with the form until the order succeeds.
const idempotencyKey = crypto.randomUUID();

async function placeOrder(body, locale, cookieHeader) {
  const res = await fetch(`${API}/v1/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept-Language': locale,
      'X-Idempotency-Key': idempotencyKey,
      // Server side: forward the customer's cookies. In a browser this header
      // cannot be set and credentials: 'include' sends them instead.
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    },
    credentials: 'include',
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) {
    const err = new Error(json.error.message);
    err.code = json.error.code;
    err.status = res.status;
    throw err;
  }
  return json.data;
}

// A network timeout, a double click, a 5xx: call placeOrder again with the
// same body. The API answers the same order, not a second one.
```

### 4. Reading the order back

- `GET /v1/orders/{id}` serves the confirmation page. A guest reaches it with the same `sessionId` cookie that placed the order; a customer with the session cookie. Anyone else, and any id that does not exist, gets the same `404 ORDER_NOT_FOUND`, so the route is not an existence oracle. A signed-in customer asking for another customer's order is the one caller told `403 ORDER_NOT_YOURS`.
- `POST /v1/orders/track` with `{ orderNumber, email }` is public and needs no cookie: the email on file is the shared secret. It serves the "where is my order" page for guests who closed the browser. A POST, not a GET with a query string, so the email never lands in an access log.
- `GET /v1/orders` (the customer's list), `POST /v1/orders/{id}/cancel`, `GET /v1/orders/{id}/invoice` and `GET /v1/orders/{id}/invoice/pdf` need the session cookie and belong to the signed-in customer; a guest gets `401 AUTH_UNAUTHENTICATED` on all four. Ownership is checked in the service, as [Permissions and ownership](../customize/conventions.md#permissions-and-ownership) explains.

### 5. Paying by card

Cash on delivery needs nothing after the order is placed. A card method does. The `201` answer of `POST /v1/orders` carries a `paymentAction` next to the order, and it tells the storefront what to do next. The `type` is one of four values:

- `none`: nothing to do. This is the case for cash on delivery and manual transfer.
- `redirect`: send the shopper to `url`, a hosted payment page.
- `form_post`: post `fields` to `url`.
- `embedded`: render the provider form in the page, using `clientToken` and `publicConfig`.

The order exists before the shopper pays. If the payment fails or the shopper walks away, the order stays pending and the storefront can start again:

- `POST /v1/orders/{id}/payment` answers a fresh `paymentAction`. It answers `409` when the order is not payable any more.
- `POST /v1/orders/{id}/payment/confirm` asks the provider for the live status when the shopper comes back, and answers `{ "data": { "paymentStatus": "..." } }`.
- `POST /v1/orders/track/payment` does the retry for a tracked order, with the same body as `/v1/orders/track`.

Both `{id}` routes need `X-Idempotency-Key`, and the same owner or guest session that placed the order. The provider webhook stays the source of truth for the paid status; the confirm call only speeds up the page the shopper sees. The action is not stored on the order, so a replay of the order within 24 hours returns the one cached at placement, and a shopper who needs a new one calls the retry route.

The parameter tables are on [the orders reference](../reference/storefront-api/orders.md) and [the checkout reference](../reference/storefront-api/checkout.md).

## The response

### The settings

```json
{
  "data": {
    "checkout": {
      "guestCheckoutEnabled": true,
      "requiredFields": [
        "email"
      ],
      "termsOfServiceUrl": null,
      "postPurchaseRedirectUrl": null,
      "checkoutMessage": null
    },
    "paymentMethods": [
      {
        "code": "cod",
        "name": "Cash on delivery",
        "description": "Pay the courier in cash when your order arrives.",
        "provider": "cod",
        "sortOrder": 0
      }
    ]
  }
}
```

A storefront renders `paymentMethods` as the tender step (`name` and `description` are translated, `code` goes on the order), hides the guest path when `guestCheckoutEnabled` is false, links `termsOfServiceUrl` when set, shows `checkoutMessage` above the form, and sends the customer to `postPurchaseRedirectUrl` after success when the operator set one. The header dump of this route shows `Cache-Control: no-store`:

```http
HTTP/1.1 200 OK
Cache-Control: no-store
Vary: Origin
Access-Control-Allow-Credentials: true
X-Request-Id: 130ee3b2-907f-4541-b4a8-994a7866032a
Content-Type: application/json; charset=utf-8
```

### The rates

```json
{
  "data": [
    {
      "methodId": "sm-domestic-standard",
      "name": "Standard delivery",
      "price": 10,
      "isDefault": true,
      "estimatedDaysMin": 2,
      "estimatedDaysMax": 5
    }
  ]
}
```

Render `name`, the formatted `price` and the delivery window; preselect the `isDefault` one. For the United States, which the fixture does not ship to, the same call answered `{ "data": [] }`.

### The order

The guest order above, placed with key `7aaa6261-64e2-4bce-be7a-02f5300273f2` after `POST /v1/cart/items` put one `fx-bottle-hydra-bottle-500` in the anonymous cart:

```json
{
  "data": {
    "id": "cmtub4nza00349sqsvfptq93o",
    "orderNumber": "ORD-2026-000010",
    "status": "PENDING",
    "paymentStatus": "PENDING",
    "shippingAddress": {
      "city": "Paris",
      "phone": "+33612345678",
      "country": "FR",
      "fullName": "Camille Martin",
      "postalCode": "75002",
      "addressLine1": "10 rue de l Exemple"
    },
    "billingAddress": {
      "city": "Paris",
      "phone": "+33612345678",
      "country": "FR",
      "fullName": "Camille Martin",
      "postalCode": "75002",
      "addressLine1": "10 rue de l Exemple"
    },
    "currency": "EUR",
    "shippingMethodName": "Standard delivery",
    "paymentMethodCode": "cod",
    "paymentMethodName": "Cash on delivery",
    "guestEmail": "w-checkout@l5.example",
    "couponCode": null,
    "notes": null,
    "createdAt": "2026-09-09T16:22:56.614Z",
    "updatedAt": "2026-09-09T16:22:56.614Z",
    "deliveredAt": null,
    "subtotal": 89,
    "discountAmount": 0,
    "shippingAmount": 10,
    "taxAmount": 17.8,
    "total": 116.8,
    "items": [
      {
        "id": "cmtub4nzk00369sqst6feerd7",
        "orderId": "cmtub4nza00349sqsvfptq93o",
        "variantId": "cmtub3626001owcqsruhqmn70",
        "productId": "cmtub361w001nwcqsf7pr7kb9",
        "productName": "Hydra Bottle 500",
        "variantLabel": null,
        "sku": "FX-HM-HB500",
        "unitPrice": 89,
        "quantity": 1,
        "discountAmount": 0,
        "taxAmount": 0,
        "total": 89,
        "weight": null,
        // ... thumbnailUrl omitted
        "downloadUrl": null,
        "maxDownloads": null,
        "downloadsUsed": 0,
        "downloadExpiresAt": null,
        "createdAt": "2026-09-09T16:22:56.614Z"
      }
    ],
    "shipments": [],
    "invoice": null,
    "statusHistory": [
      {
        "status": "PENDING",
        "at": "2026-09-09T16:22:56.614Z"
      }
    ]
  }
}
```

The confirmation page renders `orderNumber` (the customer-facing number, also the key for tracking), `status`, the two addresses, `shippingMethodName` and `paymentMethodName` as snapshotted, the `items` with `productName`, `quantity` and `unitPrice`, and the money block: `subtotal`, `discountAmount`, `shippingAmount`, `taxAmount`, `total`, all numbers in `currency`, formatted by the rules from [Config, locale and money](./01-config-locale-money.md). `taxAmount` is the store's tax rate applied to the goods total after discount, and shipping sits outside that base. Render the totals from this response, not from the cart: the cart's `grandTotal` for the same line was 99, an estimate that carried no tax, and the order's `total` of 116.8 is what the customer owes. Keep `id` for the confirmation read-back and nothing else; it is not shown.

### The replay

The same request again, same key, same body, after the first one succeeded. Trimmed to the fields that prove it is the same order; the body was byte for byte the one above:

```json
{
  "data": {
    "id": "cmtub4nza00349sqsvfptq93o",
    "orderNumber": "ORD-2026-000010",
    "status": "PENDING",
    // ... the rest of the first response, unchanged
  }
}
```

The status was `201` again, the handler did not run, no stock moved, and the cart stayed empty. The stored response lives in Redis for twenty-four hours under the key; after that a replay with the same key would place a new order, so a storefront never keeps a key that long. A replay is bound to the caller too: the same key from another session answers `403 IDEMPOTENCY_KEY_FORBIDDEN`.

The same key with a different body (`notes` added) is refused:

```json
{
  "error": {
    "code": "IDEMPOTENCY_KEY_CONFLICT",
    "message": "X-Idempotency-Key was previously used with a different request body."
  }
}
```

That is a 409, and the right reaction is a new key: the customer changed something, so this is a new attempt. No key at all:

```json
{
  "error": {
    "code": "IDEMPOTENCY_KEY_REQUIRED",
    "message": "X-Idempotency-Key header is required for this endpoint."
  }
}
```

A key that is not a UUID v4 (`X-Idempotency-Key: order-1`):

```json
{
  "error": {
    "code": "IDEMPOTENCY_KEY_MALFORMED",
    "message": "X-Idempotency-Key must be a UUID v4 string."
  }
}
```

A key whose first request failed is free again. In the transcript, key `dd370544-6bd4-443b-810a-5bc3dcfc1eb6` was refused four times (no email, no address, no cookie, a lower-case country) and then placed `ORD-2026-000011` on the fifth try. The API releases the key whenever the handler throws, so a storefront keeps the same key across a fix-and-resubmit as well as across a retry.

### The order read back

`GET /v1/orders/{id}` with the guest's `sessionId` cookie returns the order above plus two fields the create response does not carry: `productSlug` on each line, for the link back to the catalogue, and `cancellable`, the server's own answer to "may this customer cancel it now". Trimmed to those:

```json
{
  "data": {
    "id": "cmtub4nza00349sqsvfptq93o",
    "orderNumber": "ORD-2026-000010",
    "status": "PENDING",
    "items": [
      {
        "id": "cmtub4nzk00369sqst6feerd7",
        "productName": "Hydra Bottle 500",
        // ... the same line as above
        "productSlug": "fx-bottle-hydra-bottle-500"
      }
    ],
    "cancellable": true
  }
}
```

Show the cancel button when `cancellable` is true and nowhere else; the flag is computed by the same rule the cancel route enforces. Without the cookie the same id answers:

```json
{
  "error": {
    "code": "ORDER_NOT_FOUND",
    "message": "Order \"cmtub4nza00349sqsvfptq93o\" not found"
  }
}
```

### Tracking

`POST /v1/orders/track` with the number and the email on file:

```json
{
  "data": {
    "orderNumber": "ORD-2026-000010",
    "status": "PENDING",
    "shipments": [],
    "createdAt": "2026-09-09T16:22:56.614Z",
    "timeline": [
      {
        "status": "PENDING",
        "at": "2026-09-09T16:22:56.614Z"
      }
    ]
  }
}
```

Render `status`, the `timeline` oldest first, and each shipment's `carrier`, `trackingNumber` and dates once the order ships. Nothing personal is in this body, because the page is public behind nothing but the email challenge. A wrong email answers `404 ORDER_NOT_FOUND` with the plain message `Order not found`, the same as a wrong number, so a storefront shows one message for both.

### Signed in: the list, the cancel, the invoice

The rest of the transcript ran as a customer. `w-checkout@l5.example` was signed up, verified through the link the development mail transport logged, and signed in as [Auth and session](./02-auth-and-session.md) describes; the session cookie rode every call below. The same `POST /v1/orders` body without `guestEmail` and with key `7f90c3fa-727b-42a9-9735-b61320f05c08` placed `ORD-2026-000013` in the same shape as the guest order, with `"guestEmail": null`.

`GET /v1/orders?pageSize=2` is the account's order history, newest first, with a `meta` block for the pager. Each row is a summary, not the full order:

```json
{
  "data": [
    {
      "id": "cmtubkqir004o9sqss29ok4l7",
      "orderNumber": "ORD-2026-000013",
      "status": "PENDING",
      "paymentStatus": "PENDING",
      "subtotal": 89,
      "discountAmount": 0,
      "shippingAmount": 10,
      "taxAmount": 17.8,
      "total": 116.8,
      "currency": "EUR",
      "couponCode": null,
      "createdAt": "2026-09-09T16:35:26.403Z",
      "updatedAt": "2026-09-09T16:35:26.403Z",
      "_count": {
        "items": 1,
        "shipments": 0
      }
    }
  ],
  "meta": {
    "page": 1,
    "pageSize": 2,
    "total": 1
  }
}
```

Render `orderNumber`, `status`, `createdAt`, `total` in `currency` and `_count.items`; link each row to the order page. `page`, `pageSize` (1 to 100, default 20) and `status` are the query parameters. This `meta` carries `page`, `pageSize` and `total`; compute the page count from them.

`GET /v1/orders/{id}/invoice` on that fresh order, and `/invoice/pdf` too, answered the same thing, because an invoice is only written when the operator confirms the order:

```json
{
  "error": {
    "code": "ORDER_INVOICE_NOT_READY",
    "message": "Invoice not yet generated"
  }
}
```

`POST /v1/orders/{id}/cancel` on the same order, while `cancellable` was `true`, returned the full order with the new status and one more history row. Trimmed to what changed:

```json
{
  "data": {
    "id": "cmtubkqir004o9sqss29ok4l7",
    "orderNumber": "ORD-2026-000013",
    "status": "CANCELLED",
    // ... the same order as above
    "statusHistory": [
      {
        "status": "PENDING",
        "at": "2026-09-09T16:35:26.403Z"
      },
      {
        "status": "CANCELLED",
        "at": "2026-09-09T16:35:28.123Z"
      }
    ]
  }
}
```

The rule the route enforces: the order is `PENDING` or `CONFIRMED`, and no shipment exists for it that was not itself cancelled. A shipment row means the warehouse started, and from there the customer contacts the store. The second cancel, one second later, was refused:

```json
{
  "error": {
    "code": "ORDER_CANCEL_INELIGIBLE",
    "message": "Cannot cancel order in CANCELLED status",
    "details": {
      "reason": "STATUS",
      "status": "CANCELLED"
    }
  }
}
```

`details.reason` is `STATUS` here; it is `HAS_SHIPMENT` when a `CONFIRMED` order was refused because fulfilment started, so the storefront can say which. Reading, cancelling or invoicing another customer's order as this customer answered the same thing three times:

```json
{
  "error": {
    "code": "ORDER_NOT_YOURS",
    "message": "Not your order"
  }
}
```

For an invoice that exists, the transcript signed in as the seeded account that owns the one confirmed-then-cancelled order in this database. `GET /v1/orders/{id}/invoice` returns the invoice document with the order's number and currency inlined and a relative `downloadUrl`. Trimmed to the shape (the lines and the billing address are those of that order, not of the demo catalogue):

```json
{
  "data": {
    "id": "cmtgun02i002f14qswi1dc8sq",
    "orderId": "cmtgugk0u002114qsxu80m065",
    "invoiceNumber": "INV-2026-000002",
    "items": [
      // ... one line: sku, productName, quantity, unitPrice, total, orderItemId
    ],
    "subtotal": 840,
    "discountAmount": 0,
    "shippingAmount": 0,
    "taxAmount": 159.6,
    "total": 999.6,
    "shippingMethodName": "Standard delivery",
    "taxBreakdown": null,
    // ... billingAddress
    "issuedAt": "2026-08-31T06:20:18.330Z",
    "orderNumber": "ORD-2026-000005",
    // ... currency
    "downloadUrl": "/v1/orders/cmtgugk0u002114qsxu80m065/invoice/pdf"
  }
}
```

`items[].productName` is translatable and followed `Accept-Language` in the two runs; the rest is fixed at issue time. `downloadUrl` is relative to the API base and points at the sibling route, which streams the PDF and checks ownership again per request. A storefront navigates the browser to it through the same origin as the API, so the session cookie travels; it is not a presigned link and cannot be shared. The header dump of that download under `Accept-Language: fr`:

```http
HTTP/1.1 200 OK
Cache-Control: no-store
Content-Type: application/pdf
Content-Disposition: attachment; filename="INV-2026-000002.pdf"
Content-Length: 18351
```

The PDF is rendered in the customer's stored locale when the account has one, else in the request's `Accept-Language`, and cached privately per locale after the first download.

## Error codes

Every code the routes on this page can answer, with its HTTP status and what a storefront shows for it. The API's `message` is English whatever `Accept-Language` says; the storefront maps `code` to its own text in each locale and never displays `message`. The generated list with every message is [the error codes reference](../reference/error-codes.md).

`POST /v1/orders`:

- `IDEMPOTENCY_KEY_REQUIRED`, 400: a bug in the storefront, not a customer error. Log it and show the generic failure.
- `IDEMPOTENCY_KEY_MALFORMED`, 400: same.
- `IDEMPOTENCY_KEY_CONFLICT`, 409: the key was already used with another body. Mint a new key and resubmit.
- `IDEMPOTENCY_KEY_FORBIDDEN`, 403: the key belongs to another caller. Mint a new key.
- `ORDER_IDEMPOTENCY_IN_PROGRESS`, 409: the first request with this key is still running. Wait a moment and retry with the same key; the replay then returns the order.
- `VALIDATION_ERROR`, 400: a field failed the shape rules; `details` names each field. Show the field errors on the form. An optional field sent empty lands here, since the validator runs on the value it finds; a guest body with `"guestEmail": ""` (a filled cart, a valid key and address):

```json
{"error":{"code":"VALIDATION_ERROR","message":"Validation failed","details":[{"field":"guestEmail","messages":["guestEmail must be an email"]}]}}
```

- `ORDER_GUEST_CHECKOUT_DISABLED`, 403: the operator turned guest checkout off. Send the visitor to sign in.
- `ORDER_GUEST_EMAIL_REQUIRED`, 400: a guest order without `guestEmail`. Mark the email field. The same body as above with the key omitted:

```json
{"error":{"code":"ORDER_GUEST_EMAIL_REQUIRED","message":"A contact email is required to check out as a guest"}}
```

- `ORDER_GUEST_ADDRESS_REQUIRED`, 400: a guest order without an inline `shippingAddress`. Mark the address step.
- `ORDER_GUEST_SESSION_REQUIRED`, 400: no `sessionId` cookie reached the API. The cart is gone; send the visitor back to it.
- `ORDER_CART_EMPTY`, 400: nothing to order. Send the visitor to the cart.
- `ORDER_INSUFFICIENT_STOCK`, 409: a line is out of stock, at validation or at the atomic decrement. Send the visitor to the cart to adjust it.
- `ORDER_ADDRESS_NOT_FOUND`, 404: `shippingAddressId` (or the billing one) is not one of this customer's addresses. Reload the address list.
- `ORDER_SHIPPING_ADDRESS_REQUIRED`, 400: a signed-in order with neither an id nor an inline address. Mark the address step.
- `SHIPPING_METHOD_INVALID`, 400: `shippingMethodId` is not among the rates for this destination (wrong zone, deactivated, or stale). Quote the rates again and ask the customer to pick.
- `SHIPPING_UNAVAILABLE`, 400: the store has shipping zones and none covers this address. Show "we do not ship to this address" on the address step.
- `ORDER_PAYMENT_METHOD_UNAVAILABLE`, 400: the store has no enabled tender. Show a "checkout is unavailable" state; nothing the customer does fixes it.
- `ORDER_PAYMENT_METHOD_INVALID`, 400: the `paymentMethodCode` is not enabled, or several are enabled and none was sent. Reload the settings and ask the customer to pick.
- `GIFT_CARD_INVALID`, 400: the `giftCardCode` named in the body is unknown, inactive or expired. Mark the gift card field.
- `GIFT_CARD_INSUFFICIENT_BALANCE`, 400: the card could not cover the amount at redemption. Ask the customer to retry; the order was rolled back.
- `RATE_LIMITED`, 429: the write budget for this client is spent. Wait for `Retry-After` and retry with the same key.

`GET /v1/orders/{id}`, `POST /v1/orders/track`:

- `ORDER_NOT_FOUND`, 404: unknown id, a guest without the right cookie, an anonymous caller, or a wrong number-and-email pair. One "we could not find that order" message.
- `ORDER_NOT_YOURS`, 403: a signed-in customer asking for someone else's order. A dedicated "this order belongs to another account" state.
- `VALIDATION_ERROR`, 400: on the track route, a number outside `[A-Z0-9-]` or an email that is not one.

`GET /v1/orders`, `POST /v1/orders/{id}/cancel`, `GET /v1/orders/{id}/invoice`, `GET /v1/orders/{id}/invoice/pdf`:

- `AUTH_UNAUTHENTICATED`, 401: no session. Send the visitor to sign in and back.
- `ORDER_NOT_FOUND`, 404 and `ORDER_NOT_YOURS`, 403: as above.
- `ORDER_CANCEL_INELIGIBLE`, 409: the order left the cancellable window (`details.reason` is `STATUS`) or fulfilment already started (`HAS_SHIPMENT`). Show the reason and the contact link; hide the button, since `cancellable` was false.
- `ORDER_INVOICE_NOT_READY`, 404: the order is not confirmed yet, so no invoice exists. Hide the invoice link until `invoice` on the order is set.

Proved above with real requests: `IDEMPOTENCY_KEY_CONFLICT`, `IDEMPOTENCY_KEY_REQUIRED`, `IDEMPOTENCY_KEY_MALFORMED`, `ORDER_CART_EMPTY`, `SHIPPING_METHOD_INVALID`, `ORDER_PAYMENT_METHOD_INVALID`, `SHIPPING_UNAVAILABLE`, `ORDER_GUEST_EMAIL_REQUIRED`, `ORDER_GUEST_ADDRESS_REQUIRED`, `ORDER_GUEST_SESSION_REQUIRED`, `VALIDATION_ERROR`, `ORDER_NOT_FOUND`, `AUTH_UNAUTHENTICATED`, and in the signed-in section `ORDER_NOT_YOURS`, `ORDER_CANCEL_INELIGIBLE` and `ORDER_INVOICE_NOT_READY`. The shipped storefront keeps this map in one function per page, with a generic fallback for a code it does not know; do the same, and add the branch when you add a code.

## Every locale

The same order placed under `Accept-Language: fr`, with the same cart and the same body (key `dd370544-6bd4-443b-810a-5bc3dcfc1eb6`). Trimmed to the fields that differ from the `en` order above:

```json
{
  "data": {
    "id": "cmtub4rph003c9sqs2zddgwyq",
    "orderNumber": "ORD-2026-000011",
    "shippingMethodName": "Livraison standard",
    "paymentMethodName": "Paiement à la livraison",
    "items": [
      {
        "productName": "Gourde Hydra Bottle 500",
        // ... the same line as above
      }
    ]
    // ... the same money and addresses as above
  }
}
```

Two kinds of text are in play:

- `shippingMethodName` and `paymentMethodName` are plain text columns written once, in the locale of the request that placed the order. Reading `ORD-2026-000010` back under `fr` still returns `Standard delivery` and `Cash on delivery`. The storefront shows them as they are.
- `productName` on each line is translatable and follows the reader. The same `GET /v1/orders/{id}` returned `Hydra Bottle 500` under `en` and `Gourde Hydra Bottle 500` under `fr`.

The settings and the rates are translatable end to end: `paymentMethods[].name` came back as `Cash on delivery` then `Paiement à la livraison`, `paymentMethods[].description` as `Pay the courier in cash when your order arrives.` then `Réglez en espèces au livreur à la réception de votre commande.`, and the rate's `name` as `Standard delivery` then `Livraison standard`. Money never changes with the locale: `price: 10`, `total: 116.8` and `currency: "EUR"` are the same numbers in both runs, and the storefront formats them with the store's rules (`10,00 €` and `116,80 €` for this fixture). The tracking body has no translatable field; the `fr` call returned the same bytes as the `en` one. The fixture has no RTL locale, so `direction` did not change either.

## Framework notes

- Whatever places the order server side (a Next.js server action, a Nuxt server route, a SvelteKit form action) must mint the key once, when the checkout form is rendered, and carry it with the form state: a hidden field, or the server session keyed by the cart id. A double submit and a retry after a timeout then reach the API with the same key and get the same order. A key minted inside the action is a fresh key per submit, which is a second order.
- A browser client that retries on a network timeout reuses the key it already has. The shipped storefront holds it in a signal for the life of the cart snapshot and mints a new one only when the cart changes.
- Forward the incoming `Cookie` header on every server-side call (`sessionId` for a guest, the Better Auth cookie for a customer), and relay any `Set-Cookie` the API answers back to the browser, or the guest's confirmation read-back finds no cookie and answers `404`.
- Keep the key out of caches and logs: it is a credential for one order for twenty-four hours. After a success, drop it.
- Never cache an order page, and never send `If-None-Match`; the API emits no ETag and `Cache-Control: no-store`. If a `304` ever arrives, treat it as success, not as an error (see [Browser caching and 304](../customize/conventions.md#browser-caching-and-304)).

The long form, per framework, is on [Framework notes](./framework-notes.md#the-idempotency-key-on-a-retried-action).
