import { LOCALE_REGISTRY } from '@common/locale/locale-registry';
import { STORE_CONFIG_LOCALES } from '@common/store-config-fixtures/store-config-fixture.schema';

/**
 * Storefront chrome i18n contract.
 *
 * Each language map (`fr.ts`, `en.ts`) MUST satisfy {@link ChromeStrings}.
 * Adding or removing a key is a compile-time edit across all languages, so
 * no missing-translation gaps reach production.
 *
 * API-driven copy (product names, descriptions, category names, reviews)
 * is NOT here. Those resolve server-side via `Accept-Language` per
 * constitution §3.2 and arrive pre-translated from the API.
 */
export interface ChromeStrings {
  meta: {
    title: string;
    description: string;
  };
  brand: {
    name: string;
    tagline: string;
    descriptor: string;
  };
  splash: {
    heading: string;
    subheading: string;
  };
  nav: {
    home: string;
    catalog: string;
    categoriesLabel: string;
    allProducts: string;
    search: string;
    cart: string;
    account: string;
    login: string;
    register: string;
  };
  cart: {
    empty: string;
    itemCountSingular: string;
    itemCountPlural: string;
    page: {
      title: string;
      loading: string;
      loadError: string;
      retry: string;
      emptyTitle: string;
      emptyBody: string;
      emptyCta: string;
      removeLine: string;
      removeLineLabel: string;
      qtyLabel: string;
      qtyIncrease: string;
      qtyDecrease: string;
      lineTotal: string;
      subtotal: string;
      discount: string;
      shipping: string;
      shippingEstimate: string;
      shippingEstimateLabel: string;
      shippingFree: string;
      freeShippingRemaining: string;
      giftCardRow: string;
      amountPayable: string;
      vatAtCheckout: string;
      tax: string;
      total: string;
      couponHeading: string;
      couponPlaceholder: string;
      couponFormatHint: string;
      couponApply: string;
      couponApplied: string;
      couponRemove: string;
      couponInvalid: string;
      giftCardHeading: string;
      giftCardPlaceholder: string;
      giftCardApply: string;
      giftCardApplied: string;
      giftCardRemove: string;
      giftCardInvalid: string;
      giftCardFormatHint: string;
      /**
       * The action moves the line into the wishlist and deletes it from the
       * cart: `POST /v1/cart/items/:itemId/save-for-later` calls
       * `WishlistService.addItem`. There is no saved-for-later pool on the cart
       * and never was, so the copy says what the backend does. The route name
       * is left alone; renaming a live endpoint buys nothing.
       */
      saveForLaterAction: string;
      saveForLaterAuthGate: string;
      saveForLaterAuthCta: string;
      movedToWishlist: string;
      movedToWishlistLink: string;
      moveToWishlistError: string;
      proceedToCheckout: string;
      outOfStock: string;
      mutationError: string;
      mutationOutOfStock: string;
      itemsRegionLabel: string;
      totalsRegionLabel: string;
    };
  };
  header: {
    menuOpen: string;
    menuClose: string;
    searchPlaceholder: string;
    searchSubmit: string;
    cartLabel: string;
    cartItemCountLabel: string;
    accountLabel: string;
    brandLockupAlt: string;
  };
  bottomNav: {
    label: string;
    home: string;
    search: string;
    cart: string;
    account: string;
  };
  /**
   * The public order-track surface, at `/{locale}/track`.
   *
   * Top level rather than under `account` because the page is not an account
   * page any more (finding K9): anyone holding an order number and the email on
   * file can reach it, signed in or not.
   */
  track: {
    metaTitle: string;
    heading: string;
    body: string;
    orderNumberLabel: string;
    orderNumberPlaceholder: string;
    emailLabel: string;
    emailPlaceholder: string;
    submit: string;
    submitting: string;
    successHeading: string;
    notFoundTitle: string;
    notFoundBody: string;
    requiredField: string;
    invalidOrderNumber: string;
    invalidEmail: string;
    genericError: string;
    shipmentsHeading: string;
    carrierLabel: string;
    trackingNumberLabel: string;
    carrierLink: string;
    noShipments: string;
    payAgain: string;
    paymentPendingNote: string;
    cancelledNote: string;
  };
  /**
   * Footer newsletter signup. It used to be an inline `COPY` constant in the
   * component with an `fr` and an `en` branch only, so an Arabic page rendered
   * English (plan E2.5). Living in the contract makes a missing locale a
   * compile error instead.
   */
  newsletter: {
    heading: string;
    blurb: string;
    label: string;
    placeholder: string;
    cta: string;
    success: string;
    error: string;
    invalid: string;
  };
  /**
   * The newsletter confirm / unsubscribe landing states. Another inline `COPY`
   * constant with an `fr` and an `en` branch, so an Arabic reader who followed
   * a confirmation link read English (plan E2.5).
   */
  newsletterConfirm: {
    confirmed: { title: string; body: string };
    unsubscribed: { title: string; body: string };
    invalid: { title: string; body: string };
  };
  footer: {
    trackOrder: string;
    about: string;
    returns: string;
    privacy: string;
    terms: string;
    shipping: string;
    copyright: string;
    brandLockupAlt: string;
    sectionLinksLabel: string;
    /** S22: group heading for the About column. */
    columnAboutLabel: string;
    /** S22: group heading for the Support column. */
    columnSupportLabel: string;
    /** S22: group heading for the Legal column. */
    columnLegalLabel: string;
    /** Heading over the operator-configured contact details. The block renders
     * only when the store settings carry an email, a phone or a social profile. */
    contactHeading: string;
    /** Accessible name for the social-profile row. */
    socialHeading: string;
    /** Accessible name for one social link. `{platform}` is the platform's
     * display name, which is a brand and does not translate. */
    socialLinkLabel: string;
  };
  generic: {
    skipToContent: string;
    loading: string;
    retry: string;
    close: string;
    /** Accessible name of a toast's close button. */
    dismissToast: string;
    back: string;
    languageFrench: string;
    languageEnglish: string;
    /**
     * The tax mention `agent_docs/storefront/brand-tokens.md` requires on every
     * displayed price. `HT` is tax-exclusive, `TTC` is tax-inclusive, and which
     * of them a store shows is `money.taxDisplay` in the runtime config
     * (DR-31). Both tokens stay French in every catalogue: they are the
     * invoice-standard abbreviations, and a localised equivalent would leave
     * two catalogues asserting different contracts for the same price.
     */
    taxExcluded: string;
    taxIncluded: string;
    /** Pagination and rating chrome, for the primitives that render their own
     * default label. They used to hold a `fr`/`en` ternary inline, which meant
     * an Arabic page silently rendered English. */
    paginationPrevious: string;
    paginationNext: string;
    paginationSummary: string;
    ratingSummary: string;
  };
  notFound: {
    title: string;
    heading: string;
    body: string;
    cta: string;
  };
  errorPage: {
    title: string;
    heading: string;
    body: string;
    retry: string;
    home: string;
  };
  home: {
    sections: {
      categories: string;
    };
    trust: {
      heading: string;
      delivery: { title: string; subtitle: string };
      returns: { title: string; subtitle: string };
      authentic: { title: string; subtitle: string };
      support: { title: string; subtitle: string };
    };
    skeleton: {
      loading: string;
    };
    deliveryEstimate: string;
    empty: {
      categories: string;
      products: string;
    };
    horizontalScroll: {
      label: string;
    };
  };
  catalog: {
    breadcrumb: {
      navLabel: string;
      home: string;
      catalog: string;
    };
    filters: {
      title: string;
      brand: string;
      price: string;
      priceUnder50: string;
      price50to250: string;
      price250to1000: string;
      priceOver1000: string;
      clear: string;
      apply: string;
      open: string;
      close: string;
    };
    sort: {
      label: string;
      newest: string;
      priceAsc: string;
      priceDesc: string;
      nameAsc: string;
    };
    pagination: {
      navLabel: string;
      previous: string;
      next: string;
      goToPage: string;
      currentPage: string;
    };
    results: {
      count: string;
      countSingular: string;
      zero: string;
    };
    loadError: string;
    retry: string;
    empty: {
      title: string;
      body: string;
      cta: string;
    };
    loading: string;
    loadingMore: string;
    loadMore: string;
    categoryBar: {
      navLabel: string;
      subNavLabel: string;
      all: string;
    };
    pageTitle: string;
    meta: {
      title: string;
      description: string;
    };
  };
  search: {
    placeholder: string;
    submit: string;
    suggestionsLabel: string;
    suggestionStatusOpen: string;
    suggestionStatusClosed: string;
    loading: string;
    noSuggestions: string;
    viewAllResults: string;
    pageHeading: string;
    pageHeadingWithQuery: string;
    resultsCount: string;
    resultsCountSingular: string;
    loadError: string;
    retry: string;
    breadcrumb: {
      navLabel: string;
      home: string;
      search: string;
    };
    noResults: {
      title: string;
      body: string;
      cta: string;
    };
    clearFilters: string;
    meta: {
      title: string;
      titleWithQuery: string;
      description: string;
    };
  };
  product: {
    breadcrumb: {
      catalog: string;
    };
    addToCart: string;
    addingToCart: string;
    addedToCartWithCount: string;
    viewCart: string;
    quantity: {
      label: string;
      increase: string;
      decrease: string;
    };
    addToCartError: string;
    outOfStock: string;
    errors: {
      variantNotFound: string;
      insufficientStock: string;
    };
    wishlist: {
      add: string;
      remove: string;
      added: string;
      removed: string;
      error: string;
      signInToSave: string;
    };
    backInStock: {
      notify: string;
      stop: string;
      added: string;
      removed: string;
      hint: string;
      preferencesLink: string;
    };
    delivery: {
      estimate: string;
      free: string;
    };
    gallery: {
      label: string;
      thumbnail: string;
      nextImage: string;
      previousImage: string;
      open: string;
      close: string;
      counter: string;
    };
    faqs: {
      title: string;
      sectionLabel: string;
    };
    specs: {
      title: string;
      caption: string;
      /** Carries a {count} placeholder for the total row count. */
      showAll: string;
      showLess: string;
    };
    reviews: {
      title: string;
      summary: string;
      empty: string;
      showMore: string;
      starsLabel: string;
      pendingBadge: string;
      pending: string;
      yourReview: string;
      anonymous: string;
      alreadyReviewed: string;
      viewOrders: string;
      edit: string;
      delete: string;
      deleted: string;
      helpful: string;
      helpfulPressed: string;
      helpfulCount: string;
      helpfulError: string;
      signInBody: string;
      signInCta: string;
      form: {
        title: string;
        editTitle: string;
        ratingLabel: string;
        ratingHint: string;
        titleLabel: string;
        titlePlaceholder: string;
        bodyLabel: string;
        bodyPlaceholder: string;
        submit: string;
        submitting: string;
        cancel: string;
        errors: {
          ratingRequired: string;
          bodyRequired: string;
          bodyTooLong: string;
          titleTooLong: string;
          itemTooLong: string;
          verifiedPurchaseRequired: string;
          duplicate: string;
          productNotFound: string;
          assetInvalid: string;
          notOwned: string;
          generic: string;
        };
      };
      deleteConfirm: {
        title: string;
        body: string;
        yes: string;
        no: string;
      };
    };
    questions: {
      title: string;
      empty: string;
      showMore: string;
      pendingBadge: string;
      pending: string;
      anonymous: string;
      storeTeam: string;
      community: string;
      helpful: string;
      helpfulPressed: string;
      helpfulCount: string;
      helpfulError: string;
      signInBody: string;
      signInCta: string;
      form: {
        title: string;
        questionLabel: string;
        questionPlaceholder: string;
        submit: string;
        submitting: string;
        cancel: string;
        errors: {
          questionRequired: string;
          questionTooLong: string;
          productNotFound: string;
          generic: string;
        };
      };
      answer: {
        toggleCta: string;
        title: string;
        label: string;
        placeholder: string;
        submit: string;
        submitting: string;
        cancel: string;
        added: string;
        signInCta: string;
        errors: {
          required: string;
          tooLong: string;
          notAvailable: string;
          alreadyAnswered: string;
          generic: string;
        };
      };
    };
    related: {
      title: string;
    };
    variant: {
      label: string;
      outOfStock: string;
      selected: string;
    };
    reference: string;
    stock: {
      inStock: string;
      lowStock: string;
      outOfStock: string;
    };
  };
  auth: {
    shared: {
      showPassword: string;
      hidePassword: string;
      submitting: string;
    };
    login: {
      title: string;
      heading: string;
      subheading: string;
      emailLabel: string;
      emailPlaceholder: string;
      passwordLabel: string;
      passwordPlaceholder: string;
      submit: string;
      forgotPasswordLink: string;
      noAccount: string;
      registerLink: string;
      genericError: string;
      invalidCredentials: string;
      deactivated: string;
      rateLimited: string;
      sessionExpired: string;
      emailNotVerified: string;
      magicLinkSubmit: string;
      magicLinkSentHeading: string;
      magicLinkSentBody: string;
    };
    register: {
      title: string;
      heading: string;
      subheading: string;
      firstNameLabel: string;
      lastNameLabel: string;
      emailLabel: string;
      passwordLabel: string;
      passwordHint: string;
      acceptTermsLabel: string;
      termsLink: string;
      privacyLink: string;
      submit: string;
      haveAccount: string;
      loginLink: string;
      genericError: string;
      emailExists: string;
      weakPassword: string;
      registeredHeading: string;
      registeredBody: string;
    };
    forgotPassword: {
      title: string;
      heading: string;
      subheading: string;
      emailLabel: string;
      submit: string;
      successHeading: string;
      successBody: string;
      successSupport: string;
      backToLogin: string;
      genericError: string;
      rateLimited: string;
    };
    resetPassword: {
      title: string;
      heading: string;
      subheading: string;
      passwordLabel: string;
      passwordHint: string;
      confirmPasswordLabel: string;
      submit: string;
      successHeading: string;
      successBody: string;
      loginLink: string;
      tokenMissing: string;
      tokenInvalid: string;
      passwordMismatch: string;
      genericError: string;
    };
    accountMenu: {
      label: string;
      greeting: string;
      orders: string;
      addresses: string;
      wishlist: string;
      profile: string;
      logout: string;
      loggingOut: string;
    };
  };
  checkout: {
    meta: {
      title: string;
      description: string;
    };
    heading: string;
    loading: string;
    loadError: string;
    retry: string;
    emptyCartTitle: string;
    emptyCartBody: string;
    emptyCartCta: string;
    /** Guest checkout: contact details in place of an account (finding K3). */
    guest: {
      title: string;
      intro: string;
      signInCta: string;
      email: string;
      emailHint: string;
      company: string;
      note: string;
      optional: string;
    };
    steps: {
      stepState: {
        complete: string;
        inProgress: string;
        needsAttention: string;
      };
      editStep: string;
      itemsCount: string;
      itemsCountOne: string;
      address: {
        title: string;
        summary: string;
        addNew: string;
        useExisting: string;
        defaultBadge: string;
        continue: string;
        edit: string;
        fields: {
          fullName: string;
          phone: string;
          addressLine1: string;
          addressLine2: string;
          city: string;
          state: string;
          postalCode: string;
          country: string;
          countryHint: string;
          save: string;
          saving: string;
          cancel: string;
        };
      };
      shipping: {
        title: string;
        summary: string;
        legend: string;
        loading: string;
        empty: string;
        error: string;
        retry: string;
        free: string;
        etaOne: string;
        etaRange: string;
        continue: string;
      };
      payment: {
        title: string;
        summary: string;
        legend: string;
        loading: string;
        /** Zero enabled methods: the store cannot take an order (finding D2). */
        empty: string;
        error: string;
        retry: string;
        continue: string;
      };
      summary: {
        title: string;
        /** The collapsed step-2 line: count, total, tax mention (finding K3). */
        recap: string;
        items: string;
        subtotal: string;
        discount: string;
        shipping: string;
        shippingFree: string;
        tax: string;
        total: string;
        continue: string;
        edit: string;
      };
      place: {
        title: string;
        /** Rendered only for a `cod`-provider tender (finding D2). */
        codNote: string;
        terms: string;
        termsLink: string;
        privacyLink: string;
        submit: string;
        submitting: string;
        idempotencyTooltip: string;
      };
    };
    paymentPayCta: string;
    paymentPayBusy: string;
    paymentCardNumber: string;
    errors: {
      addressRequired: string;
      invalidPhone: string;
      invalidCountry: string;
      invalidPostalCode: string;
      requiredField: string;
      termsRequired: string;
      outOfStock: string;
      outOfStockCta: string;
      paymentRefused: string;
      networkUnavailable: string;
      sessionExpired: string;
      cartEmpty: string;
      idempotencyInFlight: string;
      shippingMethodInvalid: string;
      shippingUnavailable: string;
      paymentMethodInvalid: string;
      paymentMethodUnavailable: string;
      paymentNotRetryable: string;
      paymentProviderUnavailable: string;
      paymentEmbeddedUnsupported: string;
      paymentCardDeclined: string;
      paymentFailed: string;
      invalidEmail: string;
      guestCheckoutDisabled: string;
      generic: string;
    };
  };
  orderConfirmation: {
    /** Anonymous deep link: no order to show, but a way to find it (K3). */
    guestTrackTitle: string;
    guestTrackBody: string;
    meta: {
      title: string;
      description: string;
    };
    heading: string;
    subheading: string;
    deliveryEstimate: string;
    deliveryEstimateUnknown: string;
    trackingCta: string;
    publicTrackCta: string;
    cancelledHeading: string;
    paymentOnDelivery: string;
    continueShoppingCta: string;
    payAgainCta: string;
    payAgainBusy: string;
    paymentStatusLabel: string;
    paymentStatus: {
      PENDING: string;
      AUTHORIZED: string;
      CAPTURED: string;
      FAILED: string;
      REFUNDED: string;
      PARTIALLY_REFUNDED: string;
      CANCELLED: string;
    };
    paymentEmbeddedTitle: string;
    summarySection: {
      title: string;
      subtotal: string;
      shipping: string;
      shippingFree: string;
      tax: string;
      discount: string;
      total: string;
      payment: string;
    };
    addressSection: {
      title: string;
    };
    itemsSection: {
      title: string;
    };
    loading: string;
    loadError: string;
    notFoundTitle: string;
    notFoundBody: string;
    notFoundCta: string;
  };
  account: {
    meta: {
      indexTitle: string;
      ordersTitle: string;
      orderDetailTitle: string;
      addressesTitle: string;
      wishlistTitle: string;
      profileTitle: string;
      preferencesTitle: string;
      description: string;
    };
    shared: {
      navLabel: string;
      loading: string;
      loadError: string;
      retry: string;
      signInRequired: string;
      signInCta: string;
      backToAccount: string;
    };
    index: {
      heading: string;
      subheadingAuthed: string;
      recentOrdersTitle: string;
      recentOrdersEmpty: string;
      recentOrdersViewAll: string;
      quickLinksLabel: string;
      quickLinks: {
        ordersTitle: string;
        ordersBody: string;
        addressesTitle: string;
        addressesBody: string;
        wishlistTitle: string;
        wishlistBody: string;
        profileTitle: string;
        profileBody: string;
        returnsTitle: string;
        returnsBody: string;
        preferencesTitle: string;
        preferencesBody: string;
      };
    };
    orders: {
      heading: string;
      empty: {
        title: string;
        body: string;
        cta: string;
      };
      filters: {
        label: string;
        all: string;
        pending: string;
        processing: string;
        shipped: string;
        delivered: string;
        cancelled: string;
      };
      pagination: {
        navLabel: string;
        previous: string;
        next: string;
        currentPage: string;
      };
      row: {
        orderNumber: string;
        placedAt: string;
        total: string;
        viewCta: string;
        statusLabel: string;
      };
      status: {
        pending: string;
        confirmed: string;
        processing: string;
        shipped: string;
        delivered: string;
        cancelled: string;
        refunded: string;
      };
    };
    orderDetail: {
      heading: string;
      placedAt: string;
      status: string;
      itemsTitle: string;
      itemsTableLabel: string;
      itemImageAlt: string;
      itemQuantity: string;
      itemUnitPrice: string;
      itemLineTotal: string;
      writeReview: string;
      totalsTitle: string;
      subtotal: string;
      discount: string;
      shipping: string;
      tax: string;
      giftCardApplied: string;
      total: string;
      shippingAddressTitle: string;
      billingAddressTitle: string;
      sameAsShipping: string;
      shippingMethodLabel: string;
      timeline: {
        title: string;
        eventLabel: string;
      };
      /**
       * The payment row (finding K7). `paymentMethodName` is a snapshot the
       * order carries; it is null on every order placed before plan F phase F5
       * wires the write, and the store is cash-on-delivery only today, so null
       * resolves to `cashOnDelivery` rather than to a gap.
       */
      payment: {
        title: string;
        methodLabel: string;
        statusLabel: string;
        cashOnDelivery: string;
        statusLabels: {
          PENDING: string;
          AUTHORIZED: string;
          CAPTURED: string;
          FAILED: string;
          REFUNDED: string;
          PARTIALLY_REFUNDED: string;
          CANCELLED: string;
        };
      };
      tracking: {
        title: string;
        carrierLabel: string;
        trackingNumberLabel: string;
        carrierLink: string;
        noneYet: string;
        /** A DELIVERED order that never got a shipment row. */
        deliveredOn: string;
        /** A SHIPPED order whose parcel carries no carrier detail yet. */
        shippedNoDetails: string;
      };
      cancel: {
        cta: string;
        confirmTitle: string;
        confirmBody: string;
        confirmCardHold: string;
        confirmYes: string;
        confirmNo: string;
        success: string;
        ineligible: string;
        hasShipment: string;
        error: string;
      };
      invoice: {
        downloadCta: string;
        downloading: string;
        notReady: string;
        error: string;
        /** Why the download is unavailable, rendered under a disabled button. */
        reasonNotConfirmed: string;
        reasonPreparing: string;
        reasonCancelled: string;
      };
      notFound: {
        title: string;
        body: string;
        cta: string;
      };
      notYours: {
        title: string;
        body: string;
        cta: string;
      };
      backToList: string;
    };
    addresses: {
      heading: string;
      addCta: string;
      empty: {
        title: string;
        body: string;
      };
      card: {
        defaultBadge: string;
        editCta: string;
        deleteCta: string;
        setDefaultCta: string;
      };
      deleteConfirm: {
        title: string;
        body: string;
        yes: string;
        no: string;
      };
      form: {
        addTitle: string;
        editTitle: string;
        fullName: string;
        phone: string;
        addressLine1: string;
        addressLine2: string;
        city: string;
        state: string;
        postalCode: string;
        country: string;
        countryHint: string;
        countryDefault: string;
        isDefaultLabel: string;
        save: string;
        saving: string;
        cancel: string;
      };
      errors: {
        requiredField: string;
        invalidPhone: string;
        invalidCountry: string;
        invalidPostalCode: string;
        generic: string;
      };
      saved: string;
      deleted: string;
      defaultSet: string;
    };
    wishlist: {
      heading: string;
      empty: {
        title: string;
        body: string;
        cta: string;
      };
      row: {
        priceLabel: string;
        removeCta: string;
        removingLabel: string;
        addToCartCta: string;
        addingLabel: string;
        outOfStock: string;
      };
      addedToCart: string;
      addToCartError: string;
      removed: string;
      removeError: string;
      pagination: {
        navLabel: string;
        previous: string;
        next: string;
        currentPage: string;
      };
    };
    nav: {
      label: string;
      dashboard: string;
      orders: string;
      addresses: string;
      wishlist: string;
      profile: string;
      preferences: string;
      returns: string;
      signOut: string;
      signingOut: string;
    };
    profile: {
      heading: string;
      emailLabel: string;
      emailReadOnlyHint: string;
      firstNameLabel: string;
      lastNameLabel: string;
      phoneLabel: string;
      save: string;
      saving: string;
      saved: string;
      errors: {
        requiredField: string;
        tooLong: string;
        invalidPhone: string;
        currentPasswordRequired: string;
        currentPasswordIncorrect: string;
        emailInUse: string;
        generic: string;
      };
    };
    security: {
      heading: string;
      passwordHeading: string;
      passwordBody: string;
      currentPasswordLabel: string;
      newPasswordLabel: string;
      confirmPasswordLabel: string;
      passwordHint: string;
      passwordSubmit: string;
      passwordSubmitting: string;
      passwordSuccess: string;
      emailHeading: string;
      emailBody: string;
      newEmailLabel: string;
      emailSubmit: string;
      emailSubmitting: string;
      emailSuccess: string;
      errors: {
        requiredField: string;
        invalidEmail: string;
        weakPassword: string;
        passwordMismatch: string;
        sameEmail: string;
      };
    };
    preferences: {
      heading: string;
      subheading: string;
      alwaysOnLabel: string;
      alwaysOnHint: string;
      categories: {
        LIFECYCLE: { label: string; description: string };
        MARKETING: { label: string; description: string };
      };
      save: string;
      saving: string;
      saved: string;
      unsubscribedNotice: string;
      error: string;
    };
    returns: {
      heading: string;
      subheading: string;
      empty: {
        title: string;
        body: string;
        cta: string;
      };
      row: {
        returnIdLabel: string;
        orderIdLabel: string;
        reasonLabel: string;
        itemsLabel: string;
        viewOrder: string;
        helpLink: string;
      };
      status: {
        REQUESTED: string;
        APPROVED: string;
        ITEM_RECEIVED: string;
        REFUND_PROCESSED: string;
        CLOSED: string;
        REJECTED: string;
      };
      reason: {
        WRONG_SIZE: string;
        DEFECTIVE: string;
        NOT_AS_DESCRIBED: string;
        CHANGED_MIND: string;
        OTHER: string;
      };
    };
  };
}

/**
 * Every locale the engine ships a string catalogue for. A store enables a
 * subset of these in its runtime config (DR-31); the catalogue is what the
 * build carries, never what one install serves.
 *
 * `SUPPORTED_LOCALES` is the old name for it and stays as an alias, because
 * "supported" now has two meanings and only one of them is a build fact.
 * Prefer `LOCALE_CATALOGUE` at a new call site.
 *
 * Taken from the shared catalogue rather than restated. It was a second
 * literal beside `STORE_CONFIG_LOCALES` with no guard holding the two
 * together, which is the drift E2.3.6 removed from the services library and
 * left here.
 */
export const LOCALE_CATALOGUE = STORE_CONFIG_LOCALES;
export const SUPPORTED_LOCALES = LOCALE_CATALOGUE;
export type Locale = (typeof LOCALE_CATALOGUE)[number];

/**
 * The locale a caller falls back to when it has no config to read.
 *
 * It is a last resort, not a policy: every real decision takes the store's
 * configured default. It is the build catalogue fallback for the app i18n
 * helpers and the fixtures; it does not follow
 * `NEUTRAL_STOREFRONT_RUNTIME_CONFIG`, which `DEFAULT_STOREFRONT_LOCALE` does.
 */
export const DEFAULT_LOCALE: Locale = 'fr';

/**
 * BCP-47 region-tagged locale codes for `Intl.*` formatters.
 *
 * The region tail is not a build constant any more: `lib/locale-region.ts`
 * derives it from the configured country, the same way the API half has since
 * plan E1.3. This map holds the language half and a neutral tail for a caller
 * with no config, which is what an `Intl` formatter needs to be handed
 * something valid.
 */
export const LOCALE_INTL_TAG = Object.fromEntries(
  LOCALE_CATALOGUE.map((code) => [code, LOCALE_REGISTRY[code].intlTag.split('-')[0]]),
) as Record<Locale, string>;

export function isLocale(value: string | null | undefined): value is Locale {
  return (LOCALE_CATALOGUE as readonly string[]).includes(value ?? '');
}
