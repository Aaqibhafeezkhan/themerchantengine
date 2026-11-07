// Cuts a release of the engine (plan E5.3).
//
//   npm run release                 check, build the stepper, write the tarball, tag
//   npm run release -- --dry-run    run the checks and print the plan, write nothing
//   npm run release -- --no-tag     write the tarball without tagging
//   npm run release -- --out <dir>  where the tarball goes (default dist/release)
//
// The tarball is `git archive HEAD` plus the built stepper bundle, so an
// operator who downloads it can run ./setup.sh with nothing but Node and
// Docker: the wrapper finds the bundle newer than every source and does not
// build. Only tracked files are archived, so no env file, state file or
// node_modules can travel.
//
// The script does not choose the version. It reads package.json, requires a
// CHANGELOG.md section for that version and a clean tree, and refuses a tag
// that already exists; deciding the number is a person's job.
import { execFileSync, execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const noTag = args.includes('--no-tag');
const outIndex = args.indexOf('--out');
const outDir = path.resolve(outIndex >= 0 ? args[outIndex + 1] : path.join('dist', 'release'));

const root = process.cwd();
const say = (line) => process.stdout.write(`${line}\n`);
const refuse = (what, how) => {
  process.stderr.write(`release: ${what}\n  ${how}\n`);
  process.exit(1);
};
const git = (...gitArgs) =>
  execFileSync('git', gitArgs, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

// ── checks ────────────────────────────────────────────────────────────────
let top;
try {
  top = git('rev-parse', '--show-toplevel');
} catch {
  refuse('this directory is not a git checkout.', 'Run the release from the repository root.');
}
if (path.resolve(top) !== path.resolve(root)) {
  refuse(
    `the repository root is ${top}, not ${root}.`,
    'Run the release from the repository root.',
  );
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version ?? '')) {
  refuse(
    `package.json carries the version "${version}", which is not a release version.`,
    'Set a semantic version in package.json first.',
  );
}
const tag = `v${version}`;

const dirty = git('status', '--porcelain');
if (dirty) {
  refuse(
    'the working tree is not clean; a release archives HEAD and must match it.',
    'Commit or stash every change, then run the release again.',
  );
}

// The version's section must be the FIRST section, not merely present: an
// older release's section is always present, and a newer entry left under a
// working title such as "Unreleased" would otherwise ship under the old notes.
const changelogPath = path.join(root, 'CHANGELOG.md');
const changelog = fs.existsSync(changelogPath) ? fs.readFileSync(changelogPath, 'utf8') : '';
const firstSection = (changelog.match(/^## +(.+?)\s*$/m) ?? [])[1] ?? '';
const titled = firstSection.replace(/^\[|\]$/g, '').replace(/^v/, '');
if (titled !== version) {
  refuse(
    `CHANGELOG.md's first section is "## ${firstSection || '(none)'}", not "## ${version}".`,
    `Title the entry for ${version} at the top of CHANGELOG.md (or run npm run changeset:version), commit it, and run the release again.`,
  );
}

const existingTag = git('tag', '--list', tag);
if (existingTag) {
  refuse(
    `the tag ${tag} already exists.`,
    'Bump the version in package.json and add its changelog section, or delete the tag if it was cut by mistake.',
  );
}

const bundle = path.join(root, 'tools', 'setup', 'dist', 'index.js');
const tarball = path.join(outDir, `${pkg.name}-${tag}.tar.gz`);
const head = git('rev-parse', '--short', 'HEAD');

say(`release ${tag} from ${head}`);
say(`  stepper bundle: ${path.relative(root, bundle)}`);
say(`  tarball:        ${path.relative(root, tarball)}`);
say(`  tag:            ${noTag ? '(skipped, --no-tag)' : tag}`);
if (dryRun) {
  say('dry run: every check passed, nothing written');
  process.exit(0);
}

// ── build the stepper ─────────────────────────────────────────────────────
say('building the stepper bundle');
// One command string: npm is a .cmd on Windows and needs a shell, and an args array with a shell warns on Node 24.
execSync('npm run build:setup', { cwd: root, stdio: 'inherit' });
if (!fs.existsSync(bundle))
  refuse(`the build did not produce ${bundle}.`, 'Read the build output above.');

// ── archive HEAD plus the bundle ──────────────────────────────────────────
const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'tme-release-'));
try {
  // Relative paths under one cwd on purpose: the tar on Windows reads a drive
  // letter in an absolute path as a remote host. autocrlf off: a Windows
  // release machine would otherwise ship CRLF to Linux boxes. The bundle is
  // appended to the git archive tar rather than extracted and repacked: a
  // Windows tar would repack every file without the exec bits git records.
  execFileSync(
    'git',
    [
      '-c',
      'core.autocrlf=false',
      'archive',
      '--format=tar',
      '-o',
      path.join(staging, 'head.tar'),
      'HEAD',
    ],
    { cwd: root, stdio: 'inherit' },
  );
  const bundleTarget = path.join(staging, 'tools', 'setup', 'dist', 'index.js');
  fs.mkdirSync(path.dirname(bundleTarget), { recursive: true });
  fs.copyFileSync(bundle, bundleTarget);
  // The wrapper rebuilds when a source is newer than the bundle; git archive
  // stamps every file with the commit time, and the copy above is stamped now.
  const now = new Date();
  fs.utimesSync(bundleTarget, now, now);
  // Root ownership, so the operator's user name does not ship in the header.
  const gnuTar = execFileSync('tar', ['--version'], { encoding: 'utf8' }).includes('GNU tar');
  const owner = gnuTar ? ['--owner=0', '--group=0'] : ['--uid', '0', '--gid', '0'];
  execFileSync(
    'tar',
    ['-rf', 'head.tar', '--numeric-owner', ...owner, 'tools/setup/dist/index.js'],
    {
      cwd: staging,
      stdio: 'inherit',
    },
  );
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(tarball, zlib.gzipSync(fs.readFileSync(path.join(staging, 'head.tar'))));
} finally {
  fs.rmSync(staging, { recursive: true, force: true });
}
say(`wrote ${path.relative(root, tarball)}`);

// ── tag ───────────────────────────────────────────────────────────────────
if (!noTag) {
  git('tag', '-a', tag, '-m', `${pkg.name} ${tag}`);
  say(`tagged ${tag}`);
}

say('');
say('next:');
if (!noTag) say(`  git push origin ${tag}`);
say(`  attach ${path.relative(root, tarball)} to the ${tag} release on the repository host`);
