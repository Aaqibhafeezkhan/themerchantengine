import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SECRET_ANSWER_PATHS, getPath, parseAnswers } from './answers';
import type { Output } from './cli/ui';
import { fakePorts } from './ports/fake';
import { runSetup, runStepper } from './run';
import { recordingShell } from './runner/recording-shell';
import { emptyState, readState, writeState } from './state/state-file';
import { STEPS, stepsFor } from './steps';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const HERE = path.resolve(__dirname, '..');
const LOCAL_EXAMPLE = path.join(HERE, 'answers.local.example.json');
const SERVER_EXAMPLE = path.join(HERE, 'answers.server.example.json');
/** The document the CI install smoke job installs from (plan E5.2). */
const CI_ANSWERS = path.join(ROOT, 'ci', 'answers.local.json');

function output(): Output & { text: string } {
  const out = {
    text: '',
    isTTY: false,
    write(chunk: string) {
      out.text += chunk;
    },
  };
  return out;
}

/**
 * The example answers files are the contract between the stepper and a CI or
 * automation run (plan E4.2): every step must accept them without a prompt.
 * The specs drive the real step loop from each file with fake ports and no
 * terminal, which is exactly the shape the E5.2 install smoke job runs.
 */
describe('the example answers files', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tme-run-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it.each([
    ['local', LOCAL_EXAMPLE],
    ['server', SERVER_EXAMPLE],
    ['ci', CI_ANSWERS],
  ])('%s parses under the answers schema with no legacy key', (_label, file) => {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(raw).not.toHaveProperty('license');
    expect(() => parseAnswers(raw, file)).not.toThrow();
  });

  it('answers every local step without a terminal and persists no secret', async () => {
    const out = output();
    const stateFile = path.join(dir, 'state.json');
    const state = await runStepper(
      {
        profile: null,
        answersFile: LOCAL_EXAMPLE,
        dryRun: false,
        stateFile,
        root: ROOT,
        reset: false,
        help: false,
        version: false,
      },
      { out, ports: fakePorts(), isTTY: false },
    );
    expect(state.completedSteps).toEqual(stepsFor('local').map((s) => s.id));
    expect(state.answers.money?.vatRate).toBe(0.2);
    expect(state.answers.brand?.accent).toBeNull();
    const persisted = readState(stateFile);
    for (const secret of SECRET_ANSWER_PATHS)
      expect(getPath(persisted.answers, secret)).toBeUndefined();
    expect(fs.readFileSync(stateFile, 'utf8')).not.toContain('CorrectHorse9x');
    expect(out.text).toContain('[1/');
  });

  it('takes no answer from an earlier run when a document drives it', async () => {
    const stateFile = path.join(dir, 'state.json');
    writeState(stateFile, {
      ...emptyState(),
      completedSteps: ['identity', 'mail'],
      answers: { mail: { fromName: 'Old Store' } },
    });
    const state = await runStepper(
      {
        profile: null,
        answersFile: LOCAL_EXAMPLE,
        dryRun: false,
        stateFile,
        root: ROOT,
        reset: false,
        help: false,
        version: false,
      },
      { out: output(), ports: fakePorts(), isTTY: false },
    );
    expect(state.answers.mail?.fromName).toBe('Atlas Demo');
    expect(readState(stateFile).answers.mail?.fromName).toBe('Atlas Demo');
  });

  it('answers every server step with the hosts resolving to this box', async () => {
    const out = output();
    const ports = fakePorts();
    for (const host of ['atlas.example', 'admin.atlas.example', 'api.atlas.example']) {
      ports.hosts.set(host, ['203.0.113.5']);
    }
    const state = await runStepper(
      {
        profile: null,
        answersFile: SERVER_EXAMPLE,
        dryRun: false,
        stateFile: path.join(dir, 's.json'),
        root: ROOT,
        reset: false,
        help: false,
        version: false,
      },
      { out, ports, isTTY: false },
    );
    expect(state.completedSteps).toContain('summary');
  });

  it('warns once about a legacy license key and drives the run without it', async () => {
    const out = output();
    const stateFile = path.join(dir, 's.json');
    const file = path.join(dir, 'legacy.json');
    const local = JSON.parse(fs.readFileSync(LOCAL_EXAMPLE, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...local, license: { file: 'license.json' } }));
    const state = await runStepper(
      {
        profile: null,
        answersFile: file,
        dryRun: false,
        stateFile,
        root: ROOT,
        reset: false,
        help: false,
        version: false,
      },
      { out, ports: fakePorts(), isTTY: false },
    );
    expect(state.completedSteps).toEqual(stepsFor('local').map((s) => s.id));
    expect(out.text.match(/license/gi)).toHaveLength(1);
    expect(out.text).toMatch(/license.*ignored/i);
    expect(state.answers).not.toHaveProperty('license');
    expect(readState(stateFile).answers).not.toHaveProperty('license');
  });

  it('drives every storefront step from a document and names the revalidate secret when it is missing', async () => {
    const ports = fakePorts();
    ports.hosts.set('atlas.example', ['203.0.113.5']);
    const doc = {
      profile: 'storefront',
      domains: {
        storefront: 'https://atlas.example',
        admin: 'https://admin.atlas.example',
        api: 'https://api.atlas.example',
        certbotEmail: 'ops@atlas.example',
      },
      engine: { apiUrl: 'https://api.atlas.example', revalidateSecret: 'b'.repeat(64) },
      turnstile: { siteKey: '0xSITEKEY1234' },
      seo: { indexNowKey: 'abcdef1234' },
    };
    const file = path.join(dir, 'storefront.json');
    fs.writeFileSync(file, JSON.stringify(doc));
    const state = await runStepper(
      {
        profile: null,
        answersFile: file,
        dryRun: false,
        stateFile: path.join(dir, 's.json'),
        root: ROOT,
        reset: false,
        help: false,
        version: false,
      },
      { out: output(), ports, isTTY: false },
    );
    expect(state.completedSteps).toEqual(stepsFor('storefront').map((s) => s.id));
    expect(state.answers.engine?.revalidateSecret).toBe('b'.repeat(64));
    expect(state.answers.turnstile).toEqual({ enabled: true, siteKey: '0xSITEKEY1234' });
    expect(
      getPath(readState(path.join(dir, 's.json')).answers, 'engine.revalidateSecret'),
    ).toBeUndefined();

    const withoutSecret = path.join(dir, 'storefront-no-secret.json');
    fs.writeFileSync(
      withoutSecret,
      JSON.stringify({ ...doc, engine: { apiUrl: doc.engine.apiUrl } }),
    );
    await expect(
      runStepper(
        {
          profile: null,
          answersFile: withoutSecret,
          dryRun: false,
          stateFile: path.join(dir, 's3.json'),
          root: ROOT,
          reset: false,
          help: false,
          version: false,
        },
        { out: output(), ports, isTTY: false },
      ),
    ).rejects.toThrow(/engine\.revalidateSecret/);
  });

  it('refuses to run with neither a terminal nor a document', async () => {
    await expect(
      runStepper(
        {
          profile: null,
          answersFile: null,
          dryRun: false,
          stateFile: path.join(dir, 's.json'),
          root: ROOT,
          reset: false,
          help: false,
          version: false,
        },
        { out: output(), ports: fakePorts(), isTTY: false },
      ),
    ).rejects.toThrow(/no --answers document/);
  });

  it('runs the whole local install on a dry run without touching the disk beyond the state file', async () => {
    const out = output();
    const shell = recordingShell({ [path.join(ROOT, 'prisma', 'search_fts_setup.sql')]: '-- fts' });
    await runSetup(
      {
        profile: null,
        answersFile: LOCAL_EXAMPLE,
        dryRun: true,
        stateFile: path.join(dir, 's.json'),
        root: ROOT,
        reset: false,
        help: false,
        version: false,
      },
      { out, ports: fakePorts(), isTTY: false, shell },
    );
    expect(out.text).toContain('backend server installed successfully!');
    expect(shell.commands.some((c) => c.args.includes('build'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 's.json'))).toBe(false);
  });

  it('prints no secret on a real dry run of the local profile', async () => {
    // The real dry-run shell, not the recording one: this is the surface the
    // operator reads, and an env file is mostly secrets.
    const out = output();
    await runSetup(
      {
        profile: null,
        answersFile: LOCAL_EXAMPLE,
        dryRun: true,
        stateFile: path.join(dir, 's.json'),
        root: ROOT,
        reset: false,
        help: false,
        version: false,
      },
      { out, ports: fakePorts(), isTTY: false },
    );
    expect(out.text).toContain('contents withheld');
    expect(out.text).not.toMatch(/DB_PASSWORD="[0-9a-f]{64}"/);
    expect(out.text).not.toMatch(/BETTER_AUTH_SECRET="[0-9a-f]{64}"/);
    expect(out.text).not.toContain('Replace_With_A_Local_Password1');
    expect(out.text).toContain('backend server installed successfully!');
  });

  it('lists the steps the plan names, in its order', () => {
    expect(STEPS.map((s) => s.id)).toEqual([
      'profile',
      'identity',
      'domains',
      'brand',
      'localization',
      'money',
      'storage',
      'mail',
      'turnstile',
      'seo',
      'payments',
      'owner',
      'demo-catalogue',
      'summary',
    ]);
  });
});
