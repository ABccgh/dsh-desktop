import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { DEFAULT_CONFIG, normalizeConfig, problemMessage } from '../src/config.mjs';
import { createTranslator } from '../src/i18n.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('an absent config yields the defaults', () => {
  assert.deepEqual(normalizeConfig(undefined), DEFAULT_CONFIG);
  assert.deepEqual(normalizeConfig(null), DEFAULT_CONFIG);
});

test('a config that is not an object is reported and replaced', () => {
  const problems = [];
  assert.deepEqual(normalizeConfig([1, 2, 3], (p) => problems.push(p)), DEFAULT_CONFIG);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].kind, 'notObject');
  // Notes are structured, not sentences: the sentence has to come out in the
  // reader's language and this module cannot know which one that is.
  assert.match(problemMessage(problems[0]), /not an object/);
  assert.match(problemMessage(problems[0], createTranslator('zh')), /不是一个对象/);

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
    language: 'zh',
    restartLimit: 5,
    restartWindowMs: 30_000,
    bootTimeoutMs: 60_000,
    graceMs: 2000,
    closeToTray: true,
    globalHotkey: 'Control+Shift+D',
    notifyOnFailure: false,
  });
  assert.deepEqual(config, {
    port: 3081,
    workspace: 'D:\\projects',
    language: 'zh',
    restartLimit: 5,
    restartWindowMs: 30_000,
    bootTimeoutMs: 60_000,
    graceMs: 2000,
    closeToTray: true,
    globalHotkey: 'Control+Shift+D',
    notifyOnFailure: false,
  });
});

test('a key nothing reads is not a setting: maxWindows was removed', () => {
  // It shipped validated, rendered in the settings form, and read by nothing —
  // a visible control that did nothing, which the project's own notes call worse
  // than an absent one. It is now not even a default, and a config that still
  // carries it is simply a config with an unknown key.
  assert.equal(Object.hasOwn(DEFAULT_CONFIG, 'maxWindows'), false);
  const problems = [];
  const config = normalizeConfig({ maxWindows: 8 }, (p) => problems.push(p));
  assert.equal(problems.length, 0, 'an unknown key is dropped silently, which is the house rule');
  assert.equal(Object.hasOwn(config, 'maxWindows'), false);
});

test('the language accepts exactly the three choices, and refuses the rest', () => {
  for (const choice of ['auto', 'zh', 'en']) {
    const problems = [];
    const config = normalizeConfig({ language: choice }, (p) => problems.push(p));
    assert.equal(config.language, choice);
    assert.equal(problems.length, 0, `${choice} is a real choice and must not be reported`);
  }
  // A hand-edited config cannot make the lookup miss: an unknown id is refused
  // here, where the reason is visible, rather than falling through to `auto`
  // deep inside the translator.
  for (const bad of ['ja', 'ZH', '', 7, null, true, ['zh']]) {
    const problems = [];
    const config = normalizeConfig({ language: bad, port: 1234 }, (p) => problems.push(p));
    assert.equal(config.language, DEFAULT_CONFIG.language, `${JSON.stringify(bad)} should fall back`);
    assert.equal(problems.length, 1, `${JSON.stringify(bad)} should be reported`);
    assert.match(problemMessage(problems[0]), /language/);
    assert.equal(config.port, 1234, 'one bad field must not discard the others');
  }
});

test('the hotkey may be turned off with null, and refuses a blank string', () => {
  assert.equal(normalizeConfig({ globalHotkey: null }).globalHotkey, null);
  const problems = [];
  const config = normalizeConfig({ globalHotkey: '   ' }, (p) => problems.push(p));
  assert.equal(config.globalHotkey, DEFAULT_CONFIG.globalHotkey, 'blank falls back rather than disabling');
  assert.equal(problems.length, 1);
  assert.match(problemMessage(problems[0]), /globalHotkey/);
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
    assert.match(problemMessage(problems[0]), new RegExp(key), `problem should name ${key}`);
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

test('every config key is read by something, not just declared', () => {
  // `maxWindows` and `notifyOnFailure` both shipped as validated settings that
  // no code read: a control the user can see, change, and be misled by. This is
  // the check that would have caught them. It is deliberately a source scan and
  // not a runtime probe, because the defect is the *absence* of a read and there
  // is nothing to probe.
  /**
   * A source file with comments and string literals removed.
   *
   * Necessary, and measured as necessary: the first version of this guard kept
   * passing after the single read of `notifyOnFailure` was deleted, because the
   * key was also named in a log message and in a doc comment. A mention in prose
   * is not a read, and a check that cannot tell them apart guards nothing.
   *
   * @param text - the file's contents.
   * @returns only the code.
   */
  function withoutProse(text) {
    return text
      .replace(/\/\*[\s\S]*?\*\//gu, ' ')
      .replace(/^\s*\/\/.*$/gmu, ' ')
      .replace(/'[^'\n]*'/gu, "''")
      .replace(/"[^"\n]*"/gu, '""')
      .replace(/`[^`]*`/gu, '``');
  }

  const sources = [];
  for (const dir of ['src', 'bin']) {
    for (const name of readdirSync(join(ROOT, dir))) {
      if (/\.(mjs|js|cjs)$/u.test(name)) sources.push(join(ROOT, dir, name));
    }
  }
  assert.ok(sources.length >= 15, `the scan must cover the shell, it found ${sources.length} files`);
  const code = new Map(
    sources.map((file) => [file, withoutProse(readFileSync(file, 'utf8'))]),
  );

  for (const key of Object.keys(DEFAULT_CONFIG)) {
    // `config.<key>` in code — the shape every reader here uses. Deliberately
    // not matching a bare mention: the settings form names every field it
    // renders, and a key that only the form mentions is exactly the dead control
    // this is looking for.
    //
    // Written with `new RegExp('...')`, where a backslash must be escaped once,
    // and NOT with a regex literal: `\\b` in a literal is a backslash followed
    // by the letter b, so an earlier version of this guard matched nothing and
    // passed forever.
    const read = new RegExp(`config\\.${key}(?![\\w$])`, 'u');
    const readers = [...code].filter(([file, text]) => {
      // `config.mjs` is where the key is *declared*, so it always "reads" it in
      // `raw.<key>`. Excluding it has to test the real path shape: the first
      // version compared against `\config.mjs` while the map held absolute
      // paths, so the exclusion never applied and the guard passed on the
      // material it was supposed to ignore.
      if (file === join(ROOT, 'src', 'config.mjs')) return false;
      return read.test(text);
    });
    assert.ok(
      readers.length > 0,
      `config.${key} is declared and validated but nothing reads it — wire it up or remove it`,
    );
  }
});
