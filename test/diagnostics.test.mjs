import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildDiagnostics, logTail } from '../src/diagnostics.mjs';

const TOKEN = '1ji-J-S4fdy4iHxUzRnbPvBMQIQWzdcINrD32ZjAUzg';

test('a launch token never survives into the bundle, from any source', () => {
  // The whole reason this is a pure function: the one thing it must never do is
  // put a live credential into a file the user will paste somewhere.
  const bundle = buildDiagnostics({
    versions: { app: '0.1.0' },
    anchor: { dir: 'C:\\dsh', binPath: `C:\\dsh\\bin.js --token ${TOKEN}` },
    runtime: { logDir: `C:\\logs\\?token=${TOKEN}` },
    windows: [{ workspace: `C:\\w\\?token=${TOKEN}`, port: 1234, state: `ready ?token=${TOKEN}` }],
    config: { port: 0, note: `?token=${TOKEN}` },
    state: { guiUrl: `http://127.0.0.1:1/?token=${TOKEN}` },
    logs: [{ name: 'app.log', text: `dsh web: http://127.0.0.1:1/?token=${TOKEN}` }],
  });
  assert.equal(bundle.includes(TOKEN), false, 'the token must appear nowhere in the bundle');
  assert.ok(bundle.includes('token=***'), 'and it must be visibly redacted, not silently dropped');
});

test('the bundle reports every section it promises', () => {
  const bundle = buildDiagnostics({
    versions: { app: '9.9.9', electron: '44.3.0', node: '26.8.1', dsh: '0.1.5-rc.1' },
    anchor: { dir: 'C:\\dsh', binPath: 'C:\\dsh\\lib\\bin.js' },
    runtime: { userData: 'C:\\ud', logDir: 'C:\\ud\\logs' },
    windows: [{ workspace: 'D:\\a', port: 5555, state: 'mounted' }],
    config: { port: 0 },
    state: { windows: [] },
    logs: [{ name: 'app-1.log', text: 'line one\nline two' }],
  });
  for (const needle of [
    'DSH Desktop diagnostics',
    'app: 9.9.9',
    'electron: 44.3.0',
    'node: 26.8.1',
    'dsh: 0.1.5-rc.1',
    'directory: C:\\dsh',
    'userData: C:\\ud',
    '## windows (1)',
    'workspace: D:\\a',
    'port: 5555',
    '### app-1.log',
    'line two',
  ]) {
    assert.ok(bundle.includes(needle), `missing: ${needle}`);
  }
});

test('an empty or absent input still produces a readable bundle', () => {
  const empty = buildDiagnostics();
  assert.ok(empty.includes('DSH Desktop diagnostics'));
  assert.ok(empty.includes('## windows (0)'));
  assert.ok(empty.includes('(none)'));
  assert.ok(empty.includes('unknown'), 'absent values are named, not left blank');
});

test('log tails are bounded and each line is shortened', () => {
  const long = Array.from({ length: 200 }, (_, index) => `line ${String(index)}`);
  const tail = logTail(long.join('\n'));
  assert.equal(tail.split('\n').length, 40, 'exactly the requested number of trailing lines');
  assert.ok(tail.startsWith('line 160'), 'and it is the TAIL, not the head');
  assert.ok(tail.endsWith('line 199'));

  const wide = logTail(`x${'y'.repeat(2000)}`);
  assert.ok(wide.length <= 400, `a single long line is shortened, got ${String(wide.length)}`);

  assert.equal(logTail(''), '(empty)');
  assert.equal(logTail(undefined), '(empty)');
  assert.equal(logTail('one'), 'one');
  assert.equal(logTail('a\n\n\nb').split('\n').length, 2, 'blank lines are dropped');
});

test('the bundle is plain text a person can read', () => {
  const bundle = buildDiagnostics({ versions: { app: '1' } });
  assert.equal(bundle.includes('\u0000'), false);
  assert.ok(bundle.endsWith('\n'));
});
