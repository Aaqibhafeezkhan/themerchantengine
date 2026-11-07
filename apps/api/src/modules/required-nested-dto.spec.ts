import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateProductAdminDto } from './products/dto/create-product.dto';
import { CreateCategoryAdminDto } from './categories/dto/create-category.dto';
import { CreateProductTypeAdminDto } from './products/dto/create-product-type.dto';
import { CreateAttributeAdminDto } from './products/dto/create-attribute.dto';
import { CreatePromotionAdminDto } from './promotions/dto/create-promotion.dto';

const cases: [string, new () => object, string][] = [
  ['CreateProductAdminDto', CreateProductAdminDto, 'name'],
  ['CreateCategoryAdminDto', CreateCategoryAdminDto, 'name'],
  ['CreateProductTypeAdminDto', CreateProductTypeAdminDto, 'name'],
  ['CreateAttributeAdminDto', CreateAttributeAdminDto, 'name'],
  ['CreatePromotionAdminDto', CreatePromotionAdminDto, 'name'],
];

describe('required nested Translatable fields', () => {
  it.each(cases)('%s rejects a body without %s', async (_n, cls, field) => {
    const errors = await validate(plainToInstance(cls, {}));
    expect(errors.some((e) => e.property === field)).toBe(true);
  });
});
