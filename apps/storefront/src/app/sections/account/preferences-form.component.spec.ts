import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';

import type {
  NotificationPreferences,
  UpdateNotificationPreferencesRequest,
} from '@storefront-types';

import { LocaleService } from '../../locale.service';
import { assertAxeClean, renderComponent } from '../../ui/testing';
import { PreferencesFormComponent } from './preferences-form.component';

const prefs = (lifecycle: boolean, marketing: boolean): NotificationPreferences => ({
  LIFECYCLE: { email: lifecycle, sms: false, push: false },
  MARKETING: { email: marketing, sms: false, push: false },
});

const toggle = (root: HTMLElement, category: 'LIFECYCLE' | 'MARKETING'): HTMLInputElement =>
  root.querySelector(`[data-testid="pref-toggle-${category}"]`) as HTMLInputElement;

const submitButton = (root: HTMLElement): HTMLButtonElement =>
  root.querySelector(
    'form[data-testid="account-preferences-form"] button[type="submit"]',
  ) as HTMLButtonElement;

describe('PreferencesFormComponent', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => TestBed.resetTestingModule());

  it('starts with both toggles off when there are no preferences yet', async () => {
    const fixture = await renderComponent(PreferencesFormComponent, {}, [LocaleService]);
    const root = fixture.nativeElement as HTMLElement;
    expect(toggle(root, 'LIFECYCLE').checked).toBe(false);
    expect(toggle(root, 'MARKETING').checked).toBe(false);
  });

  it('pre-populates the toggles from the saved preferences', async () => {
    const fixture = await renderComponent(
      PreferencesFormComponent,
      { preferences: prefs(true, false) },
      [LocaleService],
    );
    const root = fixture.nativeElement as HTMLElement;
    expect(toggle(root, 'LIFECYCLE').checked).toBe(true);
    expect(toggle(root, 'MARKETING').checked).toBe(false);
  });

  it('treats a missing category as off', async () => {
    const partial = { LIFECYCLE: { email: true, sms: false, push: false } };
    const fixture = await renderComponent(
      PreferencesFormComponent,
      { preferences: partial as unknown as NotificationPreferences },
      [LocaleService],
    );
    const root = fixture.nativeElement as HTMLElement;
    expect(toggle(root, 'LIFECYCLE').checked).toBe(true);
    expect(toggle(root, 'MARKETING').checked).toBe(false);
  });

  it('emits only the email flag of each category on submit', async () => {
    const fixture = await renderComponent(
      PreferencesFormComponent,
      { preferences: prefs(false, false) },
      [LocaleService],
    );
    let emitted: UpdateNotificationPreferencesRequest | null = null;
    fixture.componentInstance.submit.subscribe((v: UpdateNotificationPreferencesRequest) => {
      emitted = v;
    });
    const root = fixture.nativeElement as HTMLElement;
    toggle(root, 'MARKETING').click();
    fixture.detectChanges();
    submitButton(root).click();
    expect(emitted).toEqual({ LIFECYCLE: { email: false }, MARKETING: { email: true } });
  });

  it('does not emit while a save is in flight', async () => {
    const fixture = await renderComponent(
      PreferencesFormComponent,
      { preferences: prefs(true, true), saving: true },
      [LocaleService],
    );
    let emits = 0;
    fixture.componentInstance.submit.subscribe(() => emits++);
    fixture.componentInstance['onSubmit']();
    expect(emits).toBe(0);
  });

  it('shows the external error and clears it when the customer edits a toggle', async () => {
    const fixture = await renderComponent(
      PreferencesFormComponent,
      { preferences: prefs(false, false), externalError: 'API rejected the preferences.' },
      [LocaleService],
    );
    const root = fixture.nativeElement as HTMLElement;
    const region = () => root.querySelector('[data-testid="account-preferences-form-error"]');
    expect(region()?.textContent?.trim()).toBe('API rejected the preferences.');

    let edits = 0;
    fixture.componentInstance.edited.subscribe(() => edits++);
    toggle(root, 'LIFECYCLE').click();
    fixture.detectChanges();
    expect(region()).toBeNull();
    expect(edits).toBe(1);
  });

  it('shows the always-on note for transactional mail', async () => {
    const fixture = await renderComponent(PreferencesFormComponent, {}, [LocaleService]);
    const note = (fixture.nativeElement as HTMLElement).querySelector(
      '[data-testid="account-preferences-alwayson"]',
    );
    expect(note?.textContent?.trim().length).toBeGreaterThan(0);
  });

  it('axe: zero serious / critical violations', async () => {
    const fixture = await renderComponent(
      PreferencesFormComponent,
      { preferences: prefs(true, false) },
      [LocaleService],
    );
    await assertAxeClean(fixture.nativeElement, {
      disabledRules: ['region', 'landmark-one-main', 'page-has-heading-one'],
    });
  });
});
