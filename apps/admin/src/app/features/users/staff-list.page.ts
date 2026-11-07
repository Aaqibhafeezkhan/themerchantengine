import { Dialog } from '@angular/cdk/dialog';
import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import {
  BadgeComponent,
  ButtonComponent,
  FormFieldComponent,
  InputComponent,
  LoadErrorComponent,
  openConfirmDialog,
  PaginationComponent,
  SkeletonComponent,
} from '@admin-ui';
import {
  RolesService,
  UsersService,
  listStaffRoleSchema,
  type CreateStaffRequest,
  type ListStaffQuery,
  type ListStaffRole,
  type Role,
  type StaffMember,
  type StaffRole,
} from '@admin-services';
import { ApiConflictError, ApiError, ApiForbiddenError, ApiNotFoundError } from '@admin-types';
import { Subject, takeUntil } from 'rxjs';
import { AuthStore } from '../../core/stores/auth.store';
import { openStaffEditDialog } from './staff-edit-dialog.component';
import {
  fullName,
  initials,
  roleLabel,
  staffRolesLabel,
  statusLabel,
  statusTone,
} from './users.utils';

/**
 * `/staff` — paginated staff list + inline "Add staff" dialog.
 *
 * The create flow uses the same reactive form pattern as every other
 * editor — validated client-side (strong-password policy per the Zod
 * schema), submitted via `UsersService.createStaff`. Deactivation
 * requires a confirm dialog because it's audit-logged on the backend.
 * Role catalogue is fetched in parallel so the dropdown populates
 * without blocking the table.
 */
@Component({
  selector: 'app-staff-list-page',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    BadgeComponent,
    ButtonComponent,
    FormFieldComponent,
    InputComponent,
    LoadErrorComponent,
    SkeletonComponent,
    PaginationComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="p-6 md:p-10 flex flex-col gap-8" data-testid="staff-list-page">
      <header class="flex items-end justify-between gap-6 flex-wrap">
        <div>
          <p class="text-xs tracking-widest uppercase text-ink-muted">People</p>
          <h1 class="mt-2 text-4xl md:text-5xl font-bold tracking-tight">Staff</h1>
          <p class="mt-3 text-sm text-ink-muted max-w-xl">
            Admin accounts with back-office access. Deactivation is audit-logged.
          </p>
        </div>
        <div
          class="flex items-center gap-2 flex-wrap"
          role="group"
          aria-label="Filter staff by role"
        >
          @for (opt of roleOptions; track opt.value) {
            <button
              type="button"
              class="text-xs tracking-widest uppercase px-3 py-2 min-h-[44px] border focus-visible:outline-2 focus-visible:outline-ink focus-visible:outline-offset-2"
              [class.border-ink]="role() === opt.value"
              [class.text-ink]="role() === opt.value"
              [class.border-line]="role() !== opt.value"
              [class.text-ink-muted]="role() !== opt.value"
              [attr.aria-pressed]="role() === opt.value"
              [attr.data-testid]="'staff-role-filter-' + (opt.value ?? 'all')"
              (click)="setRole(opt.value)"
            >
              {{ opt.label }}
            </button>
          }
        </div>
      </header>

      @if (rolesError()) {
        <app-load-error
          [message]="rolesError()!"
          [compact]="true"
          [retrying]="rolesLoading()"
          retryLabel="roles"
          testId="staff-roles-degraded"
          (retry)="fetchRoles()"
        />
      }

      <div role="alert" data-testid="staff-error">
        <p class="border border-status-error text-ink p-3 text-xs" [class.sr-only]="!error()">
          {{ error() ?? '' }}
        </p>
      </div>

      <div role="status" aria-live="polite" data-testid="staff-notice">
        <p class="border border-status-success text-ink p-3 text-xs" [class.sr-only]="!notice()">
          {{ notice() ?? '' }}
        </p>
      </div>

      @if (canCreate()) {
        <details
          class="border border-line p-4"
          [attr.open]="formOpen() ? '' : null"
          (toggle)="onToggle($event)"
          data-testid="staff-create-panel"
        >
          <summary
            class="text-xs tracking-widest uppercase text-ink-muted cursor-pointer select-none"
          >
            {{ formOpen() ? 'Close new staff form' : 'Add staff' }}
          </summary>
          <form
            [formGroup]="createForm"
            (ngSubmit)="submitCreate()"
            class="mt-4 flex flex-col gap-4"
            novalidate
          >
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
              <app-form-field label="First name" fieldId="staff-first" [required]="true">
                <app-input
                  id="staff-first"
                  type="text"
                  formControlName="firstName"
                  [invalid]="
                    createForm.controls.firstName.touched && createForm.controls.firstName.invalid
                  "
                ></app-input>
              </app-form-field>
              <app-form-field label="Last name" fieldId="staff-last" [required]="true">
                <app-input
                  id="staff-last"
                  type="text"
                  formControlName="lastName"
                  [invalid]="
                    createForm.controls.lastName.touched && createForm.controls.lastName.invalid
                  "
                ></app-input>
              </app-form-field>
            </div>
            <app-form-field
              label="Email"
              fieldId="staff-email"
              [required]="true"
              [error]="emailError()"
            >
              <app-input
                id="staff-email"
                type="email"
                formControlName="email"
                [invalid]="!!emailError()"
              ></app-input>
            </app-form-field>
            <app-form-field
              label="Password"
              fieldId="staff-password"
              [required]="true"
              [error]="passwordError()"
              hint="Min 8 chars, at least one lower, one upper, one digit."
            >
              <app-input
                id="staff-password"
                type="password"
                formControlName="password"
                [invalid]="!!passwordError()"
                autocomplete="new-password"
              ></app-input>
            </app-form-field>
            <app-form-field label="Role" fieldId="staff-role" [required]="true">
              <select
                id="staff-role"
                class="w-full min-h-[44px] px-3 py-2 text-sm bg-surface text-ink border border-line focus-visible:border-ink focus-visible:outline-2 focus-visible:outline-ink focus-visible:outline-offset-2"
                formControlName="role"
                data-testid="staff-role-select"
              >
                <option value="ADMIN">Admin</option>
                <option value="MANAGER">Manager</option>
                <option value="SUPPORT">Support</option>
              </select>
            </app-form-field>
            @if (roles().length > 0) {
              <app-form-field
                label="Role record (optional)"
                fieldId="staff-role-id"
                hint="Overrides the enum with a custom role entry."
              >
                <select
                  id="staff-role-id"
                  class="w-full min-h-[44px] px-3 py-2 text-sm bg-surface text-ink border border-line focus-visible:border-ink focus-visible:outline-2 focus-visible:outline-ink focus-visible:outline-offset-2"
                  formControlName="roleId"
                  data-testid="staff-role-id-select"
                >
                  <option value="">— none —</option>
                  @for (r of roles(); track r.id) {
                    <option [value]="r.id">{{ r.name }}</option>
                  }
                </select>
              </app-form-field>
            }
            <footer class="flex items-center justify-end gap-3">
              <app-button
                type="button"
                variant="ghost"
                size="sm"
                (clicked)="closeCreate()"
                data-testid="staff-create-cancel"
              >
                Cancel
              </app-button>
              <app-button
                type="submit"
                variant="primary"
                size="md"
                [disabled]="createForm.invalid || createBusy()"
                [loading]="createBusy()"
                data-testid="staff-create-submit"
              >
                Create staff
              </app-button>
            </footer>
          </form>
        </details>
      }

      <div class="border border-line bg-surface">
        <div class="overflow-x-auto">
          <table class="w-full border-collapse" [attr.aria-busy]="loading() ? 'true' : null">
            <caption class="sr-only">
              Staff
            </caption>
            <thead class="border-b border-line">
              <tr class="text-left">
                <th
                  scope="col"
                  class="text-xs tracking-widest uppercase text-ink-muted font-normal px-4 py-3"
                >
                  Name
                </th>
                <th
                  scope="col"
                  class="text-xs tracking-widest uppercase text-ink-muted font-normal px-4 py-3"
                >
                  Email
                </th>
                <th
                  scope="col"
                  class="text-xs tracking-widest uppercase text-ink-muted font-normal px-4 py-3"
                >
                  Roles
                </th>
                <th
                  scope="col"
                  class="text-xs tracking-widest uppercase text-ink-muted font-normal px-4 py-3"
                >
                  Status
                </th>
                <th
                  scope="col"
                  class="text-xs tracking-widest uppercase text-ink-muted font-normal px-4 py-3 text-right"
                >
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              @if (loading()) {
                @for (_ of placeholderRows; track $index) {
                  <tr class="border-b border-line">
                    @for (__ of [0, 1, 2, 3, 4]; track $index) {
                      <td class="px-4 py-3"><app-skeleton height="0.75rem" /></td>
                    }
                  </tr>
                }
              } @else if (rows().length === 0) {
                <tr>
                  <td colspan="5" class="px-4 py-16 text-center text-ink-muted text-sm">
                    No staff members match the current filter.
                  </td>
                </tr>
              } @else {
                @for (s of rows(); track s.id) {
                  <tr
                    class="border-b border-line last:border-b-0"
                    [attr.data-testid]="'staff-row-' + s.id"
                  >
                    <td class="px-4 py-3">
                      <div class="flex items-center gap-3">
                        <span
                          class="flex items-center justify-center w-8 h-8 border border-line text-xs text-ink"
                          aria-hidden="true"
                        >
                          {{ initials(s) }}
                        </span>
                        <span class="text-sm text-ink">{{ name(s) }}</span>
                      </div>
                    </td>
                    <td class="px-4 py-3 text-sm text-ink-muted">{{ s.email }}</td>
                    <td
                      class="px-4 py-3 text-xs text-ink-muted"
                      [attr.data-testid]="'staff-roles-' + s.id"
                    >
                      {{ rolesLabel(s) }}
                    </td>
                    <td class="px-4 py-3">
                      <app-badge
                        [tone]="statusTone(s.status)"
                        [ariaLabel]="'Status: ' + statusLabel(s.status)"
                      >
                        {{ statusLabel(s.status) }}
                      </app-badge>
                    </td>
                    <td class="px-4 py-3 text-right">
                      <div class="flex items-center justify-end gap-2 flex-wrap">
                        @if (isSuperAdmin(s)) {
                          <p
                            class="text-xs tabular text-ink-muted"
                            [attr.data-testid]="'staff-unmanaged-' + s.id"
                          >
                            Super admin accounts are managed outside this screen
                          </p>
                        }
                        @if (canEdit() && s.status === 'active' && !isSuperAdmin(s)) {
                          <app-button
                            variant="secondary"
                            size="sm"
                            [disabled]="actionBusyId() === s.id"
                            (clicked)="editStaff(s)"
                            [testId]="'staff-edit-' + s.id"
                            [ariaLabel]="'Edit ' + name(s)"
                          >
                            Edit
                          </app-button>
                        }
                        @if (canDelete() && s.status === 'active' && !isSuperAdmin(s)) {
                          <app-button
                            variant="destructive"
                            size="sm"
                            [disabled]="actionBusyId() === s.id"
                            [loading]="actionBusyId() === s.id"
                            (clicked)="confirmDeactivate(s)"
                            [testId]="'staff-deactivate-' + s.id"
                            [ariaLabel]="'Deactivate ' + name(s)"
                          >
                            Deactivate
                          </app-button>
                        }
                      </div>
                    </td>
                  </tr>
                }
              }
            </tbody>
          </table>
        </div>
      </div>

      <app-pagination
        [page]="page()"
        [pageSize]="pageSize()"
        [total]="total()"
        [loading]="loading()"
        testIdPrefix="staff"
        (pageChange)="goToPage($event)"
      />
    </section>
  `,
})
export class StaffListPage implements OnInit, OnDestroy {
  private readonly users = inject(UsersService);
  private readonly rolesService = inject(RolesService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly authStore = inject(AuthStore);
  private readonly dialog = inject(Dialog);
  private readonly fb = inject(FormBuilder);
  private readonly destroy$ = new Subject<void>();

  protected readonly placeholderRows = [0, 1, 2, 3, 4];

  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly notice = signal<string | null>(null);
  readonly rows = signal<readonly StaffMember[]>([]);
  readonly total = signal(0);
  readonly roles = signal<readonly Role[]>([]);
  readonly rolesError = signal<string | null>(null);
  readonly rolesLoading = signal(false);
  readonly createBusy = signal(false);
  readonly formOpen = signal(false);
  readonly actionBusyId = signal<string | null>(null);

  readonly queryParams = toSignal(this.route.queryParams, {
    initialValue: {} as Record<string, string | undefined>,
  });
  readonly page = computed(() => Number(this.queryParams()['page'] ?? '1'));
  readonly pageSize = computed(() => Number(this.queryParams()['pageSize'] ?? '20'));
  readonly role = computed(() => this.queryParams()['role'] ?? null);
  readonly totalPages = computed(() => Math.max(1, Math.ceil(this.total() / this.pageSize())));

  readonly canCreate = computed(() =>
    this.authStore.hasAnyPermission(['admin_users:create', 'admin_users:manage']),
  );
  readonly canDelete = computed(() =>
    this.authStore.hasAnyPermission(['admin_users:delete', 'admin_users:manage']),
  );
  readonly canEdit = computed(() =>
    this.authStore.hasAnyPermission(['admin_users:update', 'admin_users:manage']),
  );

  readonly roleOptions: ReadonlyArray<{ value: ListStaffRole | null; label: string }> = [
    { value: null, label: 'All roles' },
    { value: 'SUPER_ADMIN', label: 'Super admin' },
    { value: 'ADMIN', label: 'Admin' },
    { value: 'MANAGER', label: 'Manager' },
    { value: 'SUPPORT', label: 'Support' },
  ];

  protected readonly name = fullName;
  protected readonly initials = initials;
  protected readonly statusTone = statusTone;
  protected readonly statusLabel = statusLabel;
  protected readonly roleLabel = roleLabel;
  protected readonly rolesLabel = staffRolesLabel;

  readonly createForm = this.fb.nonNullable.group({
    firstName: this.fb.nonNullable.control('', [Validators.required, Validators.maxLength(100)]),
    lastName: this.fb.nonNullable.control('', [Validators.required, Validators.maxLength(100)]),
    email: this.fb.nonNullable.control('', [Validators.required, Validators.email]),
    password: this.fb.nonNullable.control('', [
      Validators.required,
      Validators.minLength(8),
      Validators.pattern(/(?=.*[a-z])(?=.*[A-Z])(?=.*\d).*/),
    ]),
    role: this.fb.nonNullable.control<StaffRole>('SUPPORT'),
    roleId: this.fb.nonNullable.control(''),
  });

  emailError(): string | null {
    const c = this.createForm.controls.email;
    if (!c.touched || c.valid) return null;
    if (c.hasError('required')) return 'Email is required.';
    if (c.hasError('email')) return 'Enter a valid email address.';
    return null;
  }

  passwordError(): string | null {
    const c = this.createForm.controls.password;
    if (!c.touched || c.valid) return null;
    if (c.hasError('required')) return 'Password is required.';
    if (c.hasError('minlength')) return 'Password must be at least 8 characters.';
    if (c.hasError('pattern')) return 'Password must mix upper, lower, and a digit.';
    return null;
  }

  /** Super admins are listed but not manageable here (mutations 404 anyway). */
  isSuperAdmin(staff: StaffMember): boolean {
    return staff.role === 'SUPER_ADMIN';
  }

  ngOnInit(): void {
    this.route.queryParams.pipe(takeUntil(this.destroy$)).subscribe(() => this.fetch());
    this.fetchRoles();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  setRole(value: string | null): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { role: value, page: null },
      queryParamsHandling: 'merge',
    });
  }

  goToPage(page: number): void {
    if (page < 1 || page > this.totalPages()) return;
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { page },
      queryParamsHandling: 'merge',
    });
  }

  onToggle(event: Event): void {
    this.formOpen.set((event.target as HTMLDetailsElement).open);
  }

  closeCreate(): void {
    this.formOpen.set(false);
    this.createForm.reset({
      firstName: '',
      lastName: '',
      email: '',
      password: '',
      role: 'SUPPORT',
      roleId: '',
    });
  }

  submitCreate(): void {
    this.createForm.markAllAsTouched();
    if (this.createForm.invalid || this.createBusy()) return;
    const raw = this.createForm.getRawValue();
    const body: CreateStaffRequest = {
      firstName: raw.firstName.trim(),
      lastName: raw.lastName.trim(),
      email: raw.email.trim(),
      password: raw.password,
      role: raw.role,
      ...(raw.roleId ? { roleId: raw.roleId } : {}),
    };
    this.createBusy.set(true);
    this.error.set(null);
    this.users.createStaff(body).subscribe({
      next: (created) => {
        this.createBusy.set(false);
        this.closeCreate();
        this.flashNotice(`${created.email} added.`);
        this.fetch();
      },
      error: (err: unknown) => {
        this.createBusy.set(false);
        this.error.set(this.formatError(err, 'Could not create staff account.'));
      },
    });
  }

  async editStaff(staff: StaffMember): Promise<void> {
    if (this.actionBusyId()) return;
    const updated = await openStaffEditDialog(this.dialog, {
      staff,
      roles: this.roles(),
    });
    if (!updated) return;
    // The dialog returns the /staff PATCH response (an AdminUser shape); keep
    // the row's staff-only fields so the ROLES and STATUS cells stay populated.
    this.rows.set(this.rows().map((row) => (row.id === updated.id ? { ...row, ...updated } : row)));
    this.flashNotice(`${updated.email} updated.`);
  }

  async confirmDeactivate(staff: StaffMember): Promise<void> {
    if (this.actionBusyId()) return;
    const ok = await openConfirmDialog(this.dialog, {
      title: 'Deactivate this staff member?',
      body: `${staff.email} will lose admin access immediately. This is audit-logged.`,
      confirmLabel: 'Deactivate',
      tone: 'destructive',
    });
    if (!ok) return;
    this.actionBusyId.set(staff.id);
    this.users.deactivateStaff(staff.id).subscribe({
      next: () => {
        this.actionBusyId.set(null);
        this.flashNotice(`${staff.email} deactivated.`);
        this.fetch();
      },
      error: (err: unknown) => {
        this.actionBusyId.set(null);
        this.error.set(this.formatError(err, 'Could not deactivate staff.'));
      },
    });
  }

  private fetch(): void {
    const query: ListStaffQuery = {
      page: this.page(),
      pageSize: this.pageSize(),
    };
    const r = this.role();
    if (r) {
      const parsed = listStaffRoleSchema.safeParse(r);
      if (parsed.success) query.role = parsed.data;
    }
    this.loading.set(true);
    this.error.set(null);
    this.users
      .listStaff(query)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (res) => {
          this.rows.set(res.data);
          this.total.set(res.meta.total);
          this.loading.set(false);
        },
        error: (err: unknown) => {
          this.loading.set(false);
          this.error.set(this.formatError(err));
        },
      });
  }

  fetchRoles(): void {
    this.rolesLoading.set(true);
    this.rolesService
      .list()
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (r) => {
          this.roles.set(r);
          this.rolesError.set(null);
          this.rolesLoading.set(false);
        },
        error: () => {
          this.roles.set([]);
          this.rolesError.set('Could not load roles. The Roles column stays empty.');
          this.rolesLoading.set(false);
        },
      });
  }

  private flashNotice(message: string): void {
    this.notice.set(message);
    setTimeout(() => this.notice.set(null), 4000);
  }

  private formatError(err: unknown, fallback = 'Could not load staff. Please retry.'): string {
    if (err instanceof ApiForbiddenError) return 'You do not have permission to manage staff.';
    if (err instanceof ApiConflictError) return 'Email already in use on another account.';
    if (err instanceof ApiNotFoundError) return 'Staff member not found.';
    if (err instanceof ApiError && err.message) return err.message;
    return fallback;
  }
}
