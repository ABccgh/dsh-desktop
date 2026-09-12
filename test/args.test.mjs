import assert from 'node:assert/strict';
import { test } from 'node:test';

import { harnessArgs } from '../src/args.mjs';

test('the argv is exactly the documented shape', () => {
  // Asserted as a whole array on purpose: any extra token here reaches the
  // web app's own commander tree, where an -h/--help makes the web command
  // print help and never provide webStartup — leaving the app hung with no
  // error. A single unexpected token is a real defect, not a style issue.
  assert.deepEqual(harnessArgs(), ['--profile', 'web', '--port', '0', '--no-open']);
});

test('the default port is 0, so the child can never take the user port', () => {
  assert.equal(harnessArgs()[3], '0');
});

test('a fixed port is passed through as a decimal string', () => {
  assert.deepEqual(harnessArgs({ port: 3081 }), ['--profile', 'web', '--port', '3081', '--no-open']);
});

test('an invalid port is refused rather than passed on', () => {
  for (const port of [-1, 65536, 1.5, Number.NaN, '0', null]) {
    assert.throws(() => harnessArgs({ port }), /port must be an integer/, `should have refused ${String(port)}`);
  }
});

test('no argument can smuggle a help flag into the app arguments', () => {
  // The workspace is the child's cwd, never an argv token, so there is no path
  // by which user input reaches this array. This asserts the array stays
  // constant no matter what the caller passes alongside the port.
  const args = harnessArgs({ port: 0, workspace: 'D:\\somewhere', extra: ['-h', '--help'] });
  assert.deepEqual(args, ['--profile', 'web', '--port', '0', '--no-open']);
});
