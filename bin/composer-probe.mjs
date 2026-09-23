/**
 * Drive the GUI's composer in a real launch, and report what came back.
 *
 *   npm run probe                     # type into the editor, do not send
 *   npm run probe -- --inject-error   # also prove the instrument sees errors
 *   npm run probe -- --submit         # also press Enter (a real model call)
 *   npm run probe -- --keep           # leave the window open afterwards
 *
 * Why this exists, in one sentence: the acceptance ladder starts a real harness
 * and loads the real interface, and never touches the editor — so on 2026-09-23 a
 * composer that threw 75 errors in three minutes passed it, and "0 page errors"
 * could not be read as anything at all.
 *
 * What it does: creates a scratch workspace, launches the shell with the
 * development-only `--probe-composer` switch, waits for the shell's own
 * `probe: {…}` line, and reads it back. It reports what it exercised — which
 * selector matched, whether the typed text actually landed, how many reference
 * chips formed, how many page errors arrived — so that "nothing was driven" can
 * never be mistaken for "nothing was wrong".
 *
 * Exit codes: 0 the composer was driven, 1 something was reported unhealthy (or
 * the instrument failed its own falsification), 2 UNREADABLE — nothing was
 * compared, which is not a pass.
 *
 * @module dsh-desktop/bin/composer-probe
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEV_EXE = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const USER_DATA = join(process.env.APPDATA ?? '', 'DSH Desktop');
const LOG_DIR = join(USER_DATA, 'logs');
const STATE_PATH = join(USER_DATA, 'state.json');

const argv = process.argv.slice(2);
const INJECT = argv.includes('--inject-error');
const SUBMIT = argv.includes('--submit');
const KEEP = argv.includes('--keep');

/** Run a PowerShell fragment and return its trimmed stdout. */
function ps(script) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
  });
  return typeof result.stdout === 'string' ? result.stdout.trim() : '';
}

/** The newest log file, or null. */
function newestLog() {
  if (!existsSync(LOG_DIR)) return null;
  const files = readdirSync(LOG_DIR)
    .filter((name) => name.startsWith('app-') && name.endsWith('.log'))
    .map((name) => ({ name, at: statSync(join(LOG_DIR, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  return files.length === 0 ? null : join(LOG_DIR, files[0].name);
}

/** Wait for a condition, bounded. */
async function waitFor(probe, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (probe()) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

/** The harness children belonging to one app process, by parentage. */
function harnessChildren(appPid) {
  if (!Number.isInteger(appPid) || appPid <= 0) return [];
  const out = ps(
    `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ` +
      `Where-Object { $_.ParentProcessId -eq ${String(appPid)} -and $_.CommandLine -match 'bin\\.js' } | ` +
      `ForEach-Object { $_.ProcessId }`,
  );
  return out === '' ? [] : out.split(/\s+/).map(Number).filter(Number.isInteger);
}

/** Close one launch through its window, then make sure the tree is gone. */
async function closeApp(appPid) {
  if (Number.isInteger(appPid) && appPid > 0) {
    ps(`(Get-Process -Id ${String(appPid)} -ErrorAction SilentlyContinue).CloseMainWindow() | Out-Null`);
  }
  await waitFor(() => harnessChildren(appPid).length === 0, 30_000);
  for (const pid of [...harnessChildren(appPid), appPid]) {
    if (!Number.isInteger(pid) || pid <= 0) continue;
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8' });
  }
}

/** The `lastWorkspace` a previous run recorded, so this one can put it back. */
function readLastWorkspace() {
  try {
    const state = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
    return typeof state.lastWorkspace === 'string' ? state.lastWorkspace : null;
  } catch {
    return null;
  }
}

/**
 * Put the user's `lastWorkspace` back.
 *
 * The probe has to launch with a scratch workspace (so its session and its file
 * reference land somewhere harmless), and the shell records whatever workspace it
 * was given. Without this, the user's next launch would open in %TEMP%.
 *
 * @param workspace - the value to restore, or null to leave the file alone.
 */
function restoreLastWorkspace(workspace) {
  if (workspace === null) return;
  try {
    const state = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
    if (state.lastWorkspace === workspace) return;
    state.lastWorkspace = workspace;
    writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    process.stdout.write(`  restored lastWorkspace to ${workspace}\n`);
  } catch (error) {
    process.stdout.write(`  could not restore lastWorkspace: ${error.message}\n`);
  }
}

/** Close the app, put the user's workspace back, and remove the scratch directory. */
async function finish() {
  await closeApp(appPid);
  restoreLastWorkspace(previousWorkspace);
  try {
    rmSync(workspace, { recursive: true, force: true });
  } catch (error) {
    process.stdout.write(`  could not remove the scratch workspace: ${error.message}\n`);
  }
}

// ---------------------------------------------------------------------------
// Preconditions
// ---------------------------------------------------------------------------
if (!existsSync(DEV_EXE)) {
  process.stdout.write(`FAIL  ${DEV_EXE} is missing — run 'npm install' (see RUNBOOK.md)\n`);
  process.exit(2);
}
const running = ps(`(Get-Process -Name 'DSH Desktop','electron' -ErrorAction SilentlyContinue | Measure-Object).Count`);
if (Number.parseInt(running, 10) > 0) {
  process.stdout.write(
    'FAIL  another DSH Desktop / electron instance is running; it holds the single-instance lock.\n' +
      '      Close it first — a launch that loses the lock exits and this probe would read the wrong log.\n',
  );
  process.exit(2);
}

// ---------------------------------------------------------------------------
// A scratch workspace, so the probe's session and reference land somewhere else
// ---------------------------------------------------------------------------

const workspace = join(tmpdir(), 'dsh-desktop-probe', String(process.pid));
mkdirSync(workspace, { recursive: true });
writeFileSync(join(workspace, 'probe-target.md'), '# probe target\n\nThe composer probe types `@probe-target` at this file.\n', 'utf8');

const previousWorkspace = readLastWorkspace();
const logBefore = newestLog();
process.stdout.write(`DSH Desktop composer probe\n\n  workspace: ${workspace}\n`);
if (SUBMIT) process.stdout.write('  --submit: the probe will press Enter; that is one real model call\n');

const switches = ['--probe-composer'];
if (INJECT) switches.push('--probe-inject-error');
if (SUBMIT) switches.push('--probe-submit');

const app = spawn(DEV_EXE, [ROOT, workspace, ...switches], { cwd: ROOT, stdio: 'ignore', windowsHide: false });
const appPid = app.pid;
process.stdout.write(`  launched: pid ${String(appPid)}\n\n`);

const appeared = await waitFor(() => {
  const log = newestLog();
  if (log === null || log === logBefore) return false;
  try {
    return readFileSync(log, 'utf8').includes('probe: {');
  } catch {
    return false;
  }
}, 120_000);

const log = newestLog();
const text = log === null || log === logBefore ? '' : readFileSync(log, 'utf8');
const line = text.split('\n').findLast((candidate) => candidate.includes('probe: {'));
let report = null;
if (line !== undefined) {
  const start = line.indexOf('probe: {');
  try {
    report = JSON.parse(line.slice(start + 'probe: '.length));
  } catch (error) {
    process.stdout.write(`  the probe line is not JSON: ${error.message}\n`);
  }
}

if (!appeared || report === null) {
  process.stdout.write(
    `UNREADABLE  the shell wrote no probe report — nothing about the composer was compared.\n` +
      `            log: ${String(log)}\n` +
      `            (mount failure, a lost single-instance lock, and a probe that never ran all look like this)\n`,
  );
  if (KEEP) process.stdout.write('  --keep: leaving the app running\n');
  else await finish();
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const codes = Object.entries(report.pageErrors?.byCode ?? {})
  .map(([code, count]) => (code === 'other' ? `other=${String(count)}` : `#${code}=${String(count)}`))
  .join(' ');
process.stdout.write(`  selector   : ${String(report.selector)}\n`);
process.stdout.write(`  typed via  : ${String(report.method)} (${String(report.typed)} chars)\n`);
process.stdout.write(`  editor text: ${JSON.stringify(report.editorText)}\n`);
process.stdout.write(`  chips      : ${String(report.chips)}\n`);
process.stdout.write(
  `  @ menu     : ${report.picked?.label == null
    ? `no candidate pressed (menu ${report.picked?.menu === true ? 'opened' : 'never opened'}, ${String(report.picked?.options ?? 0)} row(s) seen)`
    : `${JSON.stringify(report.picked.label)} pressed`}\n`,
);
process.stdout.write(`  page errors: new=${String(report.newErrors)} inWindow=${String(report.pageErrors?.inWindow)} [${codes}]\n`);
if (INJECT) process.stdout.write(`  injected   : ${String(report.injectedErrors)} error(s) observed\n`);
const burstLine = text
  .split('\n')
  .find((candidate) => candidate.includes('the interface is reporting repeated errors'));
process.stdout.write(`  burst offer: ${burstLine === undefined ? 'not triggered' : burstLine.slice(burstLine.indexOf('the interface'))}\n`);
if (SUBMIT) process.stdout.write(`  submitted  : ${String(report.submitted)}\n`);
if (report.error !== null && report.error !== undefined) process.stdout.write(`  note       : ${String(report.error)}\n`);
process.stdout.write(`\n${JSON.stringify(report)}\n`);

if (KEEP) process.stdout.write('\n  --keep: leaving the app running\n');
else await finish();

let exit = 0;
if (report.ok !== true) {
  process.stdout.write('\nUNREADABLE  the composer was not driven (see `note` above) — not a pass.\n');
  exit = 2;
} else if (INJECT) {
  // A self-test run: the errors in this report are the probe's own, so the
  // verdict is about the instrument and the recovery path, never about the
  // composer. Judging the composer by errors the probe threw would be a check
  // that always fails.
  if (report.injectedErrors === 0) {
    process.stdout.write('\nFAIL  an intentional page error was thrown and the instrument saw none — the instrument is broken.\n');
    exit = 1;
  } else if (burstLine === undefined) {
    process.stdout.write(
      `\nFAIL  ${String(report.injectedErrors)} injected errors reached the detector and it never offered a reload — the recovery path is not wired.\n`,
    );
    exit = 1;
  } else {
    process.stdout.write(
      `\nOK  the instrument saw ${String(report.injectedErrors)} injected errors and the shell offered a reload.\n` +
        '    note: this run says nothing about the composer — the errors above are the probe\'s own.\n',
    );
  }
} else if (report.pageErrors?.inWindow >= (report.pageErrors?.threshold ?? 20)) {
  process.stdout.write('\nFAIL  the composer is in the reported failure shape: a burst of one kind of error.\n');
  exit = 1;
} else {
  process.stdout.write(`\nOK  the composer was driven; ${String(report.newErrors)} page error(s) arrived while it was.\n`);
  if (report.chips === 0) {
    process.stdout.write('    note: no reference chip formed — the `@` path was typed but the menu never offered a candidate.\n');
  }
}
process.exit(exit);
