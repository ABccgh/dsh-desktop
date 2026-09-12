import assert from 'node:assert/strict';
import { test } from 'node:test';

import { reapStaleChild, verifyStaleChild } from '../src/reap.mjs';

/**
 * Every test in this file injects a probe. The default probe spawns a real
 * PowerShell query and the default kill is a real `taskkill /PID /T /F`, so a
 * test that omitted the stub could terminate whatever process holds the pid in
 * its fixture. The previous version of this file did exactly that — it called
 * `reapStaleChild` with no probe against a hard-coded pid — and passed only
 * because that pid no longer existed on this machine.
 */
const NODE = 'D:\\Program Files\\nodejs\\node.exe';
const BIN = 'C:\\Users\\x\\.dsh\\profiles\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js';
const ARGS = ['--profile', 'web', '--port', '0', '--no-open'];
const STARTED = 1_760_000_000_000;
const PARENT = 4242;

/** The command line this shell actually produces. */
const OUR_COMMAND = `"${NODE}" "${BIN}" ${ARGS.join(' ')}`;

/**
 * Build a fake process inspector for one scenario.
 * @param commandLine - the live process's command line, or null for "gone".
 * @param createdAt - its creation time; defaults to the recorded one.
 * @param parentPid - its parent; defaults to the recorded one.
 * @returns a probe function.
 */
const probeOf = (commandLine, createdAt = STARTED, parentPid = PARENT) => () =>
  commandLine === null ? null : { commandLine, createdAt, parentPid };

/** A complete, matching record. */
const record = (patch = {}) => ({
  pid: 1234,
  startedAt: STARTED,
  binPath: BIN,
  nodeExe: NODE,
  parentPid: PARENT,
  args: ARGS,
  cwd: 'D:\\project',
  ...patch,
});

test('the exact command line this shell spawns is recognised', () => {
  assert.deepEqual(verifyStaleChild(1234, record(), probeOf(OUR_COMMAND)), {
    isOurs: true,
    reason: 'every recorded field matches',
  });
});

test('the user\'s own `dsh web`, in the form this machine actually runs it, is refused', () => {
  // Measured on this machine: the user's long-running GUI runs the npx shim,
  // which spells the same file through `.bin\..\` and uses the `web` alias.
  const userGui = `"node"   "C:\\Users\\x\\AppData\\Local\\npm-cache\\_npx\\hash\\node_modules\\.bin\\\\..\\@deepseek-ai\\dsh\\lib\\bin.js" web`;
  const verdict = verifyStaleChild(18772, record({ pid: 18772 }), probeOf(userGui, STARTED, 999));
  assert.equal(verdict.isOurs, false);
  assert.match(verdict.reason, /does not name our dsh entry/);
});

test('an argv that matches ours but a different parent is refused', () => {
  // The case that the recorded parent exists to catch: something else ran the
  // same command, from the same description, at the same time.
  const verdict = verifyStaleChild(1234, record(), probeOf(OUR_COMMAND, STARTED, PARENT + 1));
  assert.equal(verdict.isOurs, false);
  assert.match(verdict.reason, /not the recorded/);
});

test('a different node binary is refused even with our entry and argv', () => {
  const otherNode = `"C:\\other\\node.exe" "${BIN}" ${ARGS.join(' ')}`;
  const verdict = verifyStaleChild(1234, record(), probeOf(otherNode));
  assert.equal(verdict.isOurs, false);
  assert.match(verdict.reason, /does not run our node/);
});

test('a command line missing any recorded argv token is refused', () => {
  for (const [why, command] of [
    ['the alias instead of --profile', `"${NODE}" "${BIN}" web --port 0 --no-open`],
    ['a different port', `"${NODE}" "${BIN}" --profile web --port 3080 --no-open`],
    ['the browser handoff left on', `"${NODE}" "${BIN}" --profile web --port 0`],
  ]) {
    const verdict = verifyStaleChild(1234, record(), probeOf(command));
    assert.equal(verdict.isOurs, false, `should have refused: ${why}`);
    assert.match(verdict.reason, /does not carry our argv/);
  }
});

test('a pinned port is reaped too, because the argv is read from the record', () => {
  // Hard-coding `--port 0` here would silently stop reaping for anyone who set
  // a fixed port; the record is what decides.
  const pinned = ['--profile', 'web', '--port', '3081', '--no-open'];
  const command = `"${NODE}" "${BIN}" ${pinned.join(' ')}`;
  assert.equal(verifyStaleChild(1234, record({ args: pinned }), probeOf(command)).isOurs, true);
});

test('optional record fields are tolerated when absent', () => {
  // Records written by an older build carry only pid/startedAt/binPath.
  const old = { pid: 1234, startedAt: STARTED, binPath: BIN };
  assert.equal(verifyStaleChild(1234, old, probeOf(`"node" "${BIN}" --profile web`)).isOurs, true);
});

test('start time is still required, and its tolerance is inclusive', () => {
  assert.equal(verifyStaleChild(1234, record(), probeOf(OUR_COMMAND, STARTED + 10_000)).isOurs, true);
  assert.equal(verifyStaleChild(1234, record(), probeOf(OUR_COMMAND, STARTED + 10_001)).isOurs, false);
  assert.equal(verifyStaleChild(1234, record(), probeOf(OUR_COMMAND, STARTED - 10_000)).isOurs, true);
  const threeHoursEarlier = STARTED - 3 * 60 * 60 * 1000;
  const verdict = verifyStaleChild(1234, record(), probeOf(OUR_COMMAND, threeHoursEarlier));
  assert.equal(verdict.isOurs, false);
  assert.match(verdict.reason, /start time differs/);
});

test('an unreadable start time or a missing record refuses rather than guesses', () => {
  assert.match(verifyStaleChild(1, record(), probeOf(OUR_COMMAND, null)).reason, /could not be compared/);
  assert.match(verifyStaleChild(1, record({ startedAt: undefined }), probeOf(OUR_COMMAND)).reason, /could not be compared/);
  assert.match(verifyStaleChild(1, null, probeOf(OUR_COMMAND)).reason, /no record/);
});

test('a process that is already gone is reported as gone, not as a refusal', () => {
  const verdict = verifyStaleChild(1234, record(), probeOf(null));
  assert.equal(verdict.isOurs, false);
  assert.match(verdict.reason, /gone/);
});

test('reapStaleChild classifies every outcome without touching a process', () => {
  const killed = [];
  const deps = { probe: probeOf(OUR_COMMAND), kill: (pid) => (killed.push(pid), { status: 0 }) };

  assert.deepEqual(reapStaleChild(null, () => {}, deps).outcome, 'none');
  assert.deepEqual(reapStaleChild({ pid: 'x' }, () => {}, deps).outcome, 'no-pid');
  assert.deepEqual(reapStaleChild({ pid: -1 }, () => {}, deps).outcome, 'no-pid');
  assert.equal(reapStaleChild(record(), () => {}, deps).outcome, 'reaped');
  assert.deepEqual(killed, [1234]);

  const gone = reapStaleChild(record(), () => {}, { probe: probeOf(null), kill: () => assert.fail('must not kill') });
  assert.equal(gone.outcome, 'gone');

  const refused = reapStaleChild(record(), () => {}, {
    probe: probeOf(OUR_COMMAND, STARTED, PARENT + 1),
    kill: () => assert.fail('must not kill'),
  });
  assert.equal(refused.outcome, 'refused');
});

test('a refusal is reported in words and never kills', () => {
  const notes = [];
  const outcome = reapStaleChild(record(), (line) => notes.push(line), {
    probe: probeOf(`"node" "${BIN}" web`),
    kill: () => assert.fail('must not kill a non-matching process'),
  });
  assert.equal(outcome.outcome, 'refused');
  assert.equal(notes.length, 1);
  assert.match(notes[0], /not reaping pid 1234/);
});
