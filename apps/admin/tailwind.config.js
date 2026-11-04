const path = require('path');

/**
 * A semantic token, wrapped so Tailwind opacity modifiers keep working.
 *
 * The variables in `styles.css` hold space-separated RGB channels rather than
 * hex for exactly this reason: `bg-surface-elevated/80` expands to
 * `color-mix(in oklab, rgb(26 26 26) 80%, transparent)`.
 */
const semantic = (name) => `rgb(var(--${name}))`;

/** The four status colours, each in its three semantic forms. */
const statusColors = () => {
  const out = {};
  for (const name of ['success', 'warning', 'error', 'info']) {
    // Text, icons and borders. Base hex in dark mode, ink variant in light.
    out[name] = semantic(`status-${name}`);
    // A solid fill that carries its own text, such as a destructive button.
    // The base hex in both modes.
    out[`${name}-fill`] = semantic(`status-${name}-fill`);
    // Badge and toast grounds. The base hex in dark mode, a 12 percent tint
    // of it in light mode.
    out[`${name}-tint`] = semantic(`status-${name}-tint`);
  }
  return out;
};

/** The text that sits on each of those two status grounds. */
const onStatusColors = () => {
  const out = {};
  for (const name of ['success', 'warning', 'error', 'info']) {
    out[name] = semantic(`on-status-${name}`);
    out[`${name}-fill`] = semantic(`on-status-${name}-fill`);
  }
  return out;
};

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    path.join(__dirname, 'src/**/*.{html,ts}'),
    path.join(__dirname, 'index.html'),
    path.join(__dirname, '..', '..', 'libs/admin-ui/src/**/*.{html,ts}'),
  ],
  theme: {
    extend: {
      colors: {
        // ── Semantic layer ────────────────────────────────────────────────
        // What components are written in. The palette below is what these
        // resolve to, and which one they resolve to is the colour mode.
        surface: {
          DEFAULT: semantic('surface'),
          elevated: semantic('surface-elevated'),
          emphasis: semantic('surface-emphasis'),
          'emphasis-hover': semantic('surface-emphasis-hover'),
        },
        ink: {
          DEFAULT: semantic('ink'),
          emphasis: semantic('ink-emphasis'),
          muted: semantic('ink-muted'),
          disabled: semantic('ink-disabled'),
        },
        'on-emphasis': semantic('on-emphasis'),
        line: {
          DEFAULT: semantic('line'),
          strong: semantic('line-strong'),
        },
        // The ground of an email or template preview, which renders on white
        // wherever it is finally read. Not a theme surface: white in both
        // modes, and named so that is a decision rather than an oversight.
        'preview-ground': semantic('preview-ground'),
        // The Merchant Engine's own product mark. Also not a theme surface:
        // a logo that changed colour with the operator's system setting would
        // not be a logo. Semantic rather than a palette reference so the
        // guard below covers it like everything else.
        'brand-mark': semantic('brand-mark'),
        status: statusColors(),
        'on-status': onStatusColors(),

        // ── Palette ───────────────────────────────────────────────────────
        // Source: docs/badii-studio-brand-guidelines.md §5 COLOR PALETTE.
        // Declared because `styles.css` maps the semantic layer onto it, and
        // because the Merchant Engine product mark is mode-independent. No
        // component references these directly; a guard spec enforces it.
        'void-black': '#0A0A0A',
        'paper-white': '#E8E4DF',
        'pure-white': '#FFFFFF',
        neutral: {
          300: '#9A9A9A',
          500: '#6B6B6B',
          700: '#2A2A2A',
          800: '#1A1A1A',
        },
      },
      fontFamily: {
        sans: ['Satoshi', 'system-ui', '-apple-system', '"Segoe UI"', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Consolas', 'monospace'],
      },
      borderRadius: {
        DEFAULT: '0',
        none: '0',
      },
    },
  },
  plugins: [],
  corePlugins: {
    // Brand mandate: no border radius, no gradients, no ring.
    ringWidth: false,
    ringColor: false,
    ringOffsetWidth: false,
    ringOffsetColor: false,
    backgroundImage: false, // disables gradients
  },
};
