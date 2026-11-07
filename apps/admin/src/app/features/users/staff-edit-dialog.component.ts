import { Dialog, DialogRef, DIALOG_DATA } from '@angular/cdk/dialog';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Inject,
  Optional,
  inject,
  signal,
} from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ButtonComponent, FormFieldComponent, InputComponent } from '@admin-ui';
import {
  UsersService,
  staffRoleSchema,
  type Role,
  type StaffRole,
  type UpdateStaffRequest,
} from '@admin-services';
import { ApiError, ApiForbiddenError, ApiNotFoundError } from '@admin-types';
import type { StaffMember } from '@admin-services';

export interface StaffEditDialogData {
  staff: StaffMember;
  roles: readonly Role[];
  titleId?: string;
}

export type StaffEditDialogResult = StaffMember | null;

let staffEditDialogSeq = 0;

export const STAFF_EDIT_DIALOG_TITLE_PREFIX = 'staff-edit-dialog-title';

@Component({
  selector: 'app-staff-edit-dialog',
  standalone: true,
  imports: [ReactiveFormsModule, ButtonComponent, FormFieldComponent, InputComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="w-full max-w-lg bg-surface border border-line p-6" data-testid="staff-edit-dialog">
      <h2 [id]="titleId" class="text-xl md:text-2xl font-bold tracking-tight text-ink">
        Edit staff
      </h2>
      <p class="mt-2 text-sm text-ink-muted">
        {{ data.staff.email }}
      </p>

      <div role="alert" class="mt-4" data-testid="staff-edit-error">
        <p
          class="border border-status-error text-ink p-3 text-xs"
          [class.sr-only]="!errorMessage()"
        >
          {{ errorMessage() ?? '' }}
        </p>
      </div>

      <form [formGroup]="form" (ngSubmit)="submit()" class="mt-6 flex flex-col gap-4" novalidate>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <app-form-field label="First name" [fieldId]="firstNameId">
            <app-input
              [id]="firstNameId"
              type="text"
              formControlName="firstName"
              data-testid="staff-edit-first"
              [invalid]="form.controls.firstName.touched && form.controls.firstName.invalid"
            ></app-input>
          </app-form-field>
          <app-form-field label="Last name" [fieldId]="lastNameId">
            <app-input
              [id]="lastNameId"
              type="text"
              formControlName="lastName"
              data-testid="staff-edit-last"
              [invalid]="form.controls.lastName.touched && form.controls.lastName.invalid"
            ></app-input>
          </app-form-field>
        </div>

        <app-form-field label="Role" [fieldId]="roleId">
          <select
            [id]="roleId"
            class="w-full min-h-[44px] px-3 py-2 text-sm bg-surface text-ink border border-line focus-visible:border-ink focus-visible:outline-2 focus-visible:outline-ink focus-visible:outline-offset-2"
            formControlName="role"
            data-testid="staff-edit-role"
          >
            <option value="ADMIN">Admin</option>
            <option value="MANAGER">Manager</option>
            <option value="SUPPORT">Support</option>
          </select>
        </app-form-field>

        @if (data.roles.length > 0) {
          <app-form-field
            label="Role record"
            [fieldId]="roleIdFieldId"
            hint="Overrides the enum with a custom role entry."
          >
            <select
              [id]="roleIdFieldId"
              class="w-full min-h-[44px] px-3 py-2 text-sm bg-surface text-ink border border-line focus-visible:border-ink focus-visible:outline-2 focus-visible:outline-ink focus-visible:outline-offset-2"
              formControlName="roleId"
              [attr.aria-describedby]="roleIdFieldId + '-hint'"
              data-testid="staff-edit-role-id"
            >
              <option value="">— none —</option>
              @for (r of data.roles; track r.id) {
                <option [value]="r.id">{{ r.name }}</option>
              }
            </select>
          </app-form-field>
        }

        <div class="flex items-center justify-end gap-3 pt-2">
          <app-button
            variant="ghost"
            type="button"
            (clicked)="cancel()"
            data-testid="staff-edit-cancel"
          >
            Cancel
          </app-button>
          <app-button
            type="submit"
            variant="primary"
            [disabled]="form.invalid || busy()"
            [loading]="busy()"
            testId="staff-edit-submit"
          >
            Save
          </app-button>
        </div>
      </form>
    </div>
  `,
})
export class StaffEditDialogComponent {
  private readonly fb = inject(FormBuilder);
  private readonly users = inject(UsersService);
  private readonly host = inject(ElementRef<HTMLElement>);

  readonly titleId: string;
  readonly firstNameId: string;
  readonly lastNameId: string;
  readonly roleId: string;
  readonly roleIdFieldId: string;

  readonly busy = signal(false);
  readonly errorMessage = signal<string | null>(null);

  readonly form = this.fb.nonNullable.group({
    firstName: this.fb.nonNullable.control('', [Validators.maxLength(100)]),
    lastName: this.fb.nonNullable.control('', [Validators.maxLength(100)]),
    role: this.fb.nonNullable.control<StaffRole>('SUPPORT'),
    roleId: this.fb.nonNullable.control(''),
  });

  constructor(
    private readonly ref: DialogRef<StaffEditDialogResult>,
    @Optional() @Inject(DIALOG_DATA) public readonly data: StaffEditDialogData,
  ) {
    this.titleId = data?.titleId ?? `${STAFF_EDIT_DIALOG_TITLE_PREFIX}-${++staffEditDialogSeq}`;
    this.firstNameId = `${this.titleId}-first`;
    this.lastNameId = `${this.titleId}-last`;
    this.roleId = `${this.titleId}-role`;
    this.roleIdFieldId = `${this.titleId}-role-id`;

    const staff = data?.staff;
    if (staff) {
      // List rows carry `role` and `customRole`; create/update responses carry `roles`.
      const parsedRole = staffRoleSchema.safeParse(
        staff.role ?? staff.roles?.[0]?.name?.toUpperCase(),
      );
      const seededRoleId = staff.customRole?.id ?? staff.roles?.[0]?.id ?? '';
      this.form.reset({
        firstName: staff.firstName ?? '',
        lastName: staff.lastName ?? '',
        role: parsedRole.success ? parsedRole.data : 'SUPPORT',
        roleId: seededRoleId,
      });
    }
  }

  submit(): void {
    this.form.markAllAsTouched();
    if (this.form.invalid || this.busy()) {
      this.focusFirstInvalid();
      return;
    }
    const body = this.dirtyBody();
    if (Object.keys(body).length === 0) {
      this.ref.close(null);
      return;
    }
    this.busy.set(true);
    this.errorMessage.set(null);
    this.users.updateStaff(this.data.staff.id, body).subscribe({
      next: (updated) => {
        this.busy.set(false);
        this.ref.close(updated);
      },
      error: (err: unknown) => {
        this.busy.set(false);
        this.errorMessage.set(this.formatError(err));
      },
    });
  }

  cancel(): void {
    this.ref.close(null);
  }

  private focusFirstInvalid(): void {
    queueMicrotask(() => {
      const el = this.host.nativeElement.querySelector(
        '[aria-invalid="true"]',
      ) as HTMLElement | null;
      el?.focus();
    });
  }

  private dirtyBody(): UpdateStaffRequest {
    const body: UpdateStaffRequest = {};
    const firstName = this.form.controls.firstName;
    const lastName = this.form.controls.lastName;
    const role = this.form.controls.role;
    const roleId = this.form.controls.roleId;
    if (firstName.dirty) body.firstName = firstName.value.trim();
    if (lastName.dirty) body.lastName = lastName.value.trim();
    if (role.dirty) body.role = role.value;
    if (roleId.dirty) {
      const v = roleId.value.trim();
      if (v) body.roleId = v;
    }
    return body;
  }

  private formatError(err: unknown): string {
    if (err instanceof ApiForbiddenError)
      return 'You do not have permission to update this staff member.';
    if (err instanceof ApiNotFoundError) return 'This staff member could not be found.';
    if (err instanceof ApiError && err.message) return err.message;
    return 'Could not save staff member.';
  }
}

export async function openStaffEditDialog(
  dialog: Dialog,
  data: StaffEditDialogData,
): Promise<StaffEditDialogResult> {
  const titleId = data.titleId ?? `${STAFF_EDIT_DIALOG_TITLE_PREFIX}-${++staffEditDialogSeq}`;
  const ref = dialog.open<StaffEditDialogResult>(StaffEditDialogComponent, {
    data: { ...data, titleId },
    ariaLabelledBy: titleId,
    ariaModal: true,
    hasBackdrop: true,
    backdropClass: 'cdk-overlay-backdrop-brand',
    panelClass: 'cdk-overlay-panel-brand',
    autoFocus: 'first-tabbable',
  });
  return await new Promise<StaffEditDialogResult>((resolve) => {
    const sub = ref.closed.subscribe((value) => {
      resolve(value ?? null);
      setTimeout(() => sub.unsubscribe(), 0);
    });
  });
}
