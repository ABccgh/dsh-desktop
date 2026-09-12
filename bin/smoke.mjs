/**
 * One command that runs the whole acceptance ladder and prints PASS/FAIL per step.
 *
 * Every check in this project was, until now, a sequence of ad-hoc PowerShell
 * commands that existed only in a session. This makes them repeatable by someone
 * who was not there.
 *
 *   node bin/smoke.mjs            # the packaged build
 *   node bin/smoke.mjs --dev      # from source, via the Electron runtime
 *
 * What it does NOT do, stated so a green run is not over-read: it does not verify
 * that the interface *looks* right, that a button works, or that the harness
 * answers a prompt. It verifies that the shell starts a correctly-identified
 * child, authenticates the window, and leaves nothing behind — including the
 * user's own GUI.
 *
 * @module dsh-desktop/bin/smoke
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEV = process.argv.includes('--dev');
const USER_DATA = join(process.env.APPDATA ?? '', 'DSH Desktop');
const LOG_DIR = join(USER_DATA, 'logs');
const PACKAGED_EXE = join(ROOT, 'dist', 'DSH Desktop', 'DSH Desktop.exe');
const DEV_EXE = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');

const results = [];
let failed = 0;

/**
 * Record one check.
 * @param label - what was checked.
 * @param ok - whether it held.
 * @param detail - the observation, printed either way.
 * @returns nothing.
 */
function check(label, ok, detail = '') {
  results.push({ label, ok, detail });
  if (!ok) failed += 1;
  process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : `  — ${detail}`}\n`);
}

/**
 * Run a PowerShell fragment and return its trimmed stdout.
 * @param script - the fragment.
 * @returns the output, or an empty string on failure.
 */
function ps(script) {
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', windowsHide: true, timeout: 30_000 },
  );
  return typeof result.stdout === 'string' ? result.stdout.trim() : '';
}

/**
 * The pid listening on a port, or null.
 * @param port - the port to look up.
 * @returns the owning pid.
 */
function listenerOn(port) {
  const out = ps(`(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue).OwningProcess`);
  const pid = Number.parseInt(out, 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * The harness children belonging to one app process.
 *
 * Claimed by **parentage**, not by a global pattern match. A pattern finds every
 * harness child on the machine — including one left behind by an earlier run, or
 * one belonging to a packaged instance running from the same userData — and then
 * "exactly one child" passes or fails for a reason that has nothing to do with
 * the app under test. Measured: an unrelated instance's child made an earlier
 * version of this script report a phantom.
 *
 * @param appPid - the app process whose children to claim.
 * @returns the pids.
 */
function harnessChildren(appPid) {
  if (!Number.isInteger(appPid) || appPid <= 0) return [];
  const out = ps(
    `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ` +
      `Where-Object { $_.ParentProcessId -eq ${appPid} -and $_.CommandLine -match 'bin\\.js' } | ` +
      `ForEach-Object { $_.ProcessId }`,
  );
  return out === '' ? [] : out.split(/\s+/).map(Number).filter(Number.isInteger);
}

/**
 * Wait for a condition to hold.
 * @param label - what is being waited for.
 * @param probe - returns true when it holds.
 * @param timeoutMs - how long to wait.
 * @returns true when it held in time.
 */
async function waitFor(label, probe, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (probe()) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  process.stdout.write(`  (timed out waiting for ${label})\n`);
  return false;
}

/**
 * The newest log file, or null.
 * @returns the absolute path.
 */
function newestLog() {
  if (!existsSync(LOG_DIR)) return null;
  const files = readdirSync(LOG_DIR)
    .filter((name) => name.startsWith('app-') && name.endsWith('.log'))
    .map((name) => ({ name, at: statSync(join(LOG_DIR, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  return files.length === 0 ? null : join(LOG_DIR, files[0].name);
}

// ---------------------------------------------------------------------------

if (!existsSync(LOG_DIR)) {
  process.stdout.write(`FAIL  no log directory at ${LOG_DIR}; the app has never run\n`);
  process.exit(1);
}

const exe = DEV ? DEV_EXE : PACKAGED_EXE;
if (!existsSync(exe)) {
  process.stdout.write(`FAIL  ${exe} does not exist${DEV ? '' : " — run 'npm run pack' first"}\n`);
  process.exit(1);
}

process.stdout.write(`DSH Desktop smoke test (${DEV ? 'from source' : 'packaged'})\n\n`);

const logBefore = newestLog();
const pid3080Before = listenerOn(3080);
process.stdout.write(`  baseline: 3080 owned by ${String(pid3080Before)}, previous log ${String(logBefore)}\n\n`);

const app = spawn(
  exe,
  DEV ? [ROOT, '--settings'] : [],
  { cwd: DEV ? ROOT : dirname(exe), stdio: 'ignore', windowsHide: false, detached: false },
);
const appPid = app.pid;

const ready = await waitFor(
  'the readiness line',
  () => {
    const log = newestLog();
    if (log === null || log === logBefore) return false;
    try {
      return /ready: port=\d+/.test(readFileSync(log, 'utf8'));
    } catch {
      return false;
    }
  },
  90_000,
);

const log = newestLog();
const text = log === null ? '' : readFileSync(log, 'utf8');
check('the harness reported a readiness URL', ready, log === null ? 'no log' : log.split('\\').pop());
const port = Number.parseInt(/ready: port=(\d+)/.exec(text)?.[1] ?? '', 10);
check('the port is a real OS-assigned port', Number.isInteger(port) && port > 0 && port !== 3080, `port=${String(port)}`);

await waitFor('the interface to mount', () => /interface mounted: true/.test(readFileSync(log ?? '', 'utf8')), 60_000);
const after = readFileSync(log ?? '', 'utf8');
check('the interface mounted', /interface mounted: true/.test(after));
check('the token never reached the log', !/token=(?!\*\*\*)/.test(after));

const children = harnessChildren(appPid);
check('exactly one harness child is running', children.length === 1, `pids=[${children.join(',')}]`);
check('the child owns the readiness port', listenerOn(port) === children[0], `listener=${String(listenerOn(port))}`);

const argv = ps(
  `(Get-CimInstance Win32_Process -Filter "ProcessId=${String(children[0] ?? 0)}").CommandLine`,
);
check('the child runs our exact argv', /--profile web --port \d+ --no-open/.test(argv), argv.slice(0, 90));

try {
  const response = await fetch(`http://127.0.0.1:${String(port)}/`);
  check('an unauthenticated root request is refused', response.status === 401, `HTTP ${String(response.status)}`);
} catch (error) {
  check('an unauthenticated root request is refused', false, error.message);
}

check('the user\'s own GUI is untouched while we run', listenerOn(3080) === pid3080Before, `3080=${String(listenerOn(3080))}`);

// A graceful close request, not a kill: this exercises the quit path.
// `CloseMainWindow()` because it is the mechanism measured to work here —
// `taskkill /PID <pid> /T` without `/F` left the app running.
process.stdout.write('\n  closing the app…\n');
ps(`(Get-Process -Id ${String(appPid)} -ErrorAction SilentlyContinue).CloseMainWindow() | Out-Null`);
const gone = await waitFor('the app to exit', () => harnessChildren(appPid).length === 0, 40_000);
check('quitting reaped the harness child', gone, `remaining=[${harnessChildren(appPid).join(',')}]`);
check('the user\'s own GUI outlived us', listenerOn(3080) === pid3080Before, `3080=${String(listenerOn(3080))}`);
check('the child record was cleared on a clean quit', (() => {
  try {
    const state = JSON.parse(readFileSync(join(USER_DATA, 'state.json'), 'utf8'));
    return state.child === null;
  } catch {
    return false;
  }
})());

if (appPid !== undefined) {
  try {
    process.kill(appPid, 0);
    spawnSync('taskkill', ['/PID', String(appPid), '/T', '/F'], { windowsHide: true, encoding: 'utf8' });
  } catch {
    // Already gone — the expected case.
  }
}

process.stdout.write(`\n${results.length - failed}/${results.length} checks passed\n`);
process.exit(failed === 0 ? 0 : 1);
