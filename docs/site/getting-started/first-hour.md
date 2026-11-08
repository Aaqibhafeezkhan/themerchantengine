---
title: The first hour
description: What to do once the installer printed its closing line. Sign in as the owner, walk the settings screens, create the first category and product in two locales, place a cash-on-delivery test order, read the order email, download the invoice.
primaryQuery: first product order self hosted ecommerce admin
updated: 2026-09-08
schema: HowTo
---

The installer left you a live, empty store and an owner login. This page is the hour that follows: the settings that are yours to edit now, the first product, the first order, and the two documents the store produces for it. On a local install every URL below is `http://localhost:53200` for the admin and `http://localhost:53300` for the storefront.

## Sign in as the owner

Open the admin origin (`https://admin.<apex>/`) and sign in with the owner email and the password you gave the installer. The owner is the first Super Admin: every permission, including the right to create the other staff accounts under Staff and to shape their roles under Roles.

If anyone else typed the owner password, change it first: sign out, use "Forgot password" on the login page, and set a new one from the email that arrives. Two-factor authentication is under the account menu, "Two-factor authentication".

## Walk the settings screens

Everything the installer asked about the store, as opposed to the box, is editable under Settings. Saving any of these updates the storefront on its next request; nothing needs a restart.

- **General.** The store name, trading name and description in every locale the store serves, the legal name and tax registration number, the contact email and phone, the address, the timezone.
- **Brand.** The base colours with a live palette preview and the contrast report, the font kit, the logo.
- **Locales.** The locales the store serves, the default, and which render right to left. Adding a locale here adds a tab to every text field in the admin and a prefix to every storefront URL.
- **Money.** The currency and how it renders: symbol, position, separators, decimals, and whether prices show tax included, tax excluded or no mention.
- **Domains.** The three public origins the store is known by.
- **Appearance.** The logo and favicon URLs the storefront renders.

What is not here are the values that belong to the box: keys, secrets and the environment. Those change by running the installer again, as [Store settings](../operate/store-settings.md) explains.

## Create the first category and product

Under Categories, create one. The name and description are per-locale fields: one tab per locale the store serves, and the default locale's tab is required. Give it a slug, save, and it is live on the storefront's navigation in every locale.

Under Products, create one. Name and description per locale as above, the category you made, a SKU, a price in the store's currency, a stock quantity, and at least one image from the asset library (upload one there first, or drop a file into the picker). Set the status to active and save. Open the storefront in each locale: the product renders with the price formatted the way Money says, the description in that locale, and, for a right-to-left locale, the mirrored layout.

A product with a tax class shows tax the way Money decided (`TTC`, `HT` or nothing). The installer created one tax zone from the VAT rate you gave; Tax zones and Tax classes, under Operations, are where more go.

## Place a test order with cash on delivery

On the storefront, sign up as a customer (Turnstile sits on the form on a server; sign-up runs without it locally) or check out as a guest, add the product to the cart, and check out. The shipping step offers the domestic flat rate the installer seeded; the payment step offers cash on delivery, which needs no credential and is on by default. Card payment appears there too once you switch on Stripe in the admin. Confirm.

The order appears under Orders in the admin within a second, in the pending state, with the customer, the lines, the shipping and the total as the storefront showed them. Move it through its states from the order page: confirm it, mark it shipped, mark it delivered. Each transition writes a line in the order's history and in the audit log.

## Read the order email

A confirmation goes to the customer when the order is placed, and another message at each later state (confirmed, shipped, delivered, cancelled). Staff are not mailed per order: the new order shows in the admin's Notifications inbox, and active admins receive a daily operations digest (low stock, new returns, reviews awaiting moderation, sent only when there is something to report) and a weekly summary of revenue and orders. On a server the mail leaves through your Resend domain and its delivery status comes back through the webhook, visible per message under Notifications. On a local install it lands in the API container's log, addressed to the redirect address you gave the installer:

```bash
docker logs themerchantengine-api --tail 200 | grep -i "order"
```

Every template the store sends is editable under Notifications, Templates, per locale, with the variables each one accepts listed beside the editor.

## Download the invoice

The customer's account page lists the order with a link to its invoice, a PDF rendered by the API with the store's logo and legal name, the lines, the tax as configured, and the totals, in the customer's locale and direction. It is generated the first time it is asked for and cached after that.

## What to do with the demo catalogue

If you said yes to the demo catalogue, the store shows fictional products until you delete them. Under Products, filter by the demo categories and delete them; the categories follow. The demo seed runs only on a store with no users, so a later re-run of the installer never brings them back.

## Before customers arrive

Walk the [go-live checklist](./go-live-checklist.md).
