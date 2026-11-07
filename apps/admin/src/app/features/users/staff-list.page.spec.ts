import { ApiForbiddenError, ApiNotFoundError } from '@admin-types';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RolesService, UsersService } from '@admin-services';
import * as adminUi from '@admin-ui';
import { axe, toHaveNoViolations } from 'jest-axe';
import { of, throwError } from 'rxjs';
import { AuthStore } from '../../core/stores/auth.store';
import { BOOTSTRAP_LOCALE } from '../../core/tokens';
import * as editDialog from './staff-edit-dialog.component';
import { StaffListPage } from './staff-list.page';

expect.extend(toHaveNoViolations);

// Mirrors what GET /v1/admin/staff actually sends: a base `role` enum, an
// optional `customRole`, and `isActive` — never a `roles[]` array.
const staffRows = [
  {
    id: 's1',
    email: 'admin@example.com',
    firstName: 'Root',
    lastName: 'Admin',
    roles: [],
    permissions: [],
    role: 'ADMIN' as const,
    customRole: { id: 'r1', name: 'Catalog editor' },
    isActive: true,
    status: 'active' as const,
  },
  {
    id: 's2',
    email: 'support@example.com',
    firstName: 'Sally',
    lastName: 'Support',
    roles: [],
    permissions: [],
    role: 'SUPPORT' as const,
    customRole: null,
    isActive: true,
    status: 'active' as const,
  },
];

const superAdminRow = {
  id: 's3',
  email: 'superadmin@merchants.test',
  firstName: 'Super',
  lastName: 'Admin',
  roles: [],
  permissions: [],
  role: 'SUPER_ADMIN' as const,
  customRole: null,
  isActive: true,
  status: 'active' as const,
};

const deactivatedRow = {
  ...staffRows[1],
  id: 's4',
  email: 'gone@example.com',
  isActive: false,
  status: 'inactive' as const,
};

describe('StaffListPage', () => {
  let fixture: ComponentFixture<StaffListPage>;
  let page: StaffListPage;
  let listSpy: jest.Mock;
  let rolesSpy: jest.Mock;
  let createSpy: jest.Mock;
  let updateSpy: jest.Mock;
  let deactivateSpy: jest.Mock;
  let confirmSpy: jest.SpyInstance;
  let editDialogSpy: jest.SpyInstance;

  function configure(
    perms: string[] = [
      'admin_users:view',
      'admin_users:create',
      'admin_users:update',
      'admin_users:manage',
    ],
  ) {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: '**', children: [] }]),
        { provide: BOOTSTRAP_LOCALE, useValue: 'fr' },
        {
          provide: UsersService,
          useValue: {
            listStaff: listSpy,
            createStaff: createSpy,
            updateStaff: updateSpy,
            deactivateStaff: deactivateSpy,
          },
        },
        { provide: RolesService, useValue: { list: rolesSpy } },
      ],
    });
    TestBed.inject(AuthStore).setSession({
      user: { id: 'u', email: 'a@b', permissions: perms, roles: [], status: 'active' },
    });
    fixture = TestBed.createComponent(StaffListPage);
    page = fixture.componentInstance;
    fixture.detectChanges();
  }

  beforeEach(() => {
    listSpy = jest.fn(() => of({ data: staffRows, meta: { page: 1, pageSize: 20, total: 2 } }));
    rolesSpy = jest.fn(() => of([]));
    createSpy = jest.fn((body: Record<string, unknown>) =>
      of({ ...staffRows[0], id: 's-new', email: body['email'] }),
    );
    updateSpy = jest.fn(() => of({ ...staffRows[0], firstName: 'Edited' }));
    deactivateSpy = jest.fn(() => of(undefined));
    confirmSpy = jest.spyOn(adminUi, 'openConfirmDialog').mockResolvedValue(true);
    editDialogSpy = jest
      .spyOn(editDialog, 'openStaffEditDialog')
      .mockResolvedValue({ ...staffRows[0], firstName: 'Edited' } as never);
  });

  afterEach(() => {
    confirmSpy.mockRestore();
    editDialogSpy.mockRestore();
  });

  it('loads staff rows', () => {
    configure();
    expect(page.rows()).toHaveLength(2);
  });

  it('shows Deactivate only with admin_users:delete or admin_users:manage', () => {
    configure(['admin_users:view', 'admin_users:create', 'admin_users:update']);
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('[data-testid^="staff-edit-"]')).toBeTruthy();
    expect(host.querySelector('[data-testid^="staff-deactivate-"]')).toBeNull();
  });

  it('shows Deactivate with admin_users:delete', () => {
    configure(['admin_users:view', 'admin_users:delete']);
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('[data-testid^="staff-deactivate-"]')).toBeTruthy();
  });

  it('canCreate requires admin_users:create or admin_users:manage', () => {
    configure(['admin_users:view']);
    expect(page.canCreate()).toBe(false);
  });

  it('password validator rejects weak passwords', () => {
    configure();
    page.createForm.controls.password.setValue('weakpass');
    page.createForm.controls.password.markAsTouched();
    expect(page.passwordError()).toContain('upper');
  });

  it('submitCreate posts a valid body + re-fetches', () => {
    configure();
    page.createForm.setValue({
      firstName: 'New',
      lastName: 'Staff',
      email: 'new@example.com',
      password: 'StrongPass1',
      role: 'SUPPORT',
      roleId: '',
    });
    page.submitCreate();
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'new@example.com', role: 'SUPPORT' }),
    );
  });

  it('confirmDeactivate requires confirm + calls service.deactivateStaff', async () => {
    configure();
    await page.confirmDeactivate(staffRows[0] as never);
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(deactivateSpy).toHaveBeenCalledWith('s1');
  });

  it('ApiForbiddenError maps to permission-safe error', () => {
    listSpy = jest.fn(() =>
      throwError(() => new ApiForbiddenError({ code: 'FORBIDDEN', message: 'nope' })),
    );
    configure();
    expect(page.error()).toContain('permission');
  });

  it('ApiNotFoundError maps to staff-not-found error', () => {
    listSpy = jest.fn(() =>
      throwError(() => new ApiNotFoundError({ code: 'NOT_FOUND', message: 'missing' })),
    );
    configure();
    expect(page.error()).toBe('Staff member not found.');
  });

  it('canEdit requires admin_users:update or admin_users:manage', () => {
    configure(['admin_users:view']);
    expect(page.canEdit()).toBe(false);
  });

  it('canEdit is true when the user has admin_users:update', () => {
    configure(['admin_users:view', 'admin_users:update']);
    expect(page.canEdit()).toBe(true);
  });

  it('editStaff opens the dialog and splices the refreshed row into the list', async () => {
    configure();
    await page.editStaff(staffRows[0] as never);
    expect(editDialogSpy).toHaveBeenCalledTimes(1);
    expect(page.rows().find((r) => r.id === 's1')?.firstName).toBe('Edited');
  });

  it('editStaff is a no-op when the dialog is cancelled', async () => {
    editDialogSpy.mockResolvedValueOnce(null as never);
    configure();
    await page.editStaff(staffRows[0] as never);
    expect(page.rows().find((r) => r.id === 's1')?.firstName).toBe('Root');
  });

  // ── Plan F, findings F6 + F7 ────────────────────────────────────────────

  it('renders the base role, plus the custom role when there is one', () => {
    configure();
    const cell = (id: string) =>
      (
        fixture.nativeElement.querySelector(`[data-testid="staff-roles-${id}"]`) as HTMLElement
      ).textContent?.trim();

    expect(cell('s1')).toBe('Admin · Catalog editor');
    expect(cell('s2')).toBe('Support');
    expect(cell('s1')).not.toBe('—');
  });

  it('shows super admins read-only', () => {
    listSpy = jest.fn(() =>
      of({ data: [...staffRows, superAdminRow], meta: { page: 1, pageSize: 20, total: 3 } }),
    );
    configure();

    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('[data-testid="staff-roles-s3"]')?.textContent?.trim()).toBe(
      'Super admin',
    );
    expect(host.querySelector('[data-testid="staff-edit-s3"]')).toBeNull();
    expect(host.querySelector('[data-testid="staff-deactivate-s3"]')).toBeNull();
    expect(host.querySelector('[data-testid="staff-unmanaged-s3"]')).toBeTruthy();
    // The manageable rows keep their buttons.
    expect(host.querySelector('[data-testid="staff-edit-s1"]')).toBeTruthy();
  });

  it('renders a deactivated staff member as Inactive with no actions', () => {
    listSpy = jest.fn(() =>
      of({ data: [deactivatedRow], meta: { page: 1, pageSize: 20, total: 1 } }),
    );
    configure();

    const row = fixture.nativeElement.querySelector('[data-testid="staff-row-s4"]') as HTMLElement;
    expect(row.textContent).toContain('Inactive');
    expect(row.querySelector('[data-testid="staff-edit-s4"]')).toBeNull();
    expect(row.querySelector('[data-testid="staff-deactivate-s4"]')).toBeNull();
  });

  it('offers a Super admin filter chip', () => {
    configure();
    expect(page.roleOptions.map((o) => o.value)).toContain('SUPER_ADMIN');
  });

  it('drops the Last login column that had no data source', () => {
    configure();
    const headers = [...(fixture.nativeElement as HTMLElement).querySelectorAll('th')].map((th) =>
      th.textContent?.trim(),
    );
    expect(headers).not.toContain('Last login');
  });

  it('has no axe violations', async () => {
    configure();
    const results = await axe(fixture.nativeElement);
    expect(results).toHaveNoViolations();
  });
});
