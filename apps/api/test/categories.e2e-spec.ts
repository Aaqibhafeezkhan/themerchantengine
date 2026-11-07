import { PrismaClient } from '@prisma/client';
import { ADMIN, api, createTestPrisma, loginAs, STORE_CONFIG } from '../../../test/e2e/helpers';

// ═══════════════════════════════════════════════════════════════════════════════
// Accept-Language matrix (§1.14 BLOCKER 6 — E5)
// ═══════════════════════════════════════════════════════════════════════════════
//
// Closes the §1.14 BLOCKER 6 finding for the categories module ("Accept-Language
// e2e coverage missing on … categories"). The file is intentionally minimal —
// scoped to the resolution matrix only. Broader categories e2e coverage is
// out of E5 scope per plan §6.
//
// Targets the public storefront routes `GET /v1/categories` and
// `GET /v1/categories/:slug`. The matrix seeds one category with multi-locale
// Translatable `name` + `description` and verifies the global
// `TranslatableInterceptor` resolves the response correctly per Accept-Language
// header and surfaces the full object under the `X-Resolve-Locale: false`
// admin opt-out.

describe('Categories Accept-Language matrix (E5 §1.14 BLOCKER 6)', () => {
  const MATRIX_SLUG = `e2e-matrix-cat-${Date.now()}`;
  let matrixPrisma: PrismaClient;
  let matrixCategoryId: string;

  beforeAll(async () => {
    matrixPrisma = createTestPrisma();

    await matrixPrisma.category.deleteMany({ where: { slug: MATRIX_SLUG } });

    const category = await matrixPrisma.category.create({
      data: {
        slug: MATRIX_SLUG,
        name: {
          default: 'Catégorie matrice FR',
          fr: 'Catégorie matrice FR',
          en: 'Matrix Category EN',
        },
        description: {
          default: 'Description de catégorie FR',
          fr: 'Description de catégorie FR',
          en: 'EN category description',
        },
        path: `/${MATRIX_SLUG}/`,
        depth: 0,
      },
    });
    matrixCategoryId = category.id;
  });

  afterAll(async () => {
    await matrixPrisma.category.deleteMany({ where: { id: matrixCategoryId } });
    await matrixPrisma.$disconnect();
  });

  it('GET /v1/categories/:slug resolves name to en when Accept-Language: en', async () => {
    const res = await api().get(`/v1/categories/${MATRIX_SLUG}`).set('Accept-Language', 'en');
    expect(res.status).toBe(200);
    expect(res.body.data?.name).toBe('Matrix Category EN');
  });

  it('GET /v1/categories/:slug resolves name to fr when Accept-Language: fr', async () => {
    const res = await api().get(`/v1/categories/${MATRIX_SLUG}`).set('Accept-Language', 'fr');
    expect(res.status).toBe(200);
    expect(res.body.data?.name).toBe('Catégorie matrice FR');
  });

  it('GET /v1/categories/:slug returns full Translatable object when X-Resolve-Locale: false', async () => {
    const res = await api().get(`/v1/categories/${MATRIX_SLUG}`).set('X-Resolve-Locale', 'false');
    expect(res.status).toBe(200);
    expect(res.body.data?.name).toEqual({
      default: 'Catégorie matrice FR',
      fr: 'Catégorie matrice FR',
      en: 'Matrix Category EN',
    });
  });

  it('GET /v1/categories/:slug falls through to the store default rung on an unsupported Accept-Language (de)', async () => {
    const res = await api().get(`/v1/categories/${MATRIX_SLUG}`).set('Accept-Language', 'de');
    expect(res.status).toBe(200);
    // The chain is the requested locale, then the store default, then
    // `default` (DR-31). `default` and `fr` carry the same value and `en`
    // differs, so on an en-default store only that rung produces the string.
    const expected =
      STORE_CONFIG.localization.defaultLocale === 'en'
        ? 'Matrix Category EN'
        : 'Catégorie matrice FR';
    expect(res.body.data?.name).toBe(expected);
  });
});

describe('Categories admin slug conflicts', () => {
  const SLUG = `e2e-slug-cat-${Date.now()}`;
  const OTHER_SLUG = `${SLUG}-other`;
  let prisma: PrismaClient;
  let adminCookie: string;

  const body = (slug: string) => ({ name: { default: slug, en: slug, fr: slug }, slug });

  beforeAll(async () => {
    prisma = createTestPrisma();
    adminCookie = await loginAs(ADMIN.email, ADMIN.password);
  });

  afterAll(async () => {
    await prisma.category.deleteMany({ where: { slug: { in: [SLUG, OTHER_SLUG] } } });
    await prisma.$disconnect();
  });

  it('POST /v1/admin/categories returns 409 CATEGORY_SLUG_TAKEN for a slug already in use', async () => {
    await api()
      .post('/v1/admin/categories')
      .set('Cookie', adminCookie)
      .send(body(SLUG))
      .expect(201);

    const res = await api()
      .post('/v1/admin/categories')
      .set('Cookie', adminCookie)
      .send(body(SLUG));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CATEGORY_SLUG_TAKEN');
  });

  it('PATCH /v1/admin/categories/:id returns 409 CATEGORY_SLUG_TAKEN when claiming another slug', async () => {
    const other = await api()
      .post('/v1/admin/categories')
      .set('Cookie', adminCookie)
      .send(body(OTHER_SLUG))
      .expect(201);

    const res = await api()
      .patch(`/v1/admin/categories/${other.body.data.id}`)
      .set('Cookie', adminCookie)
      .send({ slug: SLUG });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CATEGORY_SLUG_TAKEN');
  });
});
