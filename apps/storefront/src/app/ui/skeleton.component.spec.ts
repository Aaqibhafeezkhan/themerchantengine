import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';

import { SkeletonComponent, type SkeletonVariant } from './skeleton.component';
import { assertAxeClean, renderComponent } from './testing';

describe('SkeletonComponent', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => TestBed.resetTestingModule());

  it.each(['text', 'image', 'card'] as const)(
    'applies v-%s variant class',
    async (variant: SkeletonVariant) => {
      const fixture = await renderComponent(SkeletonComponent, { variant });
      expect(fixture.nativeElement.querySelector('.skel')?.classList.contains(`v-${variant}`)).toBe(
        true,
      );
    },
  );

  it('exposes aria-busy + aria-live + aria-label', async () => {
    const fixture = await renderComponent(SkeletonComponent, { label: 'Loading products' });
    const skel = fixture.nativeElement.querySelector('.skel');
    expect(skel?.getAttribute('aria-busy')).toBe('true');
    expect(skel?.getAttribute('aria-live')).toBe('polite');
    expect(skel?.getAttribute('aria-label')).toBe('Loading products');
  });

  it('renders card sub-elements when variant=card', async () => {
    const fixture = await renderComponent(SkeletonComponent, { variant: 'card' });
    expect(fixture.nativeElement.querySelectorAll('.line').length).toBe(2);
    expect(fixture.nativeElement.querySelector('.image')).not.toBeNull();
  });

  it('applies aspect-ratio style when set', async () => {
    const fixture = await renderComponent(SkeletonComponent, {
      variant: 'image',
      aspectRatio: '1 / 1',
    });
    const skel = fixture.nativeElement.querySelector('.skel') as HTMLElement;
    expect(skel.style.aspectRatio).toContain('1');
  });

  it('passes axe', async () => {
    const fixture = await renderComponent(SkeletonComponent);
    await assertAxeClean(fixture.nativeElement);
  });

  it('never animates, per agent_docs/storefront/brand-tokens.md', () => {
    const css = styleSheet();
    expect(css).not.toContain('animation');
    expect(css).not.toContain('@keyframes');
    // The shimmer pseudo-element existed only to carry the animation, so an
    // empty one left behind would be the same regression in a quieter form.
    expect(css).not.toContain('::after');
    expect(css).not.toContain('--brand-skeleton-shimmer-midstop');
  });

  it('keeps the flat surface ground that reads as loading', () => {
    expect(styleSheet()).toContain('background-color: var(--brand-surface-strong)');
  });
});

/** Compiled component CSS with the view-encapsulation attributes stripped. */
function styleSheet(): string {
  return (SkeletonComponent as unknown as { ɵcmp: { styles: string[] } }).ɵcmp.styles
    .join('\n')
    .replace(/%NS%/g, '')
    .replace(/\[_ng(?:content|host)-[^\]]*\]/g, '');
}
