/**
 * Which DSH files this shell's design depends on, and whether they still are
 * the files it was last verified against.
 *
 *   node bin/dsh-surface.mjs                  # check the installed DSH
 *   node bin/dsh-surface.mjs --record         # re-record the baseline
 *   node bin/dsh-surface.mjs --against <file> # check against another baseline
 *
 * The shell pins no DSH version: it resolves `$DSH_HOME/profiles/node_modules/
 * @deepseek-ai/dsh` through `realpathSync` on every launch, so a DSH upgrade is
 * picked up automatically and nothing here needs editing for one. What an
 * upgrade *can* do is move the ground under the shell's contracts — the
 * readiness line, the argv hand-off, the port schema, the auth cookie prefix —
 * and the answer to "did it?" is otherwise re-derived by hand every time.
 *
 * What this tool does and does not claim, because the difference matters:
 * a `CHANGED` line is a **trigger**, not a verdict. It says these bytes are not
 * the bytes that were read and measured; the contract may still hold, and which
 * contract broke (if any) is a question only reading the diff can answer. A
 * clean run is the reverse statement and is stronger: these *are* the files the
 * last verification read, so the measurements in `docs/agent-notes/` still
 * apply to them.
 *
 * `--record` is for after a verification, never instead of one. It records what
 * is installed right now as "the bytes we have read and re-measured the ladder
 * against" — running it without having done that turns the check into a rubber
 * stamp, which is the one failure mode this file exists to prevent.
 *
 * @module dsh-desktop/bin/dsh-surface
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveDshHome, resolveInstallAnchor } from '../src/paths.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASELINE = join(ROOT, 'docs', 'agent-notes', 'dsh-surface.json');

/**
 * The coupled surface: paths relative to the `@deepseek-ai/` package root.
 *
 * Each entry's `why` states the shell-side reader that would have to be
 * re-examined if the file changed. A pattern may contain one `*`, which is how a
 * hashed build artifact is named after a rebuild — those are reported as MOVED
 * rather than as a change, because a rename is not evidence either way.
 */
const SURFACE = [
  {
    pattern: 'dsh/lib/bin.js',
    why: 'the CLI entry the anchor resolves: `--profile web` and the pass-through of `--port`/`--no-open` (src/args.mjs)',
  },
  {
    pattern: 'dsh/lib/profile-boot-*.js',
    why: 'runProfile installs installFailLoud, which is why the harness runs in a child process at all (AGENTS.md fact 1)',
  },
  {
    pattern: 'dsh-web-app/lib/index.js',
    why: 'the readiness line the shell parses out of the child`s stdout (src/url-line.mjs)',
  },
  {
    pattern: 'dsh-web-app/lib/startup.js',
    why: 'the flag surface: `--port <n>` (0 means "let the OS pick") and `--no-open` (src/args.mjs)',
  },
  {
    pattern: 'dsh-web-app/cordis.patch.yml',
    why: 'the port fallback `ctx.webStartup.port ?? 3080`, which must stay nullish for `--port 0` to survive',
  },
  {
    pattern: 'dsh-host-webserver/lib/index.js',
    why: 'the webserver schema: `port` must keep accepting 0, or the OS-assigned port silently becomes a fixed one',
  },
  {
    pattern: 'dsh-client-connection/lib/index.js',
    why: 'the auth fence (401 for a clean root, 303 + Set-Cookie for a token URL) and the `dsh-auth-` cookie prefix the shell sweeps (src/main.js)',
  },
  {
    pattern: 'dsh-app-boot/lib/index.js',
    why: 'the fail-loud kill switch, and the rule that a `DSH_*` variable may not come from an environment file (src/paths.mjs)',
  },
  {
    pattern: 'dsh-client-locale/lib/client.js',
    why: 'the GUI`s language rule — exact id, then primary subtag — which the shell`s own resolver mirrors (src/i18n.mjs)',
  },
  {
    pattern: 'dsh-host-directory-picker-auto/README.md',
    why: 'the SSH rule the shell implements by deleting SSH_* from the child`s environment (src/harness.mjs)',
  },
  {
    pattern: 'dsh-subprocess-local/lib/runner-launch-*.js',
    why: 'the Windows tree-kill precedent the shell copies: `taskkill /PID <pid> /T /F` (src/harness.mjs)',
  },
  {
    pattern: 'dsh-web-frontend/dist/favicon.svg',
    why: 'the source of the app`s icon, read at build time by tools/make-icon.mjs',
  },
];

/**
 * SHA-256 of a file, or null when it cannot be read.
 * @param path - the file.
 * @returns the hex digest.
 */
function hashFile(path) {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Every installed file a pattern names, as `relative path -> sha256`.
 * @param packagesDir - the `node_modules/@deepseek-ai` directory.
 * @param pattern - the surface entry's pattern.
 * @returns the map; empty when the package or directory is absent.
 */
function readPattern(packagesDir, pattern) {
  const slash = pattern.indexOf('/');
  const pkg = pattern.slice(0, slash);
  const rest = pattern.slice(slash + 1);
  const star = basename(rest).indexOf('*');
  if (star === -1) {
    const path = join(packagesDir, pkg, rest);
    const digest = hashFile(path);
    return digest === null ? {} : { [pattern]: digest };
  }
  const directory = join(packagesDir, pkg, dirname(rest));
  const prefix = basename(rest).slice(0, star);
  const suffix = basename(rest).slice(star + 1);
  let names;
  try {
    names = readdirSync(directory);
  } catch {
    return {};
  }
  const files = {};
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(suffix) || name.length < prefix.length + suffix.length) continue;
    const digest = hashFile(join(directory, name));
    if (digest === null) continue;
    files[`${pkg}/${dirname(rest) === '.' ? '' : `${dirname(rest)}/`}${name}`] = digest;
  }
  return files;
}

/**
 * Resolve the installed surface, or a reason it cannot be read.
 *
 * "Cannot read" is reported as its own outcome and never as an empty result:
 * an installation that is absent, or an anchor that has moved, must not be
 * indistinguishable from a surface that matched.
 *
 * @returns `{ packagesDir, version }` or `{ error }`.
 */
function resolveSurface() {
  try {
    const anchor = resolveInstallAnchor(resolveDshHome());
    return { packagesDir: dirname(anchor.dir), version: anchor.version, error: null };
  } catch (error) {
    return { packagesDir: null, version: null, error: error.message };
  }
}

/**
 * Read the baseline, or a reason it cannot be used.
 * @param path - the baseline file.
 * @returns the parsed object, or `{ error }`.
 */
function readBaseline(path) {
  if (!existsSync(path)) return { error: `no baseline at ${path}; run \`npm run surface -- --record\` after a verification` };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(parsed?.patterns)) return { error: `${path} has no patterns array` };
    return parsed;
  } catch (error) {
    return { error: `${path} is unreadable: ${error.message}` };
  }
}

/** Fail with a reason that distinguishes "cannot read" from "changed". */
function unreadable(reason) {
  process.stderr.write(`dsh-surface: CANNOT CHECK — ${reason}\n`);
  process.stderr.write('dsh-surface: this is not a pass; nothing about the installed DSH was compared.\n');
  process.exit(2);
}

const argv = process.argv.slice(2);
const record = argv.includes('--record');
const againstIndex = argv.indexOf('--against');
const baselinePath = againstIndex === -1 ? DEFAULT_BASELINE : argv[againstIndex + 1];
if (againstIndex !== -1 && (baselinePath === undefined || baselinePath.startsWith('--'))) {
  unreadable('--against needs a path');
}

const surface = resolveSurface();
if (surface.error !== null) unreadable(surface.error);

if (record) {
  const patterns = SURFACE.map(({ pattern, why }) => ({
    pattern,
    why,
    files: readPattern(surface.packagesDir, pattern),
  }));
  const empty = patterns.filter((entry) => Object.keys(entry.files).length === 0);
  for (const entry of empty) process.stderr.write(`dsh-surface: warning — ${entry.pattern} matched nothing\n`);
  const baseline = {
    dshVersion: surface.version,
    recordedAt: new Date().toISOString(),
    patterns,
  };
  writeFileSync(DEFAULT_BASELINE, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
  const files = patterns.reduce((total, entry) => total + Object.keys(entry.files).length, 0);
  console.log(`dsh-surface: recorded DSH ${surface.version} — ${patterns.length} patterns, ${files} files`);
  console.log(`dsh-surface: ${DEFAULT_BASELINE}`);
  process.exit(empty.length === 0 ? 0 : 1);
}

const baseline = readBaseline(baselinePath);
if (baseline.error !== undefined) unreadable(baseline.error);

console.log(`dsh-surface: checking installed DSH ${surface.version} against ${baselinePath}`);
console.log(`dsh-surface: baseline records DSH ${baseline.dshVersion} (${baseline.recordedAt})`);
if (surface.version !== baseline.dshVersion) {
  console.log('dsh-surface: the installed version is not the recorded one — the surface below decides, not the number');
}
console.log('');

let changed = 0;
for (const entry of baseline.patterns) {
  const now = readPattern(surface.packagesDir, entry.pattern);
  const before = entry.files ?? {};
  const beforeNames = Object.keys(before).sort();
  const nowNames = Object.keys(now).sort();
  const detail = [];
  let verdict = 'IDENTICAL';

  if (nowNames.length === 0) {
    verdict = 'MISSING';
    detail.push('nothing installed matches this pattern');
  } else if (beforeNames.join() !== nowNames.join()) {
    verdict = 'MOVED';
    detail.push(`files: recorded [${beforeNames.join(', ')}], now [${nowNames.join(', ')}]`);
  } else {
    const differing = nowNames.filter((name) => before[name] !== now[name]);
    if (differing.length > 0) {
      verdict = 'CHANGED';
      for (const name of differing) detail.push(`${name}: ${String(before[name]).slice(0, 12)}… → ${String(now[name]).slice(0, 12)}…`);
    }
  }

  if (verdict !== 'IDENTICAL') changed += 1;
  console.log(`  ${verdict.padEnd(9)} ${entry.pattern}`);
  for (const line of detail) console.log(`             ${line}`);
}

console.log('');
console.log(`dsh-surface: ${baseline.patterns.length - changed}/${baseline.patterns.length} patterns identical`);
if (changed === 0) {
  console.log('dsh-surface: OK — the installed DSH surface is the one that was last read and measured');
  process.exit(0);
}

console.log('dsh-surface: NOT the verified surface. This is a trigger, not a verdict:');
console.log('  1. read what changed in the files named above (the `why` in the baseline says who reads each one)');
console.log('  2. re-run the ladder — `npm run smoke:dev`, then `npm run pack` and `npm run smoke`');
console.log('  3. only then `npm run surface -- --record`, which is a statement that the new bytes were verified');
process.exit(1);
