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
  });
  assert.deepEqual(config, {
    port: 3081,
    workspace: 'D:\\projects',
    restartLimit: 5,
    restartWindowMs: 30_000,
    bootTimeoutMs: 60_000,
    graceMs: 2000,
    closeToTray: true,
  });
});

test('port 0 is a valid value, not a missing one', () => {
  // Nullish-defaulting a port would silently turn "let the OS choose" into a
  // fixed port and reintroduce the collision this design avoids.
  assert.equal(normalizeConfig({ port: 0 }).port, 0);
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
