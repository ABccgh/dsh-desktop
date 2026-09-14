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

/**
 * The extra launch that proves a forced language reaches the shell.
 *
 * `--language` is this shell's own switch: `main.js` reads it from
 * `process.argv` and turns it into Chromium's `--lang`, so the choice is
 * testable without touching the display — the startup log names the language it
 * resolved. The harness child is told nothing about language at all.
 */
const FORCED_LANGUAGE = ['--language', 'en'];

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

/**
 * The newest log's text, or an empty string.
 * @returns the contents.
 */
function newestLogText() {
  const log = newestLog();
  if (log === null) return '';
  try {
    return readFileSync(log, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Launch the app the way an operator would, with extra switches if given.
 *
 * A launch is always an operator launch: the window is really shown and really
 * closed through the OS. `appPid` is returned so the caller can close and kill
 * exactly the instance it started.
 *
 * @param extraArgs - switches to append after the app path (dev mode only).
 * @returns the child process.
 */
function launch(extraArgs = []) {
  const app = spawn(exe, DEV ? [ROOT, ...extraArgs] : extraArgs, {
    cwd: DEV ? ROOT : dirname(exe),
    stdio: 'ignore',
    windowsHide: false,
    detached: false,
  });
  lastAppPid = app.pid;
  return app;
}

/**
 * Close one launch through the window and wait for its whole tree to be gone.
 *
 * A graceful close request, not a kill: this exercises the quit path.
 * `CloseMainWindow()` because it is the mechanism measured to work here —
 * `taskkill /PID <pid> /T` without `/F` left the app running.
 *
 * @param appPid - the app process to close.
 * @param harnessPids - the harness children belonging to it.
 * @returns true when nothing of that launch is left.
 */
async function closeApp(appPid, harnessPids) {
  if (appPid !== undefined) {
    ps(`(Get-Process -Id ${String(appPid)} -ErrorAction SilentlyContinue).CloseMainWindow() | Out-Null`);
  }
  await waitFor('the app to exit', () => harnessChildren(appPid).length === 0, 40_000);
  for (const pid of [...harnessPids, appPid]) {
    if (!Number.isInteger(pid) || pid <= 0) continue;
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8' });
  }
  return harnessChildren(appPid).length === 0;
}

/**
 * The resolved-language line of a log, if it has one.
 *
 * Every log line is prefixed with a local timestamp, so a `^language:` anchor
 * never matches; the prefix is part of the pattern. Measured the hard way: three
 * runs reported "no language line" for logs that plainly carried one.
 *
 * @param text - the log's contents.
 * @returns `[whole, language, setting, system]`, or null.
 */
function languageLine(text) {
  return /(?:^|\n)\S*\s*language: (zh|en) \(setting ([^,]+), system ([^)]+)\)/u.exec(text);
}

/**
 * The forced launch's resolved-language line, waited for.
 *
 * The log is appended line by line and written by another process, so the
 * readiness line can be present while the language line is a moment behind:
 * reading once proved to be a race. Bounded, so a genuinely missing line fails.
 *
 * @returns the match, or null when no such line appeared in time.
 */
async function readForcedLanguageLine() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const found = languageLine(newestLogText());
    if (found !== null) return found;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}

let lastAppPid;

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

const app = launch();
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
// HTTP 431 is the one failure that reads as "the app is broken" with no error of
// its own: the GUI mints a cookie whose *name* carries the launch authority, the
// persistent partition kept every one of them, and past a few dozen the request
// headers exceed the harness's own limit. The startup sweep is what stops the
// jar growing; this check is what notices if the sweep stops working.
check(
  'the window was not refused for oversized request headers',
  !/HTTP 431/.test(after),
  (/navigated: [^\n]*/.exec(after) ?? ['no navigation'])[0],
);

// The shell's own language: `auto` on this machine (zh-CN) must resolve to
// Chinese, and the log names the decision rather than leaving it to the eye.
const resolved = languageLine(after);
check(
  'the shell resolved a language and said which',
  resolved !== null,
  resolved === null ? 'no language line' : `setting=${resolved[2].trim()} system=${resolved[3].trim()} → ${resolved[1]}`,
);
check(
  'an explicit choice or the system language decides it',
  resolved !== null && (resolved[2].trim() === 'auto' ? resolved[1] === 'zh' : resolved[1] === resolved[2].trim()),
  resolved === null ? 'no language line' : `setting=${resolved[2].trim()} system=${resolved[3]} → ${resolved[1]}`,
);

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

process.stdout.write('\n  closing the app…\n');
const gone = await closeApp(appPid, children);
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

// ---------------------------------------------------------------------------
// A second launch, with the language forced. The point is the pair: the run
// above took the system's language, this one overrides it, and both say so.
// ---------------------------------------------------------------------------

process.stdout.write('\n  relaunching with the language forced…\n');
const logBeforeForced = newestLog();
launch(FORCED_LANGUAGE);
const forcedReported = await waitFor(
  'the forced launch to report its URL',
  () => {
    const current = newestLog();
    return current !== null && current !== logBeforeForced && /ready: port=\d+/.test(newestLogText());
  },
  90_000,
);
check('the forced launch started a harness', forcedReported, newestLog() === null ? 'no log' : newestLog().split('\\').pop());
const forcedText = await readForcedLanguageLine();
// The settings line is the one that names both the setting and the system
// language; "language: prompting Chromium with en-US" is a different line and
// matching it would report a pass for the wrong fact.
check(
  'an explicit --language overrides the system language',
  forcedText !== null && forcedText[2].trim() === 'en' && forcedText[1] === 'en' && forcedText[3].trim() !== 'en',
  forcedText === null
    ? 'no language line'
    : `setting=${forcedText[2].trim()} system=${forcedText[3].trim()} → ${forcedText[1]}`,
);
const forcedChildren = harnessChildren(lastAppPid);
check('the forced launch has exactly one harness child', forcedChildren.length === 1, `pids=[${forcedChildren.join(',')}]`);
process.stdout.write('  closing the forced launch…\n');
const forcedGone = await closeApp(lastAppPid, forcedChildren);
// Read after the close: before it, the query reports the child that is still
// alive, which would print a number that contradicts the check next to it.
check('the forced launch reaps its child too', forcedGone, `remaining=[${harnessChildren(lastAppPid).join(',')}]`);

process.stdout.write(`\n${results.length - failed}/${results.length} checks passed\n`);
process.exit(failed === 0 ? 0 : 1);
