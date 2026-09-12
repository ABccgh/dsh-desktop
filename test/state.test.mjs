import assert from 'node:assert/strict';
import { test } from 'node:test';

import { normalizeState } from '../src/state.mjs';

test('an absent state file is simply empty', () => {
  const problems = [];
  assert.deepEqual(normalizeState(undefined, (p) => problems.push(p)), {});
  assert.deepEqual(problems, [], 'a missing file is normal, not a problem');
});

test('the value that made the app unstartable now yields an object', () => {
  // Regression: `state.json` holding a bare `null` used to throw during module
  // evaluation — before a window existed — because resolveWorkspace() reads
  // state.lastWorkspace at the top level.
  for (const raw of [null, [], 'nope', 42, true]) {
    const problems = [];
    const state = normalizeState(raw, (p) => problems.push(p));
    assert.deepEqual(state, {}, `${JSON.stringify(raw)} should normalise to {}`);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /not a JSON object/);
    // The exact dereferences that used to throw.
    assert.equal(state.lastWorkspace, undefined);
    assert.equal(state.window, undefined);
    assert.equal(state.child, undefined);
  }
});

test('a well-formed state survives unchanged', () => {
  const raw = {
    window: { x: 128, y: 24, width: 1280, height: 840, maximized: false },
    lastWorkspace: 'D:\\project',
    guiUrl: 'http://127.0.0.1:55555',
    child: { pid: 1234, startedAt: 1_700_000_000_000, binPath: 'C:\\dsh\\bin.js', cwd: 'D:\\project' },
  };
  assert.deepEqual(normalizeState(raw), raw);
});

test('window fields that are not what this app writes are dropped', () => {
  const problems = [];
  const state = normalizeState(
    { window: { x: 'left', y: 2, width: 1280, height: 860, maximized: 'yes', evil: 'rm -rf', __proto__: null } },
    (p) => problems.push(p),
  );
  assert.deepEqual(state.window, { y: 2, width: 1280, height: 860 });
  assert.equal(problems.length, 0, 'individual bad fields are dropped silently, not reported');
});

test('a window that is not an object is dropped with a note', () => {
  for (const window of ['nope', 42, [], true]) {
    const problems = [];
    const state = normalizeState({ window, lastWorkspace: 'D:\\x' }, (p) => problems.push(p));
    assert.equal(state.window, undefined);
    assert.equal(state.lastWorkspace, 'D:\\x', 'the rest of the state is kept');
    assert.match(problems[0], /state\.window is not an object/);
  }
});

test('string fields must be strings, and null stays as "no preference"', () => {
  const problems = [];
  const state = normalizeState({ lastWorkspace: 42, guiUrl: { a: 1 }, window: null }, (p) => problems.push(p));
  assert.equal(state.lastWorkspace, undefined);
  assert.equal(state.guiUrl, undefined);
  assert.equal(problems.length, 2);
  assert.deepEqual(normalizeState({ lastWorkspace: null }).lastWorkspace, null);
});

test('a child record without a usable pid is dropped, and null is kept', () => {
  const problems = [];
  assert.equal(normalizeState({ child: {} }, (p) => problems.push(p)).child, undefined);
  assert.equal(normalizeState({ child: { pid: '1234' } }).child, undefined);
  assert.equal(normalizeState({ child: { pid: -1 } }).child, undefined);
  assert.equal(normalizeState({ child: { pid: 0 } }).child, undefined);
  assert.equal(normalizeState({ child: [] }).child, undefined);
  assert.match(problems[0], /not a process record/);
  assert.equal(normalizeState({ child: null }).child, null, 'null means "no child recorded"');
  assert.deepEqual(normalizeState({ child: { pid: 5 } }).child, { pid: 5 });
});

test('unknown keys are preserved so a newer state file survives an older build', () => {
  const raw = { windows: [{ id: 1 }], children: [{ pid: 9 }], lastDshVersion: '0.1.5-rc.1', window: null };
  const state = normalizeState(raw);
  assert.deepEqual(state.windows, [{ id: 1 }]);
  assert.deepEqual(state.children, [{ pid: 9 }]);
  assert.equal(state.lastDshVersion, '0.1.5-rc.1');
});

test('the input object is never mutated', () => {
  const raw = { window: { x: 'bad', width: 1000, height: 700 }, lastWorkspace: 5 };
  const snapshot = JSON.stringify(raw);
  normalizeState(raw);
  assert.equal(JSON.stringify(raw), snapshot);
});
