import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveNodeExe, workspaceFromArgv } from '../src/paths.mjs';

/** A fake filesystem: only the named paths are directories. */
const dirs = (...existing) => ({ isDirectory: (candidate) => existing.includes(candidate) });

test('a relative argument is never a workspace', () => {
  // Electron's own argv carries the app path, which is `.` under `npm start`.
  // Treating it as a workspace moved the harness to the app's own directory.
  assert.equal(workspaceFromArgv(['.'], dirs('.')), null);
  assert.equal(workspaceFromArgv(['--allow-file-access-from-files', '--source-app-id', '.'], dirs('.')), null);
  assert.equal(workspaceFromArgv(['relative\\dir'], dirs('relative\\dir')), null);
});

test('an absolute directory argument is the workspace', () => {
  assert.equal(workspaceFromArgv(['D:\\project'], dirs('D:\\project')), 'D:\\project');
  assert.equal(workspaceFromArgv(['--x', 'D:\\project'], dirs('D:\\project')), 'D:\\project');
});

test('the first existing absolute directory wins', () => {
  assert.equal(workspaceFromArgv(['D:\\missing', 'D:\\project'], dirs('D:\\project')), 'D:\\project');
  assert.equal(workspaceFromArgv(['D:\\a', 'D:\\b'], dirs('D:\\a', 'D:\\b')), 'D:\\a');
});

test('an absolute path that is not a directory is ignored', () => {
  assert.equal(workspaceFromArgv(['D:\\a-file.txt'], dirs()), null);
  assert.equal(workspaceFromArgv([], dirs()), null);
  assert.equal(workspaceFromArgv(undefined, dirs()), null);
  assert.equal(workspaceFromArgv('D:\\project', dirs('D:\\project')), null);
});

test('an explicit --workspace is honoured, and a bad one is refused rather than skipped', () => {
  assert.equal(workspaceFromArgv(['--workspace', 'D:\\project'], dirs('D:\\project')), 'D:\\project');
  // Refused, and deliberately NOT falling through to the other argument: a
  // mistyped flag must not switch the workspace to something never named.
  assert.equal(workspaceFromArgv(['--workspace', 'D:\\typo', 'D:\\project'], dirs('D:\\project')), null);
  assert.equal(workspaceFromArgv(['--workspace'], dirs()), null);
  assert.equal(workspaceFromArgv(['--workspace', ''], dirs()), null);
});

test('the Node override is honoured only when it exists', () => {
  assert.throws(() => resolveNodeExe({ DSH_NODE: 'C:\\definitely\\not\\here\\node.exe' }), /which does not exist/);
  const real = resolveNodeExe({ PATH: process.env.PATH });
  assert.match(real, /node(\.exe)?$/i, 'a real PATH resolves to a real node');
});

test('no Node anywhere on PATH is a named failure, not a crash', () => {
  // The message is the whole value here: it names the executable searched for
  // and the directories looked in, so "the app shows an error" is actionable.
  assert.throws(() => resolveNodeExe({ PATH: 'C:\\Windows' }), /Node\.js was not found on PATH.*1 directory/s);
  assert.throws(() => resolveNodeExe({ PATH: '' }), /Node\.js was not found on PATH.*0 directories/s);
  assert.throws(() => resolveNodeExe({}), /Node\.js was not found on PATH/);
});
