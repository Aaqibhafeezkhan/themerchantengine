/**
 * The reference generator, proved two ways: each reader and renderer on a
 * planted input that carries one thing to find, and the committed
 * docs/site/reference/ tree against a fresh run over the committed OpenAPI
 * export, so a stale page fails here before CI.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  GENERATED_BY,
  PAGE_MARKER,
  type PostmanCollection,
  diffTrees,
  generateReference,
  moduleOf,
  parseEnvExample,
  parseUsage,
  postmanEnvironment,
  renderApiPages,
  renderHttpFile,
  renderPage,
  renderPostmanCollection,
  renderProperties,
  sortEnums,
  sampleOf,
  scanEnforcedPermissions,
  scanErrorCodes,
  scanIdempotentRoutes,
  schemaType,
  sectionOf,
} from '../docs-generate';

const REPO = path.resolve(__dirname, '..', '..');
const REFERENCE = path.join(REPO, 'docs', 'site', 'reference');

const scratch: string[] = [];
const tmp = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-generate-spec-'));
  scratch.push(dir);
  return dir;
};
const plantFile = (dir: string, name: string, source: string): string => {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source);
  return file;
};
afterAll(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

describe('parseEnvExample', () => {
  const example = [
    '# The file header sentence, which is not a heading.',
    '',
    '# Server',
    'PORT=53000',
    '# development is the only label that unlocks a development behaviour.',
    'NODE_ENV=development',
    '',
    '# ── Auth and origins ───────',
    '# The public API origin.',
    'BETTER_AUTH_URL="https://api.shop.example"',
    '# Leading-dot root domain.',
    '# AUTH_COOKIE_DOMAIN=.shop.example',
    '',
  ].join('\n');

  it('reads every variable with its comment, its section and whether it is optional', () => {
    expect(parseEnvExample(example)).toEqual([
      { name: 'PORT', example: '53000', comment: '', section: 'Server', optional: false },
      {
        name: 'NODE_ENV',
        example: 'development',
        comment: 'development is the only label that unlocks a development behaviour.',
        section: 'Server',
        optional: false,
      },
      {
        name: 'BETTER_AUTH_URL',
        example: 'https://api.shop.example',
        comment: 'The public API origin.',
        section: 'Auth and origins',
        optional: false,
      },
      {
        name: 'AUTH_COOKIE_DOMAIN',
        example: '.shop.example',
        comment: 'Leading-dot root domain.',
        section: 'Auth and origins',
        optional: true,
      },
    ]);
  });

  it('tells a heading from a sentence', () => {
    expect(sectionOf('# Server')).toBe('Server');
    expect(sectionOf('# ── Email ────────')).toBe('Email');
    expect(sectionOf('# The public API origin.')).toBeNull();
    expect(sectionOf('# Cross-subdomain session cookie, production only')).toBeNull();
    expect(sectionOf('# development is lowercase')).toBeNull();
  });
});

describe('scanErrorCodes', () => {
  it('finds the code, the status and the message of every exception site, a static CODE included', () => {
    const dir = tmp();
    const service = plantFile(
      dir,
      'orders.service.ts',
      [
        "import { BadRequestException, NotFoundException } from '@nestjs/common';",
        'export class S {',
        '  a() {',
        "    throw new NotFoundException({ error: { code: 'ORDER_NOT_FOUND', message: 'Order not found' } });",
        '  }',
        '  b(id: string) {',
        '    throw new BadRequestException({',
        '      error: { code: \'ORDER_NOT_FOUND\', message: `Order "${id}" cannot be edited` },',
        '    });',
        '  }',
        "  c() { return { code: 'USD', message: 'not an exception' }; }",
        '}',
        '',
      ].join('\n'),
    );
    const custom = plantFile(
      dir,
      'custom.exception.ts',
      [
        "import { ForbiddenException } from '@nestjs/common';",
        'export class OwnerConflictException extends ForbiddenException {',
        "  static readonly CODE = 'OWNER_CONFLICT' as const;",
        '  constructor() {',
        "    super({ error: { code: OwnerConflictException.CODE, message: 'Owner conflict' } });",
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    const codes = scanErrorCodes([service, custom]);
    expect(codes.map((c) => c.code)).toEqual(['ORDER_NOT_FOUND', 'OWNER_CONFLICT']);
    const order = codes[0];
    expect(order.statuses).toEqual([400, 404]);
    expect(order.sites.map((s) => [s.line, s.exception, s.status, s.message])).toEqual([
      [4, 'NotFoundException', 404, 'Order not found'],
      [7, 'BadRequestException', 400, 'Order "${id}" cannot be edited'],
    ]);
    // The site is the class's own super() call, recorded under the class with its base's status.
    expect(codes[1].sites[0]).toMatchObject({
      exception: 'OwnerConflictException',
      status: 403,
      message: 'Owner conflict',
    });
    // USD sits in a plain object, not an exception: not a code.
    expect(codes.some((c) => c.code === 'USD')).toBe(false);
  });
});

describe('scanEnforcedPermissions', () => {
  it('maps each permission to the routes that check it, a shared route constant resolved', () => {
    const dir = tmp();
    const controller = plantFile(
      dir,
      'carriers.controller.ts',
      [
        '@Controller(ADMIN_API_ROUTES.carriers.base)',
        'export class CarriersController {',
        '  @Get()',
        "  @Permissions('carriers:view')",
        '  list() {}',
        '  @Get(ADMIN_API_ROUTES.carriers.byId)',
        "  @Permissions('carriers:view')",
        '  get() {}',
        "  @Post('bulk')",
        "  @Permissions('carriers:create', 'carriers:update')",
        '  bulk() {}',
        "  @Get('public')",
        '  open() {}',
        '}',
        '',
      ].join('\n'),
    );
    expect(scanEnforcedPermissions([controller])).toEqual({
      'carriers:create': ['POST /v1/admin/carriers/bulk'],
      'carriers:update': ['POST /v1/admin/carriers/bulk'],
      'carriers:view': ['GET /v1/admin/carriers', 'GET /v1/admin/carriers/:id'],
    });
  });

  it('keeps a route argument it cannot resolve visible as <expression>, which the generator then warns about', () => {
    const controller = plantFile(
      tmp(),
      'dynamic.controller.ts',
      [
        "@Controller('v1/admin/dynamic')",
        'export class DynamicController {',
        '  @Get(SOME_CONSTANT)',
        "  @Permissions('carriers:view')",
        '  list() {}',
        '}',
        '',
      ].join('\n'),
    );
    expect(scanEnforcedPermissions([controller])).toEqual({
      'carriers:view': ['GET /v1/admin/dynamic/<SOME_CONSTANT>'],
    });
  });
});

/** Every controller of the API, the input of the two controller scans. */
const controllerFiles = (): string[] =>
  fs
    .readdirSync(path.join(REPO, 'apps', 'api', 'src'), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.controller.ts'))
    .map((entry) => path.join(entry.parentPath ?? entry.path, entry.name))
    .sort();

/** The routes that take X-Idempotency-Key today; a drop in a controller fails here and in the tree check. */
const IDEMPOTENT_TODAY = [
  'PATCH /v1/admin/inventory/adjust',
  'PATCH /v1/admin/returns/{id}/refund',
  'POST /v1/admin/inventory/transfer',
  'POST /v1/admin/orders',
  'POST /v1/admin/orders/{id}/payment/cancel',
  'POST /v1/admin/orders/{id}/payment/capture',
  'POST /v1/admin/orders/{id}/payment/refund',
  'POST /v1/admin/seo/submit',
  'POST /v1/admin/webhooks/{id}/test',
  'POST /v1/orders',
];

describe('scanIdempotentRoutes', () => {
  it('lists the route of a handler with an @IdempotencyKey parameter and no other', () => {
    const controller = plantFile(
      tmp(),
      'orders.controller.ts',
      [
        "@Controller('v1/orders')",
        'export class OrdersController {',
        '  @Post()',
        '  create(@Body() dto: CreateOrderDto, @IdempotencyKey() idempotencyKey: string) {}',
        "  @Post(':id/cancel')",
        "  cancel(@Param('id') id: string, @Body() dto: CancelOrderDto) {}",
        '}',
        '',
      ].join('\n'),
    );
    expect(scanIdempotentRoutes([controller])).toEqual(['POST /v1/orders']);
  });

  it('resolves a shared route constant and writes a path parameter the OpenAPI way, sorted', () => {
    const controller = plantFile(
      tmp(),
      'webhooks.controller.ts',
      [
        '@Controller(ADMIN_API_ROUTES.webhooks.base)',
        'export class WebhooksAdminController {',
        '  @Post(ADMIN_API_ROUTES.webhooks.test)',
        "  @Permissions('webhooks:update')",
        '  test(',
        "    @Param('id') id: string,",
        '    @IdempotencyKey(IdempotencyKeyPipe) idempotencyKey: string,',
        '  ) {}',
        "  @Patch('bulk')",
        '  bulk(@IdempotencyKey(IdempotencyKeyPipe) idempotencyKey: string) {}',
        '  @Delete(ADMIN_API_ROUTES.webhooks.byId)',
        "  remove(@Param('id') id: string) {}",
        '}',
        '',
      ].join('\n'),
    );
    expect(scanIdempotentRoutes([controller])).toEqual([
      'PATCH /v1/admin/webhooks/bulk',
      'POST /v1/admin/webhooks/{id}/test',
    ]);
  });

  it('finds the ten routes of the committed controllers', () => {
    expect(scanIdempotentRoutes(controllerFiles())).toEqual(IDEMPOTENT_TODAY);
  });
});

describe('parseUsage', () => {
  it('reads one flag per usage line, with or without an argument', () => {
    const usage = [
      'Usage: x [options]',
      '',
      'Options:',
      '  --profile <a|b>   What this box runs.',
      '  --dry-run         Write nothing.',
      '',
    ].join('\n');
    expect(parseUsage(usage)).toEqual([
      { flag: '--profile', argument: '<a|b>', description: 'What this box runs.' },
      { flag: '--dry-run', argument: null, description: 'Write nothing.' },
    ]);
  });
});

describe('schema rendering', () => {
  it('phrases a type with its constraints, a reference as a link, an enum as its values', () => {
    expect(schemaType({ type: 'string', format: 'email', maxLength: 5 })).toBe(
      'string, email, max length 5',
    );
    expect(schemaType({ $ref: '#/components/schemas/MoneyDto' })).toBe('[MoneyDto](#moneydto)');
    expect(schemaType({ type: 'array', items: { type: 'number' } })).toBe('array of number');
    expect(schemaType({ enum: ['a', 'b'] })).toBe('`"a"`, `"b"`');
    expect(schemaType({ anyOf: [{ type: 'string' }, { type: 'null' }] })).toBe('string or null');
  });

  it('renders nested properties with dotted paths and the required flag', () => {
    const lines = renderProperties({
      type: 'object',
      required: ['money'],
      properties: {
        money: {
          type: 'object',
          required: ['currency'],
          properties: {
            currency: { type: 'string', description: 'ISO 4217.' },
            precision: { type: 'integer' },
          },
        },
        tags: { type: 'array', items: { type: 'string' } },
      },
    });
    expect(lines).toEqual([
      '- `money` (object, required).',
      '  - `money.currency` (string, required). ISO 4217.',
      '  - `money.precision` (integer, optional).',
      '- `tags` (array of string, optional).',
    ]);
  });
});

describe('renderApiPages', () => {
  const document = {
    paths: {
      '/v1/cart/items': {
        post: {
          summary: 'Add item to cart',
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/AddItemDto' } },
            },
          },
          responses: {
            '200': { description: 'Item added' },
            '404': { description: 'Variant not found' },
          },
        },
      },
      '/v1/cart': {
        get: {
          summary: 'Get shopping cart',
          responses: { '200': { description: 'Cart retrieved' } },
        },
      },
      '/v1/sitemap.xml': { get: { summary: 'Sitemap', responses: {} } },
      '/health': { get: { summary: 'Health', responses: {} } },
    },
    components: {
      schemas: {
        AddItemDto: {
          type: 'object',
          required: ['variantId'],
          properties: {
            variantId: { type: 'string' },
            money: { $ref: '#/components/schemas/MoneyDto' },
          },
        },
        MoneyDto: { type: 'object', properties: { amount: { type: 'number' } } },
        UnusedDto: { type: 'object' },
      },
    },
  };

  it('groups routes by module, the text files under seo and the probe under health', () => {
    expect(moduleOf('/v1/cart/items')).toBe('cart');
    expect(moduleOf('/v1/admin/product-types/1')).toBe('product-types');
    expect(moduleOf('/v1/sitemap-products.xml')).toBe('seo');
    expect(moduleOf('/v1/llms.txt')).toBe('seo');
    expect(moduleOf('/health')).toBe('health');
    expect([...renderApiPages(document, 'storefront').keys()]).toEqual(['cart', 'health', 'seo']);
  });

  it('renders every operation of a module, sorted, with body, responses and the schemas it reaches', () => {
    const cart = renderApiPages(document, 'storefront').get('cart');
    expect(cart?.count).toBe(2);
    const body = cart?.body ?? '';
    expect(body.indexOf('## GET /v1/cart')).toBeLessThan(body.indexOf('## POST /v1/cart/items'));
    expect(body).toContain('Request body: [AddItemDto](#additemdto).');
    expect(body).toContain('- `variantId` (string, required).');
    expect(body).toContain('- `404`: Variant not found.');
    expect(body).toContain('### AddItemDto');
    expect(body).toContain('### MoneyDto');
    expect(body).not.toContain('UnusedDto');
  });
});

describe('sampleOf', () => {
  const components = {
    MoneyDto: {
      type: 'object',
      properties: { amount: { type: 'number' }, currency: { enum: ['USD', 'EUR'] } },
    },
    LineDto: {
      type: 'object',
      properties: {
        money: { $ref: '#/components/schemas/MoneyDto' },
        self: { $ref: '#/components/schemas/LineDto' },
      },
    },
  };

  it('builds a value per type: the name or the example for a string, 1, true, the alphabetically first enum value, one array item', () => {
    expect(
      sampleOf(
        {
          type: 'object',
          properties: {
            email: { type: 'string', example: 'ada@shop.example' },
            slug: { type: 'string' },
            quantity: { type: 'integer' },
            gift: { type: 'boolean' },
            status: { enum: ['pending', 'paid'] },
            tags: { type: 'array', items: { type: 'string' } },
            lines: { type: 'array', items: { $ref: '#/components/schemas/MoneyDto' } },
          },
        },
        components,
      ),
    ).toEqual({
      email: 'ada@shop.example',
      slug: 'slug',
      quantity: 1,
      gift: true,
      status: 'paid',
      tags: ['tags'],
      lines: [{ amount: 1, currency: 'EUR' }],
    });
  });

  it('resolves a $ref, recurses into nested objects and stops on a cycle', () => {
    expect(sampleOf({ $ref: '#/components/schemas/LineDto' }, components)).toEqual({
      money: { amount: 1, currency: 'EUR' },
      self: {},
    });
    expect(sampleOf({ $ref: '#/components/schemas/Missing' }, components)).toEqual({});
  });
});

describe('the HTTP file and the Postman collection', () => {
  const idempotent = [{ 'idempotency-key': [] }];
  const storefront = {
    paths: {
      '/v1/cart/items/{itemId}': {
        patch: {
          summary: 'Update cart item',
          parameters: [{ name: 'itemId', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/UpdateItemDto' } },
            },
          },
          responses: {},
        },
      },
      '/v1/cart': { get: { summary: 'Get shopping cart', responses: {} } },
      '/v1/search': {
        get: {
          summary: 'Search products',
          parameters: [
            { name: 'q', in: 'query', required: true, schema: { type: 'string' } },
            { name: 'page', in: 'query', required: false, schema: { type: 'integer' } },
          ],
          responses: {},
        },
      },
      '/v1/orders': {
        post: {
          summary: 'Create order',
          security: idempotent,
          requestBody: {
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/CreateOrderDto' } },
            },
          },
          responses: {},
        },
      },
      '/v1/sitemap.xml': { get: { summary: 'Sitemap', responses: {} } },
    },
    components: {
      schemas: {
        UpdateItemDto: {
          type: 'object',
          properties: { plantedQuantity: { type: 'integer' }, note: { type: 'string' } },
        },
        CreateOrderDto: {
          type: 'object',
          properties: { plantedCoupon: { type: 'string' }, gift: { type: 'boolean' } },
        },
      },
    },
  };
  const admin = {
    paths: {
      '/v1/admin/inventory/adjust': {
        patch: {
          summary: 'Adjust inventory stock',
          requestBody: {
            content: {
              'application/json': {
                schema: { type: 'object', properties: { plantedDelta: { type: 'number' } } },
              },
            },
          },
          responses: {},
        },
      },
      '/v1/admin/carriers': { get: { summary: 'List carriers', responses: {} } },
    },
    components: { schemas: {} },
  };

  it('writes the HTTP file: the marker first, the variables, the auth block, then every operation in page order', () => {
    const http = renderHttpFile(storefront);
    const lines = http.split('\n');
    expect(lines[0]).toBe(`# generated by ${GENERATED_BY}; do not edit`);
    expect(http).toContain('@baseUrl = https://api.shop.example/api\n@locale = en\n');
    // The auth block, from the handler and not the document, sits before the first operation.
    const at = (text: string) => {
      const index = http.indexOf(text);
      expect(index, text).toBeGreaterThanOrEqual(0);
      return index;
    };
    expect(at('POST {{baseUrl}}/v1/auth/sign-up/email')).toBeLessThan(
      at('POST {{baseUrl}}/v1/auth/sign-in/email'),
    );
    expect(at('GET {{baseUrl}}/v1/auth/get-session')).toBeLessThan(
      at('POST {{baseUrl}}/v1/auth/sign-out'),
    );
    expect(at('POST {{baseUrl}}/v1/auth/sign-out')).toBeLessThan(at('### Get shopping cart'));
    expect(http).toContain('"firstName"');
    expect(http).toContain('"lastName"');
    expect(http).toMatch(/^# .*authentication handler.*not .*OpenAPI/m);
    // Module order (cart, orders, search, seo), then path order inside a module.
    expect(at('### Get shopping cart')).toBeLessThan(at('### Update cart item'));
    expect(at('### Update cart item')).toBeLessThan(at('### Create order'));
    expect(at('### Create order')).toBeLessThan(at('### Search products'));
    expect(at('### Search products')).toBeLessThan(at('### Sitemap'));
    // A path parameter becomes a file variable; a required query parameter is filled in.
    expect(http).toContain('PATCH {{baseUrl}}/v1/cart/items/{{itemId}}\n');
    expect(http).toContain('GET {{baseUrl}}/v1/search?q=q\n');
    expect(http).not.toContain('page=');
    // Every request carries the locale; a JSON body carries its type and the sample.
    expect(http.match(/^Accept-Language: \{\{locale\}\}$/gm)).toHaveLength(9);
    expect(http).toContain(
      'PATCH {{baseUrl}}/v1/cart/items/{{itemId}}\nAccept-Language: {{locale}}\nContent-Type: application/json\n\n{\n  "plantedQuantity": 1,\n  "note": "note"\n}\n',
    );
    expect(http).toContain('GET {{baseUrl}}/v1/cart\nAccept-Language: {{locale}}\n\n###');
    expect(http).not.toContain(
      'GET {{baseUrl}}/v1/cart\nAccept-Language: {{locale}}\nContent-Type',
    );
    // The idempotency header goes on the operation the document marks and nowhere else.
    expect(http).toContain(
      'POST {{baseUrl}}/v1/orders\nAccept-Language: {{locale}}\nContent-Type: application/json\nX-Idempotency-Key: {{$guid}}\n\n{\n  "plantedCoupon": "plantedCoupon",\n  "gift": true\n}\n',
    );
    expect(http.match(/X-Idempotency-Key/g)).toHaveLength(1);
    expect(http.endsWith('\n')).toBe(true);
  });

  it('declares every path parameter of the file as a variable after the locale, sorted, and none without one', () => {
    const http = renderHttpFile({
      paths: {
        '/v1/products/{slug}': { get: { summary: 'Product', responses: {} } },
        '/v1/orders/{id}': { get: { summary: 'Order', responses: {} } },
        '/v1/orders/{id}/invoice': { get: { summary: 'Invoice', responses: {} } },
      },
    });
    expect(http).toContain(
      '@baseUrl = https://api.shop.example/api\n@locale = en\n@id = id\n@slug = slug\n\n',
    );
    expect(http.match(/^@\w+ = /gm)).toEqual(['@baseUrl = ', '@locale = ', '@id = ', '@slug = ']);
    const flat = renderHttpFile({
      paths: { '/v1/cart': { get: { summary: 'Cart', responses: {} } } },
    });
    expect(flat).toContain('@baseUrl = https://api.shop.example/api\n@locale = en\n\n');
    expect(flat.match(/^@\w+ = /gm)).toEqual(['@baseUrl = ', '@locale = ']);
  });

  it('puts the header on the routes the controller scan found when the document does not mark them', () => {
    const scanned = ['PATCH /v1/admin/inventory/adjust', 'POST /v1/orders'];
    const document = {
      paths: {
        '/v1/orders': { post: { summary: 'Create order', responses: {} } },
        '/v1/orders/track': { post: { summary: 'Track', responses: {} } },
      },
    };
    const http = renderHttpFile(document, scanned);
    expect(http).toContain(
      'POST {{baseUrl}}/v1/orders\nAccept-Language: {{locale}}\nX-Idempotency-Key: {{$guid}}\n',
    );
    expect(http.match(/X-Idempotency-Key/g)).toHaveLength(1);
    // Without the scan nothing is marked: the hand-maintained list is gone.
    expect(renderHttpFile(document)).not.toContain('X-Idempotency-Key');
    const collection = renderPostmanCollection({ storefront: { paths: {} }, admin }, scanned);
    const adminFolder = collection.item[1];
    const inventory = adminFolder.item.find((folder) => folder.name === 'Inventory');
    const adjust = inventory?.item[0];
    expect(adjust?.request.method).toBe('PATCH');
    expect(adjust?.request.header).toContainEqual({ key: 'X-Idempotency-Key', value: '{{$guid}}' });
    const unscanned = renderPostmanCollection({ storefront: { paths: {} }, admin });
    expect(JSON.stringify(unscanned)).not.toContain('X-Idempotency-Key');
  });

  it('writes the collection: one folder per audience, one per module, one request per operation, cookies for auth', () => {
    const collection = renderPostmanCollection({ storefront, admin });
    expect(collection.info.name).toBe('The Merchant Engine API');
    expect(collection.info.schema).toBe(
      'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    );
    expect(JSON.stringify(collection)).not.toMatch(/token|prerequest|bearer/i);
    expect(collection.item.map((folder) => folder.name)).toEqual(['Storefront', 'Admin']);
    const [storefrontFolder, adminFolder] = collection.item;
    expect(storefrontFolder.item.map((folder) => folder.name)).toEqual([
      'Authentication',
      'Cart',
      'Orders',
      'Search',
      'Seo',
    ]);
    expect(adminFolder.item.map((folder) => folder.name)).toEqual(['Carriers', 'Inventory']);
    expect(adminFolder.description).toMatch(/same .*handler|Authentication/);
    const auth = storefrontFolder.item[0];
    expect(auth.description).toMatch(/authentication handler/);
    expect(auth.description).toMatch(/admin/i);
    expect(auth.item.map((item) => [item.request.method, item.request.url.raw])).toEqual([
      ['POST', '{{baseUrl}}/v1/auth/sign-up/email'],
      ['POST', '{{baseUrl}}/v1/auth/sign-in/email'],
      ['GET', '{{baseUrl}}/v1/auth/get-session'],
      ['POST', '{{baseUrl}}/v1/auth/sign-out'],
    ]);
    expect(auth.item[0].request.body?.raw).toContain('"firstName"');
    const cart = storefrontFolder.item[1];
    expect(cart.item.map((item) => item.name)).toEqual(['Get shopping cart', 'Update cart item']);
    const update = cart.item[1];
    expect(update.request.url).toEqual({
      raw: '{{baseUrl}}/v1/cart/items/:itemId',
      host: ['{{baseUrl}}'],
      path: ['v1', 'cart', 'items', ':itemId'],
      variable: [{ key: 'itemId', value: '' }],
    });
    expect(update.request.header).toEqual([
      { key: 'Accept-Language', value: '{{locale}}' },
      { key: 'Content-Type', value: 'application/json' },
    ]);
    expect(update.request.body).toEqual({
      mode: 'raw',
      raw: '{\n  "plantedQuantity": 1,\n  "note": "note"\n}',
      options: { raw: { language: 'json' } },
    });
    expect(cart.item[0].request.body).toBeUndefined();
    const search = storefrontFolder.item[3].item[0];
    expect(search.request.url.raw).toBe('{{baseUrl}}/v1/search?q=q');
    expect(search.request.url.query).toEqual([{ key: 'q', value: 'q' }]);
    const order = storefrontFolder.item[2].item[0];
    expect(order.request.header).toContainEqual({ key: 'X-Idempotency-Key', value: '{{$guid}}' });
    expect(order.request.body?.raw).toContain('"plantedCoupon": "plantedCoupon"');
    const adjust = adminFolder.item[1].item[0];
    expect(adjust.request.body?.raw).toContain('"plantedDelta": 1');
  });

  it('writes the environment with the local base URL and the locale, both enabled', () => {
    expect(postmanEnvironment()).toEqual({
      name: 'The Merchant Engine (local)',
      values: [
        { key: 'baseUrl', value: 'http://localhost:53000/api', enabled: true },
        { key: 'locale', value: 'en', enabled: true },
      ],
    });
  });

  it('is written by generateReference, and a hand edit of the HTTP file fails the check', () => {
    const out = tmp();
    const written = generateReference({
      openapiDir: path.join(REFERENCE, '_generated'),
      outDir: out,
      warn: () => undefined,
    });
    expect(written).toEqual(
      expect.arrayContaining([
        '_generated/storefront-api.http',
        '_generated/postman-collection.json',
        '_generated/postman-environment.json',
      ]),
    );
    const http = fs.readFileSync(path.join(out, '_generated', 'storefront-api.http'), 'utf8');
    expect(http.split('\n')[0]).toBe(`# generated by ${GENERATED_BY}; do not edit`);
    expect(http).toContain('POST {{baseUrl}}/v1/orders\n');
    for (const file of ['postman-collection.json', 'postman-environment.json']) {
      const parsed = JSON.parse(fs.readFileSync(path.join(out, '_generated', file), 'utf8'));
      expect(Object.keys(parsed)[0]).toBe('x-generated-by');
    }
    // The idempotency header lands on the seven scanned routes of both audiences, and nowhere else.
    const collection: PostmanCollection = JSON.parse(
      fs.readFileSync(path.join(out, '_generated', 'postman-collection.json'), 'utf8'),
    );
    const marked = collection.item
      .flatMap((audience) => audience.item)
      .flatMap((folder) => folder.item)
      .filter((item) => item.request.header.some((header) => header.key === 'X-Idempotency-Key'))
      .map(
        (item) =>
          `${item.request.method} ${item.request.url.raw.replace('{{baseUrl}}', '').replace(/:(\w+)/g, '{$1}')}`,
      )
      .sort();
    expect(marked).toEqual(IDEMPOTENT_TODAY);
    expect(http.match(/X-Idempotency-Key/g)).toHaveLength(1);
    expect(http).toContain(
      'POST {{baseUrl}}/v1/orders\nAccept-Language: {{locale}}\nContent-Type: application/json\nX-Idempotency-Key: {{$guid}}\n',
    );
    const committed = tmp();
    fs.cpSync(out, committed, { recursive: true });
    fs.appendFileSync(path.join(committed, '_generated', 'storefront-api.http'), '\n### By hand\n');
    expect(diffTrees(out, committed)).toEqual(['_generated/storefront-api.http: differs']);
  });
});

describe('renderPage', () => {
  const front = {
    title: 'T',
    description: 'D: with a colon',
    primaryQuery: 'q',
    schema: 'TechArticle' as const,
  };

  it('quotes the frontmatter, opens the body with the marker, and dates a new page today', () => {
    const page = renderPage(front, 'Body.', path.join(tmp(), 'missing.md'));
    expect(page).toMatch(
      /^---\ntitle: "T"\ndescription: "D: with a colon"\nprimaryQuery: "q"\nupdated: \d{4}-\d{2}-\d{2}\nschema: TechArticle\n---\n\n/,
    );
    expect(page).toContain(`${PAGE_MARKER}\n\nBody.\n`);
  });

  it('keeps the committed date while the body is unchanged and bumps it when the body changes', () => {
    const committed = plantFile(
      tmp(),
      'page.md',
      `---\ntitle: "T"\ndescription: "D"\nprimaryQuery: "q"\nupdated: 2020-01-02\nschema: TechArticle\n---\n\n${PAGE_MARKER}\n\nBody.\n`,
    );
    expect(renderPage(front, 'Body.', committed)).toContain('updated: 2020-01-02');
    expect(renderPage(front, 'Body changed.', committed)).not.toContain('updated: 2020-01-02');
  });
});

describe('diffTrees', () => {
  it('reports a changed, a missing and an extra file, and nothing on identical trees', () => {
    const fresh = tmp();
    const committed = tmp();
    plantFile(fresh, 'a.md', 'same');
    plantFile(committed, 'a.md', 'same');
    expect(diffTrees(fresh, committed)).toEqual([]);
    plantFile(fresh, 'b.md', 'new');
    plantFile(committed, 'a.md', 'edited by hand');
    plantFile(committed, 'c.md', 'stale');
    expect(diffTrees(fresh, committed)).toEqual([
      'a.md: differs',
      'b.md: missing from the committed tree',
      'c.md: not written by the generator',
    ]);
  });
});

describe('the committed reference tree', () => {
  it('is what the generator writes from the committed OpenAPI export', () => {
    const out = tmp();
    generateReference({
      openapiDir: path.join(REFERENCE, '_generated'),
      outDir: out,
      warn: () => undefined,
    });
    expect(diffTrees(out, REFERENCE)).toEqual([]);
  });

  it('raises no warning: no code thrown with two statuses, no route argument the scan could not resolve', () => {
    const warnings: string[] = [];
    generateReference({
      openapiDir: path.join(REFERENCE, '_generated'),
      outDir: tmp(),
      warn: (line) => warnings.push(line),
    });
    expect(warnings).toEqual([]);
  });
});

describe('sortEnums', () => {
  it('sorts every string enum at any depth and leaves other arrays alone', () => {
    const input = {
      a: { enum: ['b', 'a', 'c'] },
      list: [{ items: { enum: ['z', 'y'] } }],
      numbers: { enum: [3, 1, 2] },
      order: ['b', 'a'],
    };
    expect(sortEnums(input)).toEqual({
      a: { enum: ['a', 'b', 'c'] },
      list: [{ items: { enum: ['y', 'z'] } }],
      numbers: { enum: [3, 1, 2] },
      order: ['b', 'a'],
    });
  });

  it('gives the same output for two orders of the same enum', () => {
    expect(sortEnums({ enum: ['x', 'y'] })).toEqual(sortEnums({ enum: ['y', 'x'] }));
  });
});
