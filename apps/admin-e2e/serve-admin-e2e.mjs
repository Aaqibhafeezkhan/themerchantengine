/**
 * Admin dev-server launcher for the e2e suite.
 *
 * Plan H / Phase H0, decision D3. The suite used to carry a second webServer
 * branch that served the admin with `proxy.conf.e2e.dev.json`, whose target was
 * the DEV API on 53000. That branch existed for one real reason: on Windows a
 * Hyper-V dynamic-port exclusion can reserve 53001, and the suite then could
 * not run at all. The fix it chose was to point the whole suite at the dev
 * stack, which is how e2e fixtures reached the developer's dev database.
 *
 * The legitimate half of that need is a port override, so this launcher gives
 * one. `E2E_API_PORT` moves the test API, `ADMIN_DEV_PORT` moves the admin dev
 * server, and the proxy config is GENERATED from whatever they say rather than
 * chosen from two committed files. Live-backend semantics are never traded
 * away, so the identity guard still holds on every path.
 *
 * Generating the config in the launcher rather than in Playwright's
 * `globalSetup` is deliberate: Playwright starts `webServer` before
 * `globalSetup`, and depending on that ordering is depending on an
 * implementation detail. Here the file exists before `nx serve` reads it,
 * because the same process writes it.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import serveArgs from './e2e-serve-args.cjs';
import marker from './e2e-server-marker.cjs';

const { clearMarker, writeMarker } = marker;
const { serveAdminArgs } = serveArgs;

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = resolve(HERE, '..', '..');
const STATE_DIR = resolve(HERE, '.playwright-state');
const PROXY_CONF_PATH = resolve(STATE_DIR, 'proxy.conf.generated.json');

const apiPort = process.env['E2E_API_PORT'] ?? '53001';
const adminPort = process.env['ADMIN_DEV_PORT'] ?? '53211';

mkdirSync(STATE_DIR, { recursive: true });
writeFileSync(
  PROXY_CONF_PATH,
  `${JSON.stringify(
    {
      '/api': {
        target: `http://localhost:${apiPort}`,
        secure: false,
        changeOrigin: true,
        logLevel: 'warn',
      },
    },
    null,
    2,
  )}\n`,
);

console.log(`[serve-admin-e2e] admin on :${adminPort}, /api → :${apiPort}`);

// The marker that lets the next run skip the 180-second Angular boot. It says
// which ports this server was generated for and which process owns it, and
// `playwright.config.ts` reuses a running server only when both still hold. A
// dev server never writes it, so a dev-API proxy is never reused.
writeMarker({ adminPort, apiPort, pid: process.pid });

const child = spawn(
  'npx',
  serveAdminArgs({ proxyConfigPath: PROXY_CONF_PATH, adminPort }),
  {
    cwd: WORKSPACE_ROOT,
    stdio: 'inherit',
    shell: true,
    // Angular 22 lets a PORT variable beat --port, and Nx loads the API's PORT from .env.
    env: { ...process.env, PORT: adminPort },
  },
);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    clearMarker();
    child.kill(signal);
  });
}
child.on('exit', (code, signal) => {
  clearMarker();
  process.exit(signal ? 1 : (code ?? 0));
});
