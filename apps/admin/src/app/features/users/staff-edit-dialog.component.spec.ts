import { ApiForbiddenError, ApiNotFoundError } from '@admin-types';
import { DialogRef, DIALOG_DATA } from '@angular/cdk/dialog';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { UsersService } from '@admin-services';
import type { AdminUser } from '@admin-types';
import { axe, toHaveNoViolations } from 'jest-axe';
import { of, throwError } from 'rxjs';
import { StaffEditDialogComponent } from './staff-edit-dialog.component';

expect.extend(toHaveNoViolations);

const staffFixture: AdminUser = {
  id: 's1',
  email: 'staffer@example.com',
  firstName: 'Old',
  lastName: 'Name',
  roles: [{ id: 'r-admin', name: 'Admin', permissions: [] }],
  permissions: [],
  status: 'active',
};

describe('StaffEditDialogComponent', () => {
  let fixture: ComponentFixture<StaffEditDialogComponent>;
  let dialog: StaffEditDialogComponent;
  let updateSpy: jest.Mock;
  let closeSpy: jest.Mock;

  function configure(staff: AdminUser = staffFixture, roles: unknown[] = []) {
    TestBed.configureTestingModule({
      providers: [
        { provide: UsersService, useValue: { updateStaff: updateSpy } },
        { provide: DialogRef, useValue: { close: closeSpy } },
        { provide: DIALOG_DATA, useValue: { staff, roles } },
      ],
    });
    fixture = TestBed.createComponent(StaffEditDialogComponent);
    dialog = fixture.componentInstance;
    fixture.detectChanges();
  }

  beforeEach(() => {
    updateSpy = jest.fn(() => of({ ...staffFixture, firstName: 'NewFirst' }));
    closeSpy = jest.fn();
  });

  it('seeds the form from the injected staff', () => {
    configure();
    expect(dialog.form.controls.firstName.value).toBe('Old');
    expect(dialog.form.controls.lastName.value).toBe('Name');
    expect(dialog.form.controls.role.value).toBe('ADMIN');
  });

  it('seeds the role from the list row shape (role enum and customRole)', () => {
    configure({
      ...staffFixture,
      roles: [],
      role: 'MANAGER',
      customRole: { id: 'r-mgr', name: 'Manager' },
    } as AdminUser);
    expect(dialog.form.controls.role.value).toBe('MANAGER');
    expect(dialog.form.controls.roleId.value).toBe('r-mgr');
  });

  it('sends only dirty fields on submit (firstName only)', () => {
    configure();
    dialog.form.controls.firstName.setValue('NewFirst');
    dialog.form.controls.firstName.markAsDirty();
    dialog.submit();
    expect(updateSpy).toHaveBeenCalledWith('s1', { firstName: 'NewFirst' });
  });

  it('submit with no change sends nothing and closes without a result', () => {
    configure();
    dialog.submit();
    expect(updateSpy).not.toHaveBeenCalled();
    expect(closeSpy).toHaveBeenCalledWith(null);
  });

  it('closes with the refreshed staff on success', () => {
    configure();
    dialog.form.controls.firstName.setValue('NewFirst');
    dialog.form.controls.firstName.markAsDirty();
    dialog.submit();
    expect(closeSpy).toHaveBeenCalledWith(expect.objectContaining({ firstName: 'NewFirst' }));
  });

  it('surfaces ApiForbiddenError in the alert banner', () => {
    updateSpy = jest.fn(() =>
      throwError(() => new ApiForbiddenError({ code: 'FORBIDDEN', message: 'nope' })),
    );
    configure();
    dialog.form.controls.firstName.setValue('x');
    dialog.form.controls.firstName.markAsDirty();
    dialog.submit();
    expect(dialog.errorMessage()).toContain('permission');
    expect(closeSpy).not.toHaveBeenCalled();
  });

  it('surfaces ApiNotFoundError in the alert banner', () => {
    updateSpy = jest.fn(() =>
      throwError(() => new ApiNotFoundError({ code: 'NOT_FOUND', message: 'missing' })),
    );
    configure();
    dialog.form.controls.firstName.setValue('x');
    dialog.form.controls.firstName.markAsDirty();
    dialog.submit();
    expect(dialog.errorMessage()).toContain('not be found');
  });

  it('cancel closes with null', () => {
    configure();
    dialog.cancel();
    expect(closeSpy).toHaveBeenCalledWith(null);
  });

  it('has no axe violations (clean render)', async () => {
    configure();
    const results = await axe(fixture.nativeElement);
    expect(results).toHaveNoViolations();
  });

  it('has no axe violations with error banner', async () => {
    updateSpy = jest.fn(() =>
      throwError(() => new ApiForbiddenError({ code: 'FORBIDDEN', message: 'nope' })),
    );
    configure();
    dialog.form.controls.firstName.setValue('x');
    dialog.form.controls.firstName.markAsDirty();
    dialog.submit();
    fixture.detectChanges();
    const results = await axe(fixture.nativeElement);
    expect(results).toHaveNoViolations();
  });
});
