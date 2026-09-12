/**
 * Finding and reaping a harness child left behind by a previous run.
 *
 * This is the only place in the shell that terminates a process it did not
 * spawn, so identity is verified before anything is killed. A PID alone is not
 * identity: Windows reuses them.
 *
 * The check is deliberately a *description match* rather than two substrings
 * and a time window, because the process this must never kill is the user's own
 * `dsh web`, which runs the same CLI entry file. The description is everything
 * the shell recorded when it spawned the child — the entry path, the Node
 * binary, the parent it was spawned from, every argv token, and the start time —
 * and every recorded field must agree. Two facts are worth keeping in view:
 *
 * - **The parent check compares against the RECORDED parent, not this process.**
 *   A stale child's parent is the *previous* run of this shell, which is dead by
 *   definition; requiring `parentPid === process.pid` would refuse every real
 *   reap while looking like a strengthening. The recorded value is what makes
 *   parentage usable as evidence.
 * - **The argv is checked as recorded, not as a constant.** This shell launches
 *   `--port 0` by default, but the port is configurable, so hard-coding `--port 0`
 *   here would silently stop reaping for anyone who pinned a port.
 *
 * @module dsh-desktop/reap
 */

import { spawnSync } from 'node:child_process';
import { killTree } from './harness.mjs';

/** How far the live process's start time may differ from the recorded one. */
const CREATION_TOLERANCE_MS = 10_000;

/**
 * Read a live process's command line, creation time, and parent.
 *
 * Uses Windows PowerShell (present on every supported Windows) because Node has
 * no API for another process's command line. Returns null whenever the answer
 * cannot be established, and every caller treats null as "do not touch it".
 *
 * @param pid - the process to inspect.
 * @returns `{ commandLine, createdAt, parentPid }`, or null when it is gone or unreadable.
 */
export function probeProcess(pid) {
  if (process.platform !== 'win32') return null;
  if (!Number.isInteger(pid) || pid <= 0) return null;

  const script =
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue; ` +
    `if ($null -eq $p) { 'null' } else { ` +
    `@{ commandLine = $p.CommandLine; createdAt = $p.CreationDate.ToUniversalTime().ToString('o'); ` +
    `parentPid = $p.ParentProcessId } | ConvertTo-Json -Compress }`;

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
    parentPid: Number.isInteger(parsed.parentPid) ? parsed.parentPid : null,
  };
}

/**
 * Decide whether a live process matches the record of a child this shell spawned.
 *
 * @param pid - the recorded pid.
 * @param record - the recorded child facts; see the fields written by `main.js`.
 * @param probe - the process inspector; injected so tests never touch a real process.
 * @returns a verdict naming which check failed, so a refusal can be read from the log.
 */
export function verifyStaleChild(pid, record, probe = probeProcess) {
  if (record === undefined || record === null) return { isOurs: false, reason: 'no record' };
  const live = probe(pid);
  if (live === null) return { isOurs: false, reason: 'process is gone' };

  if (typeof record.binPath !== 'string' || !live.commandLine.includes(record.binPath)) {
    return { isOurs: false, reason: 'command line does not name our dsh entry' };
  }
  if (typeof record.nodeExe === 'string' && record.nodeExe !== '') {
    if (!live.commandLine.toLowerCase().includes(record.nodeExe.toLowerCase())) {
      return { isOurs: false, reason: 'command line does not run our node' };
    }
  }
  if (Array.isArray(record.args) && record.args.length > 0) {
    if (!record.args.every((token) => typeof token === 'string')) {
      return { isOurs: false, reason: 'recorded argv is malformed' };
    }
    // Matched as one contiguous run, not token by token: `--port 3080` contains
    // the recorded token `0` and `--port`, so a per-token substring test accepts
    // a process carrying a different port. Caught by this module's own suite.
    // The run is safe to match this way because no token this shell passes can
    // contain a space, so Node joins them with single spaces verbatim.
    if (!live.commandLine.includes(record.args.join(' '))) {
      return { isOurs: false, reason: `command line does not carry our argv (${JSON.stringify(record.args.join(' '))})` };
    }
  }
  // Parentage: only meaningful when the record carries it AND the probe could
  // read it. A recorded parent that does not match means this process was not
  // started by the run that wrote the record.
  if (Number.isInteger(record.parentPid) && record.parentPid > 0 && live.parentPid !== null) {
    if (live.parentPid !== record.parentPid) {
      return { isOurs: false, reason: `parent pid ${live.parentPid} is not the recorded ${record.parentPid}` };
    }
  }
  if (typeof record.startedAt !== 'number' || live.createdAt === null) {
    return { isOurs: false, reason: 'start time could not be compared' };
  }
  const drift = Math.abs(live.createdAt - record.startedAt);
  if (drift > CREATION_TOLERANCE_MS) {
    return { isOurs: false, reason: `start time differs by ${Math.round(drift / 1000)}s` };
  }
  return { isOurs: true, reason: 'every recorded field matches' };
}

/**
 * Terminate a harness child left over from a previous run, if there is one.
 *
 * Returns a structured result rather than a sentence, so the caller decides what
 * to do with the record instead of pattern-matching on prose. That matters:
 * a refused reap must leave the record in place for the next attempt.
 *
 * @param record - the previous run's child record, or null.
 * @param log - sink for a one-line account of what happened.
 * @param deps - `{ probe, kill }` overrides. Tests must pass a probe: the default
 *   inspector runs a real PowerShell query and the default kill is a real
 *   `taskkill /T /F`, so a test calling this without them can terminate a live
 *   process whose pid happens to be in the record.
 * @returns `{ outcome: 'none' | 'no-pid' | 'gone' | 'refused' | 'reaped', pid, reason }`.
 */
export function reapStaleChild(record, log = () => {}, deps = {}) {
  const probe = deps.probe ?? probeProcess;
  const kill = deps.kill ?? killTree;

  if (record === null || record === undefined) {
    return { outcome: 'none', pid: null, reason: 'no previous child recorded' };
  }
  const pid = record.pid;
  if (!Number.isInteger(pid) || pid <= 0) {
    return { outcome: 'no-pid', pid: null, reason: 'previous record has no usable pid' };
  }

  const verdict = verifyStaleChild(pid, record, probe);
  if (verdict.isOurs !== true) {
    const gone = verdict.reason === 'process is gone';
    log(`not reaping pid ${pid}: ${verdict.reason}`);
    return { outcome: gone ? 'gone' : 'refused', pid, reason: verdict.reason };
  }

  const result = kill(pid);
  log(`reaped stale harness child pid=${pid} (taskkill status=${String(result.status)})`);
  return { outcome: 'reaped', pid, reason: `taskkill status=${String(result.status)}` };
}
