---
title: What you get
description: What an install of themerchantengine puts on a box, what a store owner has on day one, and what is not shipped yet.
primaryQuery: self-hosted ecommerce platform what is included
updated: 2026-09-08
schema: TechArticle
---

themerchantengine is a self-hosted ecommerce platform you install on your own server with one command. One install gives you three applications and the installer that ties them together. Every store-specific value (name, brand colours, locales, currency, domains, third-party keys) is entered once through the installer and lives in the database and the environment, so one build of the engine serves any store.

## The API

A NestJS and Prisma backend on PostgreSQL and Redis, thirty-three modules behind one REST API: catalogue, search, cart, checkout, orders, payments, shipping zones, tax, promotions, gift cards, reviews, customers, staff and roles, content pages, home sections, notifications, SEO, analytics events, assets, audit log, and the store settings the other two applications read. Every user-facing text is stored per locale. Every admin endpoint carries a permission. Order creation and every stock mutation accept an idempotency key, so a retried request never charges or decrements twice.

The API also publishes the store's `sitemap.xml`, `robots.txt`, `llms.txt` and `llms-full.txt`, submits changed URLs to IndexNow and Google Search Console when you configure them, and sends transactional mail through Resend.

## The admin

An Angular dashboard for the people who run the store: catalogue and orders, customers and segments, promotions and gift cards, shipping and tax, notifications and their templates, analytics, the audit log, staff with role-based permissions, and the settings screens where the store's identity, brand, locales, money and domains are edited after the install. It follows the operating system's light or dark preference and renders every text field once per locale the store serves.

## The storefront

A server-rendered storefront (Analog.js on Nitro) that reads the store's configuration at request time: brand tokens, logo and fonts, the locales the store serves with a locale prefix in every URL, right-to-left layout for Arabic, and money formatting with the currency's own symbol, separators and precision. It ships catalogue browsing and full-text search, the cart, checkout with card payment through Stripe, cash on delivery, manual bank transfer and gift cards, customer accounts with order history and invoice PDFs, wishlists, reviews, content pages, and the structured data, canonical tags and `hreflang` links a search engine expects.

You can brand this storefront through the admin, change it in the source, or build your own on the REST API and keep the API and the admin as they are.

## The installer

`./setup.sh` on Linux and macOS, `./setup.ps1` on Windows. It checks the prerequisites, asks for every value the store needs, verifies each third-party integration live (a probe object in your bucket, a test email through your Resend domain, your Turnstile secret against Cloudflare, your Search Console service account against the property), then builds the images from source, creates the database, issues the certificates, seeds the store and creates the owner account. It ends with `backend server installed successfully!` and the admin URL. Run it again after a failure and it resumes; run it again on a newer checkout and it updates the store.

The same installer runs on a laptop with Docker Desktop under a local profile: no TLS, local ports, mail kept on the machine, and a demo catalogue so there is something to look at.

## What a store owner has on day one

- A storefront at their domain, in the locales they chose, empty and ready for products.
- An admin login as the owner, with every permission.
- Transactional mail from their own domain: order confirmations, shipping updates, password resets, account emails.
- Sign-up protected by Cloudflare Turnstile.
- Nightly database dumps and automatic certificate renewal on the server.
- A sitemap, `robots.txt` and `llms.txt` that update themselves as the catalogue changes.

## What is not shipped yet

- **More card payment gateways.** Stripe is the one card provider that ships. Cash on delivery, manual bank transfer and gift cards are the other tenders. Another card provider is one class behind the `PaymentProvider` interface; see [Add a payment provider](../customize/recipes/api/add-a-payment-provider.md).
- **An upgrade command.** An update is a re-run of the installer on a newer checkout, which is idempotent and keeps every secret and certificate. See [Update the store](../operate/update.md).
- **Prebuilt images.** The installer builds the three images from source on the box. There is no public image registry.
- **A second storefront layout or theme presets.** One storefront ships. Its colours, fonts and logo come from the store's configuration; its layout is one.
- **OS hardening.** The installer never touches SSH, the firewall or users. Those stay your checklist, listed in [Requirements](./requirements.md).
