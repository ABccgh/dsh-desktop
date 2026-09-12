/**
 * The support bundle, as text.
 *
 * A pure function on purpose: the thing it must never do — leak a launch token
 * into a file the user will paste into a chat — is exactly the thing that is
 * only checkable by feeding it a token and looking.
 *
 * @module dsh-desktop/diagnostics
 */

import { redactTokenLike, truncateForLog } from './url-line.mjs';

/** How many trailing lines of each log to include. */
const LOG_TAIL_LINES = 40;

/**
 * The last few lines of a log, bounded and redacted.
 *
 * @param text - the whole log file.
 * @param lines - how many trailing lines to keep.
 * @returns the tail, with each line shortened and redacted.
 */
export function logTail(text, lines = LOG_TAIL_LINES) {
  if (typeof text !== 'string' || text === '') return '(empty)';
  const all = text.split(/\r?\n/).filter((line) => line !== '');
  const tail = all.slice(Math.max(0, all.length - lines));
  return tail.map((line) => redactTokenLike(truncateForLog(line, 400))).join('\n');
}

/**
 * Build the diagnostics text.
 *
 * @param input - everything the bundle reports.
 * @param input.versions - `{ app, electron, node, dsh }`.
 * @param input.anchor - `{ dir, binPath }` of the harness installation, if known.
 * @param input.runtime - `{ userData, logDir, nodeExe, home }` of this shell.
 * @param input.windows - one entry per open window: `{ id, workspace, port, state }`.
 * @param input.config - the live settings.
 * @param input.state - the persisted state.
 * @param input.logs - `[{ name, text }]`, the newest last.
 * @returns the bundle as one string.
 */
export function buildDiagnostics(input) {
  const {
    versions = {},
    anchor = {},
    runtime = {},
    windows = [],
    config = {},
    state = {},
    logs = [],
  } = input ?? {};

  const lines = [];
  lines.push('DSH Desktop diagnostics');
  lines.push(`generated: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('## versions');
  for (const [key, value] of Object.entries(versions)) lines.push(`  ${key}: ${String(value)}`);
  lines.push('');
  lines.push('## harness installation');
  lines.push(`  directory: ${redactTokenLike(String(anchor.dir ?? 'unknown'))}`);
  lines.push(`  cli entry: ${redactTokenLike(String(anchor.binPath ?? 'unknown'))}`);
  lines.push('');
  lines.push('## this shell');
  for (const [key, value] of Object.entries(runtime)) lines.push(`  ${key}: ${redactTokenLike(String(value))}`);
  lines.push('');
  lines.push(`## windows (${windows.length})`);
  for (const window of windows) {
    lines.push(`  - workspace: ${redactTokenLike(String(window.workspace ?? 'unknown'))}`);
    lines.push(`    port: ${String(window.port ?? 'not ready')}`);
    lines.push(`    state: ${redactTokenLike(String(window.state ?? 'unknown'))}`);
  }
  lines.push('');
  lines.push('## settings');
  lines.push(redactTokenLike(JSON.stringify(config, null, 2).replace(/^/gm, '  ')));
  lines.push('');
  lines.push('## persisted state');
  // The state is written by this app and contains no token, but it is read back
  // from disk and this function has no way to know that — so it is redacted too.
  lines.push(redactTokenLike(JSON.stringify(state, null, 2).replace(/^/gm, '  ')));
  lines.push('');
  lines.push('## logs');
  if (logs.length === 0) lines.push('  (none)');
  for (const log of logs) {
    lines.push('');
    lines.push(`### ${String(log.name ?? 'unnamed')}`);
    for (const line of logTail(log.text).split('\n')) lines.push(`  ${line}`);
  }
  lines.push('');
  return lines.join('\n');
}
