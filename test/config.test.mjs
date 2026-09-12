import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_CONFIG, normalizeConfig } from '../src/config.mjs';

test('an absent config yields the defaults', () => {
  assert.deepEqual(normalizeConfig(undefined), DEFAULT_CONFIG);
  assert.deepEqual(normalizeConfig(null), DEFAULT_CONFIG);
});

test('a config that is not an object is reported and replaced', () => {
  const problems = [];
  assert.deepEqual(normalizeConfig([1, 2, 3], (p) => problems.push(p)), DEFAULT_CONFIG);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /not an object/);

  const stringProblems = [];
  assert.deepEqual(normalizeConfig('nope', (p) => stringProblems.push(p)), DEFAULT_CONFIG);
  assert.equal(stringProblems.length, 1);
  // `undefined` is the "no file" case and must stay silent.
  const silent = [];
  assert.deepEqual(normalizeConfig(undefined, (p) => silent.push(p)), DEFAULT_CONFIG);
  assert.equal(silent.length, 0);
});

test('valid values are kept', () => {
  const config = normalizeConfig({
    port: 3081,
    workspace: 'D:\\projects',
    restartLimit: 5,
    restartWindowMs: 30_000,
    bootTimeoutMs: 60_000,
    graceMs: 2000,
    closeToTray: true,
    globalHotkey: 'Control+Shift+D',
    notifyOnFailure: false,
    maxWindows: 2,
  });
  assert.deepEqual(config, {
    port: 3081,
    workspace: 'D:\\projects',
    restartLimit: 5,
    restartWindowMs: 30_000,
    bootTimeoutMs: 60_000,
    graceMs: 2000,
    closeToTray: true,
    globalHotkey: 'Control+Shift+D',
    notifyOnFailure: false,
    maxWindows: 2,
  });
});

test('the hotkey may be turned off with null, and refuses a blank string', () => {
  assert.equal(normalizeConfig({ globalHotkey: null }).globalHotkey, null);
  const problems = [];
  const config = normalizeConfig({ globalHotkey: '   ' }, (p) => problems.push(p));
  assert.equal(config.globalHotkey, DEFAULT_CONFIG.globalHotkey, 'blank falls back rather than disabling');
  assert.equal(problems.length, 1);
  assert.match(problems[0], /globalHotkey/);
});

test('maxWindows is bounded, and its bounds are inclusive', () => {
  assert.equal(normalizeConfig({ maxWindows: 1 }).maxWindows, 1);
  assert.equal(normalizeConfig({ maxWindows: 8 }).maxWindows, 8);
  assert.equal(normalizeConfig({ maxWindows: 9 }, () => {}).maxWindows, DEFAULT_CONFIG.maxWindows);
  assert.equal(normalizeConfig({ maxWindows: 0 }, () => {}).maxWindows, DEFAULT_CONFIG.maxWindows);
});

test('port 0 is a valid value, not a missing one', () => {
  // Nullish-defaulting a port would silently turn "let the OS choose" into a
  // fixed port and reintroduce the collision this design avoids.
  assert.equal(normalizeConfig({ port: 0 }).port, 0);
});

test('the boot timeout floor is above the measured boot time', () => {
  // Measured across nine runs: 8.67–10.20 s. The old floor of 5 s sat below
  // that, so the documented minimum made every launch time out — and the only
  // recovery was hand-editing a file whose path the app never reveals.
  const measuredWorstCase = 10_200;
  assert.ok(DEFAULT_CONFIG.bootTimeoutMs > measuredWorstCase * 2, 'the default leaves real headroom');
  assert.equal(normalizeConfig({ bootTimeoutMs: 30_000 }).bootTimeoutMs, 30_000, 'the floor itself is accepted');
  assert.equal(
    normalizeConfig({ bootTimeoutMs: 29_999 }, () => {}).bootTimeoutMs,
    DEFAULT_CONFIG.bootTimeoutMs,
    'one below the floor is refused',
  );
  assert.equal(
    normalizeConfig({ bootTimeoutMs: 5_000 }, () => {}).bootTimeoutMs,
    DEFAULT_CONFIG.bootTimeoutMs,
    'the old floor is now refused',
  );
});

test('each invalid value falls back to its default and says so', () => {
  const cases = [
    [{ port: 70_000 }, 'port'],
    [{ port: -1 }, 'port'],
    [{ port: 1.5 }, 'port'],
    [{ port: '3080' }, 'port'],
    [{ restartLimit: -1 }, 'restartLimit'],
    [{ restartWindowMs: 10 }, 'restartWindowMs'],
    [{ bootTimeoutMs: 100 }, 'bootTimeoutMs'],
    [{ graceMs: -5 }, 'graceMs'],
    [{ closeToTray: 'yes' }, 'closeToTray'],
    [{ workspace: 42 }, 'workspace'],
    [{ workspace: '   ' }, 'workspace'],
  ];
  for (const [raw, key] of cases) {
    const problems = [];
    const config = normalizeConfig(raw, (p) => problems.push(p));
    assert.deepEqual(config, DEFAULT_CONFIG, `should have fallen back for ${JSON.stringify(raw)}`);
    assert.equal(problems.length, 1, `should have reported one problem for ${JSON.stringify(raw)}`);
    assert.match(problems[0], new RegExp(key), `problem should name ${key}`);
  }
});

test('an explicit null workspace is accepted as "no preference"', () => {
  const problems = [];
  const config = normalizeConfig({ workspace: null }, (p) => problems.push(p));
  assert.equal(config.workspace, null);
  assert.equal(problems.length, 0);
});

test('unknown keys are dropped rather than carried', () => {
  const config = normalizeConfig({ port: 0, somethingElse: 'x' });
  assert.equal(Object.hasOwn(config, 'somethingElse'), false);
});
