import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import { createTranslator } from '../src/i18n.mjs';
import { INSTALL_MESSAGE_KEYS, NODE_MESSAGE_KEY, resolveInstallAnchor, resolveNodeExe, workspaceFromArgv } from '../src/paths.mjs';

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

test('a missing installation is reported through the injectable translator', () => {
  // Without a translator the message is the English one — the unit test above
  // depends on it, and so does any caller that forgets to inject one.
  const missing = join('C:\\definitely-not-a-dsh-home', 'x');
  assert.throws(
    () => resolveInstallAnchor(missing),
    (error) => /DSH installation not found/.test(error.message) && error.message.includes('install.notFound') === false,
  );

  // With one, the same failure speaks the reader's language. This is the whole
  // reason these messages are keys rather than sentences: the startup path puts
  // one on the loading page, which a Chinese shell renders in Chinese.
  const t = (key, params) => `${key}>>${params.link}`;
  assert.throws(
    () => resolveInstallAnchor(missing, t),
    (error) => error.message.startsWith(`${INSTALL_MESSAGE_KEYS.notFound}>>`) && error.message.endsWith(missing) === false && error.message.includes(missing),
    'the translated message must still name the junction it looked for',
  );
});

test('a PATH with no node names the searched executable through the translator', () => {
  const t = (key, params) => `${key}>>${params.executable}|${params.count}|${params.plural}`;
  const expected = (count, plural) => `${NODE_MESSAGE_KEY}>>node.exe|${count}|${plural}`;
  assert.throws(
    () => resolveNodeExe({ PATH: 'C:\\Windows' }, t),
    (error) => error.message === expected(1, 'y') || error.message === `${NODE_MESSAGE_KEY}>>node|1|y`,
  );
  assert.throws(
    () => resolveNodeExe({ PATH: 'C:\\Windows;C:\\Windows\\System32' }, t),
    (error) => error.message === expected(2, 'ies') || error.message === `${NODE_MESSAGE_KEY}>>node|2|ies`,
    'the plural value changes with the count, which is what English needs it for',
  );
  // The real translators render it, so the key is not merely a symbol.
  assert.throws(() => resolveNodeExe({ PATH: 'C:\\Windows' }, createTranslator('en')), /1 directory/);
  assert.throws(() => resolveNodeExe({ PATH: 'C:\\Windows;C:\\Windows\\System32' }, createTranslator('en')), /2 directories/);
  assert.throws(() => resolveNodeExe({ PATH: 'C:\\Windows' }, createTranslator('zh')), /Node\.js 找不到|PATH/);
});
