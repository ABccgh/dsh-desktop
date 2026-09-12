import assert from 'node:assert/strict';
import { test } from 'node:test';

import { reapStaleChild, verifyStaleChild } from '../src/reap.mjs';

const BIN = 'C:\\Users\\x\\AppData\\Local\\npm-cache\\_npx\\hash\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js';
const STARTED = 1_760_000_000_000;

/**
 * Build a fake process inspector for one scenario.
 * @param commandLine - the live process's command line, or null for "gone".
 * @param createdAt - its creation time, or null when unreadable.
 * @returns a probe function.
 */
const probeOf = (commandLine, createdAt) => () => (commandLine === null ? null : { commandLine, createdAt });

test('no record means nothing to reap', () => {
  assert.deepEqual(verifyStaleChild(1234, null), { isOurs: false, reason: 'no record' });
  assert.equal(reapStaleChild(null), 'no previous child recorded');
});

test('a record without a usable pid is refused', () => {
  assert.equal(reapStaleChild({ pid: 'x' }), 'previous record has no usable pid');
  assert.equal(reapStaleChild({ pid: -1 }), 'previous record has no usable pid');
});

test('a process that is already gone is not ours', () => {
  const verdict = verifyStaleChild(1234, { pid: 1234, startedAt: STARTED, binPath: BIN }, probeOf(null, null));
  assert.equal(verdict.isOurs, false);
  assert.match(verdict.reason, /gone/);
});

test('our own child is recognised by argv and start time together', () => {
  const live = `"C:\\Program Files\\nodejs\\node.exe" "${BIN}" --profile web --port 0 --no-open`;
  const verdict = verifyStaleChild(1234, { pid: 1234, startedAt: STARTED, binPath: BIN }, probeOf(live, STARTED));
  assert.deepEqual(verdict, { isOurs: true, reason: 'argv and start time both match' });
});

test('the user\'s own long-running dsh is NEVER reaped, even though its argv matches', () => {
  // This is the dangerous case: the user's `dsh web` on 3080 runs the same CLI
  // entry with the same --profile flag. Only the start time separates it from a
  // child of ours, which is why the record carries one.
  const userInstance = `"C:\\Program Files\\nodejs\\node.exe" "${BIN}" --profile web --port 3080`;
  const threeHoursEarlier = STARTED - 3 * 60 * 60 * 1000;
  const verdict = verifyStaleChild(9420, { pid: 9420, startedAt: STARTED, binPath: BIN }, probeOf(userInstance, threeHoursEarlier));
  assert.equal(verdict.isOurs, false);
  assert.match(verdict.reason, /start time differs/);
});

test('a different DSH installation is not ours', () => {
  const otherInstall = 'D:\\other\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js';
  const live = `"node.exe" "${otherInstall}" --profile web --port 0 --no-open`;
  const verdict = verifyStaleChild(1234, { pid: 1234, startedAt: STARTED, binPath: BIN }, probeOf(live, STARTED));
  assert.equal(verdict.isOurs, false);
  assert.match(verdict.reason, /does not name our dsh entry/);
});

test('an unrelated process is not ours', () => {
  const verdict = verifyStaleChild(1234, { pid: 1234, startedAt: STARTED, binPath: BIN }, probeOf('"explorer.exe"', STARTED));
  assert.equal(verdict.isOurs, false);
});

test('a matching argv without --profile is refused', () => {
  const live = `"node.exe" "${BIN}" --port 0`;
  const verdict = verifyStaleChild(1234, { pid: 1234, startedAt: STARTED, binPath: BIN }, probeOf(live, STARTED));
  assert.equal(verdict.isOurs, false);
  assert.match(verdict.reason, /--profile/);
});

test('a record or a process without a comparable start time is refused', () => {
  const live = `"node.exe" "${BIN}" --profile web`;
  assert.match(verifyStaleChild(1, { pid: 1, binPath: BIN }, probeOf(live, STARTED)).reason, /could not be compared/);
  assert.match(verifyStaleChild(1, { pid: 1, startedAt: STARTED, binPath: BIN }, probeOf(live, null)).reason, /could not be compared/);
});

test('the start-time tolerance is inclusive at 10s and refused just beyond it', () => {
  const live = `"node.exe" "${BIN}" --profile web`;
  const record = { pid: 1, startedAt: STARTED, binPath: BIN };
  assert.equal(verifyStaleChild(1, record, probeOf(live, STARTED + 10_000)).isOurs, true);
  assert.equal(verifyStaleChild(1, record, probeOf(live, STARTED + 10_001)).isOurs, false);
  assert.equal(verifyStaleChild(1, record, probeOf(live, STARTED - 10_000)).isOurs, true);
});

test('a refusal is reported in words, so a non-reap can be read out of the log', () => {
  const notes = [];
  const outcome = reapStaleChild({ pid: 9420, startedAt: STARTED, binPath: BIN }, (line) => notes.push(line));
  assert.match(outcome, /^left pid 9420 alone/);
  assert.equal(notes.length, 1);
});
