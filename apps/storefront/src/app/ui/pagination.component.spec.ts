import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';

import { PaginationComponent } from './pagination.component';
import { assertAxeClean, renderComponent } from './testing';

describe('PaginationComponent', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => TestBed.resetTestingModule());

  it('renders mobile variant with summary text via injected formatter', async () => {
    const fixture = await renderComponent(PaginationComponent, {
      page: 2,
      totalPages: 10,
      variant: 'mobile',
      summaryFormatter: (page: number, total: number) => `Page ${page} of ${total}`,
    });
    expect(fixture.nativeElement.querySelector('.summary')?.textContent).toContain('Page 2 of 10');
    expect(fixture.nativeElement.querySelector('.pages')).toBeNull();
  });

  it('falls back to the French default summary when no formatter passed and no LocaleService', async () => {
    const fixture = await renderComponent(PaginationComponent, {
      page: 2,
      totalPages: 10,
      variant: 'mobile',
    });
    // No LocaleService bound in the test bed, so the default locale 'fr'
    // resolves to the French chrome map.
    expect(fixture.nativeElement.querySelector('.summary')?.textContent).toContain('Page 2 sur 10');
  });

  it('renders desktop variant with numbered list + ellipsis windowing', async () => {
    const fixture = await renderComponent(PaginationComponent, {
      page: 5,
      totalPages: 20,
      variant: 'desktop',
    });
    const pages = Array.from(fixture.nativeElement.querySelectorAll('.page, .ellipsis')).map((n) =>
      (n as HTMLElement).textContent?.trim(),
    );
    expect(pages[0]).toBe('1');
    expect(pages[pages.length - 1]).toBe('20');
    expect(pages).toContain('…');
  });

  it('marks current page with aria-current', async () => {
    const fixture = await renderComponent(PaginationComponent, {
      page: 3,
      totalPages: 5,
      variant: 'desktop',
    });
    const current = fixture.nativeElement.querySelector('[aria-current="page"]');
    expect(current?.textContent?.trim()).toBe('3');
  });

  it('disables prev at page 1 + next at last page', async () => {
    const f1 = await renderComponent(PaginationComponent, {
      page: 1,
      totalPages: 3,
      variant: 'desktop',
    });
    expect((f1.nativeElement.querySelector('.prev') as HTMLButtonElement).disabled).toBe(true);
    expect((f1.nativeElement.querySelector('.next') as HTMLButtonElement).disabled).toBe(false);
    TestBed.resetTestingModule();
    const f2 = await renderComponent(PaginationComponent, {
      page: 3,
      totalPages: 3,
      variant: 'desktop',
    });
    expect((f2.nativeElement.querySelector('.next') as HTMLButtonElement).disabled).toBe(true);
  });

  it('emits pageChange on next click', async () => {
    const fixture = await renderComponent(PaginationComponent, {
      page: 2,
      totalPages: 5,
      variant: 'desktop',
    });
    const handler = vi.fn();
    fixture.componentInstance.pageChange.subscribe(handler);
    (fixture.nativeElement.querySelector('.next') as HTMLButtonElement).click();
    expect(handler).toHaveBeenCalledWith(3);
  });

  it('passes axe', async () => {
    const fixture = await renderComponent(PaginationComponent, {
      page: 2,
      totalPages: 5,
      variant: 'desktop',
    });
    await assertAxeClean(fixture.nativeElement);
  });

  it.each(['.step', '.page'])(
    'gives %s the house focus ring rather than only the user-agent one',
    (selector) => {
      const rule = ruleFor(`${selector}:focus-visible`);
      expect(rule).toContain('outline: 2px solid var(--brand-focus)');
      expect(rule).toContain('outline-offset: 2px');
    },
  );

  it('keeps the active page ground on its own hover step', () => {
    expect(ruleFor('.page.active:hover')).toContain('var(--brand-primary-dark)');
  });
});

/** Compiled component CSS with the view-encapsulation attributes stripped. */
function styleSheet(): string {
  return (PaginationComponent as unknown as { ɵcmp: { styles: string[] } }).ɵcmp.styles
    .join('\n')
    .replace(/%NS%/g, '')
    .replace(/\[_ng(?:content|host)-[^\]]*\]/g, '');
}

/** Declaration block of the first rule whose selector list opens with `selector`. */
function ruleFor(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = new RegExp(`${escaped}\\s*(?:,[^{]*)?\\{([^{}]*)\\}`).exec(styleSheet());
  expect(rule, `no rule found for ${selector}`).not.toBeNull();
  return rule![1];
}
