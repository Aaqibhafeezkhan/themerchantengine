import 'reflect-metadata';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { UpdateCustomerAdminDto } from './update-customer.dto';
import { UpdateStaffDto } from './update-staff.dto';

async function errorsFor(cls: new () => object, payload: object): Promise<string[]> {
  const errors = await validate(plainToInstance(cls, payload));
  return errors.map((e) => e.property);
}

describe.each([
  ['UpdateStaffDto', UpdateStaffDto],
  ['UpdateCustomerAdminDto', UpdateCustomerAdminDto],
])('%s names', (_label, cls) => {
  it('rejects a blank first or last name', async () => {
    expect(await errorsFor(cls, { firstName: '' })).toEqual(['firstName']);
    expect(await errorsFor(cls, { lastName: '' })).toEqual(['lastName']);
  });

  it('accepts a normal name and leaves both optional', async () => {
    expect(await errorsFor(cls, { firstName: 'Sam', lastName: 'Lee' })).toEqual([]);
    expect(await errorsFor(cls, {})).toEqual([]);
  });
});
