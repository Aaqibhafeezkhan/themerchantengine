/**
 * The onboarding docs a stranger reads first (plan OS7). The public tree is
 * what `git archive` produces, so a link into an export-ignored path is a
 * dead link for every reader of the published repository. The README once
 * promised a postinstall hook that does not exist and named env vars the
 * code never reads; a contact was "not yet published". The engine is MIT
 * (DR-35), so the license files, the package metadata and every public file
 * must agree on it.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO = path.resolve(__dirname, '..', '..');
const read = (relative: string) => fs.readFileSync(path.join(REPO, relative), 'utf8');
const CONTACT = 'badii@badii.studio';

const COMMUNITY_FILES = [
  'SECURITY.md',
  'CONTRIBUTING.md',
  'CODE_OF_CONDUCT.md',
  '.github/ISSUE_TEMPLATE/bug_report.md',
  '.github/ISSUE_TEMPLATE/feature_request.md',
  '.github/ISSUE_TEMPLATE/config.yml',
  '.github/PULL_REQUEST_TEMPLATE.md',
  '.github/dependabot.yml',
];

const PUBLIC_DOCS = [
  'README.md',
  'CHANGELOG.md',
  'SECURITY.md',
  'CONTRIBUTING.md',
  'CODE_OF_CONDUCT.md',
  '.github/ISSUE_TEMPLATE/bug_report.md',
  '.github/ISSUE_TEMPLATE/feature_request.md',
  '.github/PULL_REQUEST_TEMPLATE.md',
];

function exportIgnored(relative: string): boolean {
  // A directory pattern such as `/specs/` only matches the directory itself,
  // so every ancestor is asked with a trailing slash.
  const parts = relative.split('/');
  const queries = [
    relative,
    ...parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/') + '/'),
  ];
  const out = execFileSync('git', ['check-attr', 'export-ignore', '--', ...queries], {
    cwd: REPO,
    encoding: 'utf8',
  });
  return /: export-ignore: set$/m.test(out);
}

// Markdown links plus the HTML `href`, `src` and `srcset` a `<picture>` logo
// or a screenshot table uses.
function linksIn(markdown: string): string[] {
  const text = markdown.replace(/```[\s\S]*?```/g, '');
  const markdownLinks = [...text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map((m) => m[1]);
  const htmlLinks = [...text.matchAll(/\b(?:href|src|srcset)="([^"]+)"/g)].flatMap((m) =>
    m[1].split(',').map((candidate) => candidate.trim().split(/\s+/)[0]),
  );
  return [...markdownLinks, ...htmlLinks]
    .filter((target) => !/^(https?:|mailto:|#)/.test(target))
    .map((target) => target.split('#')[0]);
}

const relativeLinks = (doc: string) => linksIn(read(doc));

it('the link check sees HTML image sources, or it proves nothing', () => {
  expect(
    linksIn(
      '<source srcset="docs/a.svg" media="x"><img src="docs/b.png" alt="">' +
        '<a href="CONTRIBUTING.md">c</a> [d](LICENSE) ![e](https://x.test/e.png)',
    ),
  ).toEqual(['LICENSE', 'docs/a.svg', 'docs/b.png', 'CONTRIBUTING.md']);
});

it.each(COMMUNITY_FILES)('%s exists', (file) => {
  expect(fs.existsSync(path.join(REPO, file))).toBe(true);
});

describe.each(PUBLIC_DOCS)('%s', (doc) => {
  const present = fs.existsSync(path.join(REPO, doc));

  it('links only to files the public tree carries', () => {
    if (!present) return;
    for (const target of relativeLinks(doc)) {
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(doc), target));
      expect(fs.existsSync(path.join(REPO, resolved)), `${doc} -> ${target} exists`).toBe(true);
      expect(
        exportIgnored(resolved.replace(/\/$/, '')),
        `${doc} -> ${target} is export-ignored`,
      ).toBe(false);
    }
  });

  it('carries no contact placeholder and no em-dash', () => {
    if (!present) return;
    const text = read(doc);
    expect(text).not.toMatch(/not yet published|draft for operator review|TBD|<your[- ]email>/i);
    expect(text).not.toContain('—');
  });
});

it('the link check sees an export-ignored path, or it proves nothing', () => {
  expect(exportIgnored('specs/constitution.md')).toBe(true);
  expect(exportIgnored('CLAUDE.md')).toBe(true);
  expect(exportIgnored('docs/site/index.md')).toBe(false);
});

it.each(['README.md', 'SECURITY.md', 'CODE_OF_CONDUCT.md'])(
  '%s names the contact address',
  (doc) => {
    expect(read(doc)).toContain(CONTACT);
  },
);

/**
 * Old license terms. The CHANGELOG and its generated site copy keep them as
 * history, and this spec names them.
 */
const OLD_LICENSE = /polyform|commercial[- ]licen/i;
const OLD_LICENSE_ALLOWED = new Set([
  'CHANGELOG.md',
  'docs/site/reference/changelog.md',
  'scripts/__tests__/public-docs.spec.ts',
]);

function oldLicenseHits(files: { path: string; text: string }[]): string[] {
  return files
    .filter((file) => !OLD_LICENSE_ALLOWED.has(file.path))
    .filter((file) => OLD_LICENSE.test(file.text))
    .map((file) => file.path);
}

describe('MIT license', () => {
  it('LICENSE holds the MIT text and the Badii Studio copyright', () => {
    const license = read('LICENSE');
    expect(license).toMatch(/^MIT License\s/);
    expect(license).toContain('Copyright (c) 2026 Badii Studio');
    expect(license).toContain('Permission is hereby granted, free of charge');
    expect(license).toContain('THE SOFTWARE IS PROVIDED "AS IS"');
  });

  it.each([
    'package.json',
    'package-lock.json',
    'tools/setup/package.json',
    'tools/setup/package-lock.json',
  ])('%s names MIT', (file) => {
    const pkg = JSON.parse(read(file)) as {
      license?: string;
      packages?: Record<string, { license?: string }>;
    };
    expect(pkg.packages?.['']?.license ?? pkg.license).toBe('MIT');
  });

  it('NOTICE names the MIT License and keeps the trademark note', () => {
    const notice = read('NOTICE');
    expect(notice).toContain('MIT License');
    expect(notice).toMatch(/trademark/i);
  });

  it('the commercial license page is gone', () => {
    expect(fs.existsSync(path.join(REPO, 'COMMERCIAL-LICENSE.md'))).toBe(false);
  });

  it('no public file names the old license outside the CHANGELOG history', () => {
    const grep = spawnSync('git', ['grep', '-lIiE', OLD_LICENSE.source], {
      cwd: REPO,
      encoding: 'utf8',
    });
    expect(grep.status, grep.stderr).toBeLessThan(2);
    const files = grep.stdout
      .split('\n')
      .filter(Boolean)
      .filter((file) => !exportIgnored(file))
      .map((file) => ({ path: file, text: read(file) }));
    expect(oldLicenseHits(files)).toEqual([]);
  });

  it('the old-license scan flags a public file and spares the CHANGELOG, or it proves nothing', () => {
    expect(
      oldLicenseHits([
        { path: 'docs/site/index.md', text: 'Needs a Commercial License.' },
        { path: 'NOTICE', text: 'PolyForm Noncommercial' },
        { path: 'docs/site/customize/index.md', text: 'See `COMMERCIAL-LICENSE.md`.' },
        { path: 'CHANGELOG.md', text: 'v1.1.0 stays PolyForm Noncommercial.' },
      ]),
    ).toEqual(['docs/site/index.md', 'NOTICE', 'docs/site/customize/index.md']);
  });
});

it('the first CHANGELOG section is the package version, as `npm run release` requires', () => {
  const version = (JSON.parse(read('package.json')) as { version: string }).version;
  const first = read('CHANGELOG.md')
    .match(/^## (.+)$/m)?.[1]
    ?.trim();
  expect(first).toBe(version);
});

it('package.json names the author, the repository, the issue tracker and the homepage', () => {
  const pkg = JSON.parse(read('package.json')) as Record<string, unknown>;
  expect(pkg['author']).toBe('Badii Studio');
  expect(JSON.stringify(pkg['repository'])).toContain('github.com/Xdabier/themerchantengine');
  expect(JSON.stringify(pkg['bugs'])).toContain('github.com/Xdabier/themerchantengine/issues');
  expect(typeof pkg['homepage']).toBe('string');
});

const README_ASSETS = [
  'docs/assets/readme/logo-light.svg',
  'docs/assets/readme/logo-dark.svg',
  'docs/assets/readme/admin-dashboard.png',
  'docs/assets/readme/admin-product-edit.png',
  'docs/assets/readme/storefront-home.png',
  'docs/assets/readme/storefront-product.png',
  'docs/assets/readme/checkout.gif',
];

describe('README', () => {
  const readme = read('README.md');

  it('promises no postinstall hook and names no env var the code never reads', () => {
    expect(readme).not.toMatch(/postinstall/i);
    for (const stale of ['SENDGRID', 'AWS_S3_BUCKET', 'AWS_ACCESS_KEY', 'STRIPE_SECRET_KEY']) {
      expect(readme, stale).not.toContain(stale);
    }
    for (const real of ['RESEND_API_KEY', 'S3_BUCKET', 'STRIPE_API_KEY']) {
      expect(readme, real).toContain(real);
    }
  });

  it('states the Tailwind version package.json installs', () => {
    const range = (JSON.parse(read('package.json')) as { devDependencies: Record<string, string> })
      .devDependencies['tailwindcss'];
    const [major, minor] = range.replace(/^[^\d]*/, '').split('.');
    expect(readme).toContain(`Tailwind ${major}.${minor}`);
    expect(readme).not.toMatch(new RegExp(`Tailwind v?(?!${major}\\b)\\d`));
  });

  it('lists the mail and shipping adapters as planned', () => {
    expect(readme).toMatch(/planned/i);
    expect(readme).toMatch(/shipping/i);
  });

  it('stays a landing page of 150 to 200 lines, the detail lives in docs/site', () => {
    const lines = readme.trimEnd().split('\n').length;
    expect(lines).toBeGreaterThanOrEqual(150);
    expect(lines).toBeLessThanOrEqual(200);
  });

  it('shows the logo in both themes, the screenshots, the checkout GIF and an architecture diagram', () => {
    expect(readme).toMatch(/<picture>[\s\S]*prefers-color-scheme: dark[\s\S]*<\/picture>/);
    for (const asset of README_ASSETS) {
      expect(readme, asset).toContain(asset);
      expect(fs.existsSync(path.join(REPO, asset)), asset).toBe(true);
    }
    expect(readme).toContain('```mermaid');
  });

  it('generates the Prisma client before the from-source seed runs', () => {
    const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> })
      .scripts;
    const expand = (name: string, depth = 0): string => {
      const body = scripts[name] ?? '';
      if (depth > 5) return body;
      return body.replace(/npm run ([\w:-]+)/g, (_, inner: string) => expand(inner, depth + 1));
    };
    const seedAt = readme.indexOf('npm run db:seed');
    expect(seedAt).toBeGreaterThanOrEqual(0);
    const beforeSeed = readme.slice(0, seedAt);
    const ran = [...beforeSeed.matchAll(/npm run ([\w:-]+)/g)].map((m) => expand(m[1]));
    expect(ran.join('\n')).toContain('prisma generate');
  });
});

it('.env.example sets the API prefix the admin and storefront dev proxies forward to', () => {
  expect(read('.env.example')).toMatch(/^API_GLOBAL_PREFIX=api$/m);
});

it('the README keeps the four-origin CORS default from .env.example', () => {
  expect(read('README.md')).not.toMatch(/^\s*CORS_ORIGIN=http:\/\/localhost:53200\s*$/m);
});

it('.env.example names every env var the API, the storefront and the shared libs read', () => {
  const sources = ['apps/api/src', 'apps/storefront/src', 'libs/shared/common/src'];
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.ts$/.test(entry.name) && !/\.(e2e-)?spec\.ts$/.test(entry.name)) files.push(full);
    }
  };
  sources.forEach((dir) => walk(path.join(REPO, dir)));
  const names = new Set<string>();
  const pattern =
    /process\.env(?:\.([A-Z_][A-Z0-9_]*)|\[['"]([A-Z_][A-Z0-9_]*)['"]\])|import\.meta\.env\.([A-Z_][A-Z0-9_]*)/g;
  for (const file of files) {
    for (const m of fs.readFileSync(file, 'utf8').matchAll(pattern))
      names.add(m[1] ?? m[2] ?? m[3]);
  }
  // Commented-out OAuth providers, and legacy fallbacks the current names win over.
  const excluded = new Set([
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'APPLE_CLIENT_ID',
    'APPLE_CLIENT_SECRET',
    'CORS_ORIGINS',
    'SITE_URL',
    'API_URL',
  ]);
  expect(names.size).toBeGreaterThan(40);
  const example = read('.env.example');
  const missing = [...names]
    .filter((name) => !excluded.has(name))
    .filter((name) => !new RegExp(`^#?\\s*${name}=`, 'm').test(example));
  expect(missing).toEqual([]);
});
