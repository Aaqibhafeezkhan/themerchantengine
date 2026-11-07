import * as z from 'zod';
import { entityIdSchema, paginationMetaSchema, translatableSchema } from '@admin-types';

/** Provider ids come from the API catalogue, so a new provider needs no admin change. */
export const paymentProviderSchema = z.string().regex(/^[a-z][a-z0-9_]*$/);
export type PaymentProvider = z.infer<typeof paymentProviderSchema>;

export const paymentActionTypeSchema = z.enum(['none', 'redirect', 'form_post', 'embedded']);
export type PaymentActionType = z.infer<typeof paymentActionTypeSchema>;

/** One registered provider as `GET /v1/admin/payment-providers` returns it. */
export const paymentProviderCatalogueEntrySchema = z.object({
  id: paymentProviderSchema,
  label: z.string(),
  actionTypes: z.array(paymentActionTypeSchema),
  secretFields: z.array(z.string()),
  configJsonSchema: z.record(z.string(), z.unknown()),
});
export type PaymentProviderCatalogueEntry = z.infer<typeof paymentProviderCatalogueEntrySchema>;

export const paymentProviderCatalogueResponseSchema = z.array(paymentProviderCatalogueEntrySchema);

export const paymentMethodSchema = z.object({
  id: entityIdSchema,
  code: z.string(),
  name: translatableSchema,
  description: translatableSchema.nullable().optional(),
  provider: paymentProviderSchema,
  isActive: z.boolean(),
  isTestMode: z.boolean(),
  sortOrder: z.number().int().nonnegative(),
  /** Secrets arrive masked as `***`; non-secret keys pass through as-is. */
  config: z.record(z.string(), z.unknown()),
  createdAt: z.union([z.string().datetime(), z.date()]).optional(),
  updatedAt: z.union([z.string().datetime(), z.date()]).optional(),
});
export type PaymentMethod = z.infer<typeof paymentMethodSchema>;

export const listPaymentMethodsQuerySchema = z.object({
  page: z.number().int().positive().optional(),
  pageSize: z.number().int().positive().max(100).optional(),
  provider: paymentProviderSchema.optional(),
  isActive: z.boolean().optional(),
});
export type ListPaymentMethodsQuery = z.infer<typeof listPaymentMethodsQuerySchema>;

export const listPaymentMethodsResponseSchema = z.object({
  data: z.array(paymentMethodSchema),
  meta: paginationMetaSchema,
});
export type ListPaymentMethodsResponse = z.infer<typeof listPaymentMethodsResponseSchema>;

export const createPaymentMethodRequestSchema = z.object({
  code: z
    .string()
    .min(2)
    .max(50)
    .regex(/^[a-z0-9_]+$/, 'lowercase letters, digits, underscores only'),
  name: translatableSchema,
  description: translatableSchema.optional(),
  provider: paymentProviderSchema,
  isActive: z.boolean().optional(),
  isTestMode: z.boolean().optional(),
  sortOrder: z.number().int().nonnegative().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});
export type CreatePaymentMethodRequest = z.infer<typeof createPaymentMethodRequestSchema>;

export const updatePaymentMethodRequestSchema = z.object({
  name: translatableSchema.optional(),
  description: translatableSchema.optional(),
  isActive: z.boolean().optional(),
  isTestMode: z.boolean().optional(),
  sortOrder: z.number().int().nonnegative().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});
export type UpdatePaymentMethodRequest = z.infer<typeof updatePaymentMethodRequestSchema>;

export const reorderPaymentMethodsRequestSchema = z.object({
  ids: z.array(entityIdSchema).min(1).max(100),
});
export type ReorderPaymentMethodsRequest = z.infer<typeof reorderPaymentMethodsRequestSchema>;
