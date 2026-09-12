/**
 * Finding and reaping a harness child left behind by a previous run.
 *
 * This is the only place in the shell that terminates a process it did not
 * spawn, so identity is verified before anything is killed. A PID alone is not
 * identity: Windows reuses PIDs, and the user's own `dsh web` runs the *same*
 * CLI entry path as our child, so an argv match alone would not distinguish
 * them either. The record carries the child's start time for exactly that
 * reason, and both the argv and the start time must agree.
 *
 * @module dsh-desktop/reap
 */

import { spawnSync } from 'node:child_process';
import { killTree } from './harness.mjs';

/** How far the live process's start time may differ from the recorded one. */
const CREATION_TOLERANCE_MS = 10_000;

/**
 * Read a live process's command line and creation time.
 *
 * Uses Windows PowerShell (present on every supported Windows) because Node has
 * no API for another process's command line. Returns null whenever the answer
 * cannot be established, and every caller treats null as "do not touch it".
 *
 * @param pid - the process to inspect.
 * @returns `{ commandLine, createdAt }`, or null when it is gone or unreadable.
 */
export function probeProcess(pid) {
  if (process.platform !== 'win32') return null;
  if (!Number.isInteger(pid) || pid <= 0) return null;

  const script =
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue; ` +
    `if ($null -eq $p) { 'null' } else { ` +
    `@{ commandLine = $p.CommandLine; createdAt = $p.CreationDate.ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress }`;

  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', windowsHide: true, timeout: 15_000 },
  );
  if (result.status !== 0 || typeof result.stdout !== 'string') return null;
  const text = result.stdout.trim();
  if (text === '' || text === 'null') return null;

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed.commandLine !== 'string') return null;
  const createdAt = Date.parse(parsed.createdAt);
  return {
    commandLine: parsed.commandLine,
    createdAt: Number.isNaN(createdAt) ? null : createdAt,
  };
}

/**
 * Decide whether a live process is the harness child described by a record.
 *
 * @param pid - the recorded pid.
 * @param record - the recorded child facts: `startedAt`, and the bin path it ran.
 * @param probe - the process inspector; injected for tests.
 * @returns a verdict naming which check failed, so a refusal can be logged.
 */
export function verifyStaleChild(pid, record, probe = probeProcess) {
  if (record === undefined || record === null) return { isOurs: false, reason: 'no record' };
  const live = probe(pid);
  if (live === null) return { isOurs: false, reason: 'process is gone' };

  if (typeof record.binPath !== 'string' || !live.commandLine.includes(record.binPath)) {
    return { isOurs: false, reason: 'command line does not name our dsh entry' };
  }
  if (!live.commandLine.includes('--profile')) {
    return { isOurs: false, reason: 'command line does not carry --profile' };
  }
  if (typeof record.startedAt !== 'number' || live.createdAt === null) {
    return { isOurs: false, reason: 'start time could not be compared' };
  }
  const drift = Math.abs(live.createdAt - record.startedAt);
  if (drift > CREATION_TOLERANCE_MS) {
    return { isOurs: false, reason: `start time differs by ${Math.round(drift / 1000)}s` };
  }
  return { isOurs: true, reason: 'argv and start time both match' };
}

/**
 * Terminate a harness child left over from a previous run, if there is one.
 *
 * @param record - the previous run's child record, or null.
 * @param log - sink for a one-line account of what happened.
 * @returns a short description of the outcome, for the log and the tests.
 */
export function reapStaleChild(record, log = () => {}) {
  if (record === null || record === undefined) return 'no previous child recorded';
  const pid = record.pid;
  if (!Number.isInteger(pid) || pid <= 0) return 'previous record has no usable pid';

  const verdict = verifyStaleChild(pid, record);
  if (!verdict.isOurs) {
    log(`not reaping pid ${pid}: ${verdict.reason}`);
    return `left pid ${pid} alone (${verdict.reason})`;
  }
  const result = killTree(pid);
  log(`reaped stale harness child pid=${pid} (taskkill status=${String(result.status)})`);
  return `reaped stale harness child pid=${pid}`;
}
