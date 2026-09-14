/**
 * The interface language, asserted rather than trusted.
 *
 * The load-bearing test here is the keyboard grep: it reads the two modules that
 * render text and fails when either dictionary is missing a key they use. Without
 * it, a new English sentence reaches the screen as its own key in Chinese — a
 * failure that is invisible to every other check in this suite.
 *
 * @module dsh-desktop/test/i18n
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  APP_NAME,
  FALLBACK_LANGUAGE,
  LANGUAGES,
  MESSAGE_IDS,
  MESSAGES,
  chromiumLanguage,
  createTranslator,
  detectSystemLanguage,
  htmlLanguage,
  languageOf,
  messagesFor,
} from '../src/i18n.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(HERE, '..', 'src');

/** The two dictionaries, keyed by the language ids this shell ships. */
const DICTS = ['zh', 'en'];

/**
 * Every message key a source file actually renders.
 *
 * Deliberately reads the shipped module rather than a copy: a copy would go
 * stale exactly when it mattered.
 *
 * @param file - an absolute module path.
 * @returns the set of keys used in `t('…')` calls.
 */
function keysUsedIn(file) {
  const text = readFileSync(file, 'utf8');
  const found = new Set();
  for (const match of text.matchAll(/\bt\('([a-z][A-Za-z0-9.]*)'/gu)) found.add(match[1]);
  return found;
}

/**
 * The `{name}` placeholders in a message.
 * @param template - the message text.
 * @returns the placeholder names, sorted.
 */
function placeholders(template) {
  return [...template.matchAll(/\{(\w+)\}/gu)].map((match) => match[1]).sort();
}

/**
 * Every `t('key', { … })` call in a source file, with the parameter names its
 * call site supplies.
 *
 * This is what makes the placeholder check honest: it compares a message's needs
 * against what the caller actually passes, instead of against a hand-kept list
 * that drifts the moment someone adds a message.
 *
 * @param file - an absolute module path.
 * @returns a map of key to the union of parameter names supplied for it.
 */
function callSitesIn(file) {
  const text = readFileSync(file, 'utf8');
  const sites = new Map();
  // The parameter body contains parentheses — `String(code)` and
  // `String(signal)` are the measured cases — so it is matched as a balanced run
  // rather than up to the first `)`. One level of nesting is enough for every
  // call site here, and the "did the grep see anything" assertion below guards
  // against the pattern silently matching less.
  const call = /\bt\('([a-z][A-Za-z0-9.]*)'((?:\s*,\s*(?:[^()]|\([^()]*\))*)?)\)/gu;
  // `{ reason, count }` and `{ code: String(code) }` are both in use, so both a
  // shorthand and a keyed property count as "the caller passes this".
  const property = /([A-Za-z_$][\w$]*)\s*:|\b([A-Za-z_$][\w$]*)\b(?!\s*[.(])/gu;
  for (const match of text.matchAll(call)) {
    const names = new Set(sites.get(match[1]) ?? []);
    for (const found of match[2].matchAll(property)) {
      const name = found[1] ?? found[2];
      if (name !== undefined && name !== 'true' && name !== 'false' && name !== 'null') names.add(name);
    }
    sites.set(match[1], names);
  }
  return sites;
}

test('the language list is the three settings a user can choose', () => {
  assert.deepEqual([...LANGUAGES], ['auto', 'zh', 'en']);
});

test('auto follows the first system language this shell ships', () => {
  // The rule the web GUI uses: primary subtag match, in the user's own order.
  assert.equal(detectSystemLanguage(['zh-CN', 'zh-Hans-CN']), 'zh');
  assert.equal(detectSystemLanguage(['zh-Hans-CN']), 'zh');
  assert.equal(detectSystemLanguage(['zh-TW']), 'zh');
  assert.equal(detectSystemLanguage(['en-GB']), 'en');
  assert.equal(detectSystemLanguage(['fr-FR', 'zh-CN']), 'zh', 'an unsupported language keeps looking');
  assert.equal(detectSystemLanguage(['zh-CN', 'en-US']), 'zh', 'the user order decides, not the preference');
  assert.equal(detectSystemLanguage(['de-DE']), 'en', 'nothing supported falls back to English');
});

test('a system probe that fails or is empty never throws', () => {
  for (const input of [undefined, null, [], [''], [42], 'zh-CN', {}]) {
    assert.doesNotThrow(() => detectSystemLanguage(input));
    assert.equal(detectSystemLanguage(input), 'en');
  }
});

test('an explicit choice resolves; auto and anything unknown follow the system', () => {
  assert.equal(languageOf('zh', 'en'), 'zh');
  assert.equal(languageOf('en', 'zh'), 'en');
  assert.equal(languageOf('auto', 'zh'), 'zh');
  assert.equal(languageOf('ja', 'zh'), 'zh', 'a hand-edited config cannot make the lookup miss');
  assert.equal(languageOf(undefined, 'en'), 'en');
});

test('Chromium is only prompted for an explicit choice', () => {
  assert.equal(chromiumLanguage('auto', 'zh'), null, 'auto must leave the system locale alone');
  assert.equal(chromiumLanguage('zh', 'zh'), 'zh-CN');
  assert.equal(chromiumLanguage('en', 'zh'), 'en-US');
  assert.equal(chromiumLanguage('ja', 'zh'), null);
  assert.equal(htmlLanguage('zh'), 'zh-CN');
  assert.equal(htmlLanguage('en'), 'en');
});

test('both dictionaries are complete and agree on every key', () => {
  for (const language of DICTS) {
    const table = MESSAGES[language];
    assert.ok(table, `missing the ${language} dictionary`);
    assert.deepEqual(
      Object.keys(table).sort(),
      [...MESSAGE_IDS].sort(),
      `the ${language} dictionary does not match the id list exactly`,
    );
  }
  assert.deepEqual(
    Object.keys(MESSAGES.zh).sort(),
    Object.keys(MESSAGES.en).sort(),
    'a key present in one language renders as the key itself in the other',
  );
});

test('every message is complete, and every placeholder is one a caller supplies', () => {
  // Not "identical placeholders": English needs `{plural}` for "director{y|ies}"
  // and Chinese has no plural to agree with, so that key is legitimately absent.
  // What must hold is that no message needs a value its call site never passes.
  const supplied = new Map();
  for (const file of ['main.js', 'harness.mjs', 'paths.mjs']) {
    for (const [key, names] of callSitesIn(join(SOURCE, file))) {
      supplied.set(key, new Set([...(supplied.get(key) ?? []), ...names]));
    }
  }
  // paths.mjs renders through its own helper rather than `t`, so its one message
  // is listed here from the values `say()` is actually handed.
  supplied.set('install.notFound', new Set(['link']));
  supplied.set('install.noManifest', new Set(['dir', 'link']));
  supplied.set('install.badManifest', new Set(['dir', 'message']));
  supplied.set('install.noBin', new Set(['manifest']));
  supplied.set('install.binMissing', new Set(['binPath']));
  supplied.set('node.notFound', new Set(['executable', 'count', 'plural']));
  supplied.set('node.dshNodeMissing', new Set(['override']));
  // `--version`'s two lines are rendered in the CLI section, before `t` exists
  // under that name; both take the versions Electron carries.
  supplied.set('version.bundled', new Set(['electron', 'node', 'chrome']));
  supplied.set('version.nodeNote', new Set());

  // The config notes are rendered by `problemMessage` in `config.mjs`, from the
  // parameters `normalizeConfig` puts on the note.
  for (const kind of ['notObject', 'integer', 'boolean', 'nonEmptyString', 'oneOf']) {
    supplied.set(
      `config.problem.${kind}`,
      new Set(['key', 'kind', 'min', 'max', 'allowed', 'got', 'using']),
    );
  }

  // settings.html has its own small `t()`, so its call sites are read from the
  // page. A key the page only reaches through `data-i18n` carries no values by
  // construction, which is why only the script's calls are listed here.
  const pageKeys = new Set(
    [...readFileSync(join(SOURCE, 'settings.html'), 'utf8').matchAll(/\bt\('([a-z][A-Za-z0-9.]*)'/gu)].map(
      (match) => match[1],
    ),
  );
  assert.ok(pageKeys.size > 5, 'the page grep must see the status messages it is checking');
  for (const key of pageKeys) supplied.set(key, new Set(['problems', 'workspace', 'path', 'message']));

  for (const id of MESSAGE_IDS) {
    const zh = MESSAGES.zh[id];
    const en = MESSAGES.en[id];
    assert.equal(typeof zh, 'string', `zh.${id} is not a string`);
    assert.equal(typeof en, 'string', `en.${id} is not a string`);
    assert.notEqual(zh.trim(), '', `zh.${id} is empty`);
    assert.notEqual(en.trim(), '', `en.${id} is empty`);

    const needs = new Set([...placeholders(zh), ...placeholders(en)]);
    if (needs.size === 0) continue;
    const has = supplied.get(id);
    assert.ok(has, `${id} takes values but no call site in src/ supplies any`);
    for (const name of needs) {
      assert.ok(has.has(name), `${id} needs {${name}}, which its call site does not pass`);
    }
  }
});

test('the pre-harness page keeps a failure message when a dictionary arrives', () => {
  // Two defects this catches, both measured on the real page before these lines
  // existed: the apply hook wrote the dictionary's "starting" copy over `#status`
  // (turning a boot timeout into an eternally starting page), and the failure
  // hint stayed English because the dictionary never reached this window.
  const page = readFileSync(join(SOURCE, 'loading.html'), 'utf8');
  const apply = /window\.__dshApplyStrings = function[\s\S]*?\n      \};/u.exec(page);
  assert.ok(apply !== null, 'the apply hook must still be there to check');
  assert.match(apply[0], /node\.id === 'status'\)\s*continue/u, 'the status node must be skipped');
  assert.match(apply[0], /renderStatus\(\)/u, 'the status must be re-rendered after a switch');
  // And the hint has to read a translated key when one is available.
  assert.match(page, /strings\['status\.hint'\]/u);
});

test('the window title is written by the shell, not read from a static <title>', () => {
  // A page's own `<title>` wins over the BrowserWindow's `title:` (measured on
  // Electron 44.3.0: a window created with one title showed the document's), so a
  // static English `<title>` is a title bar that stays English in Chinese mode —
  // and, once `page-title-updated` is prevented, one that only the shell can
  // change. Both halves are asserted here because either alone is wrong.
  const main = readFileSync(join(SOURCE, 'main.js'), 'utf8');
  const guard = /win\.on\('page-title-updated', \(event\) => event\.preventDefault\(\)\);/u;
  assert.match(main, guard, 'the page must not be allowed to own the window title');
  assert.match(main, /win\.setTitle\(t\('window\.title'\)\)/u, 'the shell must set it in the chosen language');
  assert.match(main, /_title: t\('window\.title'\)/u, 'the pushed payload carries the title');
});

test('both pages are given a dictionary before anything is shown', () => {
  // `pushStrings` is what fills `strings`; without a call on the main window the
  // pre-harness page renders its English fallbacks in Chinese mode.
  const main = readFileSync(join(SOURCE, 'main.js'), 'utf8');
  const didFinish = /win\.webContents\.on\('did-finish-load'[\s\S]*?\n  \}\);/u.exec(main);
  assert.ok(didFinish !== null, 'the main window must still have a did-finish-load handler');
  const push = didFinish[0].indexOf('pushStrings()');
  const status = didFinish[0].indexOf('pushStatus()');
  assert.ok(push !== -1, 'the main window must be given the dictionary');
  assert.ok(push < status, 'the dictionary must arrive before the first status is pushed');
});

test('the stale launch-token cookies are swept before the window exists', (t) => {
  // The jar grows by one every launch — the GUI names its cookie after the launch
  // authority, which changes with the port — and at 70 of them the token exchange
  // answered HTTP 431, so the window mounted nothing and said nothing. The sweep
  // is what holds that off; the ladder checks the symptom, this checks the call.
  const main = readFileSync(join(SOURCE, 'main.js'), 'utf8');
  const ready = /app\.whenReady\(\)\.then\(async \(\) => \{[\s\S]*?\n  \}\)/u.exec(main);
  assert.ok(ready !== null, 'the startup callback must still be there to check');
  const sweep = ready[0].indexOf('await clearStaleAuthCookies()');
  const window = ready[0].indexOf('createWindow()');
  assert.ok(sweep !== -1, 'the cookies must be swept at startup');
  assert.ok(sweep < window, 'the sweep must happen before a window can hold a cookie of its own');
  // And it must only touch this app's own auth cookies.
  const sweepBody = /async function clearStaleAuthCookies\(\)[\s\S]*?\n\}/u.exec(main);
  assert.ok(sweepBody !== null, 'the sweep must still be a function');
  assert.match(sweepBody[0], /AUTH_COOKIE_PREFIX/u);
  assert.match(sweepBody[0], /session\.fromPartition\(PARTITION\)/u);
  assert.match(sweepBody[0], /127\.0\.0\.1/u);
});

test('the plural placeholder is the only one a language may omit', () => {
  const english = placeholders(MESSAGES.en['node.notFound']);
  const chinese = placeholders(MESSAGES.zh['node.notFound']);
  assert.deepEqual(english, ['count', 'executable', 'plural']);
  assert.deepEqual(chinese, ['count', 'executable'], 'Chinese has no plural form to agree with');
  const t = createTranslator('zh');
  // Passing the extra value is harmless: the template simply has no slot for it.
  assert.equal(t('node.notFound', { executable: 'node', count: 3, plural: 'ies' }).includes('{'), false);
  assert.equal(createTranslator('en')('node.notFound', { executable: 'node', count: 3, plural: 'ies' }).includes('directories'), true);
});

test('every message key a rendered surface uses exists in both dictionaries', () => {
  const rendered = new Set([...keysUsedIn(join(SOURCE, 'main.js')), ...keysUsedIn(join(SOURCE, 'harness.mjs'))]);
  // A vacuous pass is the failure mode of a grep this simple: prove it saw the
  // calls before trusting what it did not find.
  assert.ok(rendered.size > 40, `expected the grep to find the t() calls, it found ${rendered.size}`);
  assert.ok(rendered.has('menu.file'), 'the grep must see the menu it is checking');
  assert.ok(rendered.has('harness.gaveUp'), 'the grep must see the supervisor it is checking');

  const missing = [...rendered].filter((key) => !MESSAGE_IDS.includes(key)).sort();
  assert.deepEqual(missing, [], `these keys are rendered but not translated: ${missing.join(', ')}`);
});

test('no user-facing call site still passes an English sentence', () => {
  // The key grep above cannot see a string that never went through `t()` — which
  // is exactly how the 20-second watchdog kept showing English on a Chinese page
  // until this test was written. These calls take copy the user reads, so a
  // literal belongs there only if it is not copy at all: a version number and the
  // product's own name, which are the same in every language. Both are listed
  // below, so anything else that reaches these calls is a failure rather than a
  // silent omission.
  const NOT_COPY = new Set([
    '`${APP_NAME} ${app.getVersion()}`',
    APP_NAME,
  ]);
  /**
   * The value a named property is given, as written.
   *
   * Only the value itself is inspected: an earlier version took the first string
   * literal on the line, so `showStatus(t('status.couldNotStart', { message:
   * error.message }))` was reported as a hard-coded message on the strength of a
   * string that belonged to a different argument.
   *
   * @param code - one line of source, comments stripped.
   * @param name - the property, e.g. `message`.
   * @returns the first token after the colon, or null when the name is absent.
   */
  function valueOf(code, name) {
    const found = new RegExp(`\\b${name}:\\s*([^,}\\n]*)`, 'u').exec(code);
    return found === null ? null : found[1].trim();
  }

  const surfaces = [
    ['showStatus(', /showStatus\(/u],
    ['message:', /\bmessage:/u],
    ['title:', /\btitle:/u],
  ];
  // The shell's log and its diagnostics bundle stay English on purpose, so their
  // modules are not scanned here.
  const seen = new Map(surfaces.map(([name]) => [name, 0]));
  seen.set('dialog detail:', 0);
  for (const file of ['main.js', 'harness.mjs']) {
    const text = readFileSync(join(SOURCE, file), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const code = line.split('//')[0];
      for (const [name, pattern] of surfaces) {
        if (!pattern.test(code)) continue;
        seen.set(name, (seen.get(name) ?? 0) + 1);
        const value = name === 'showStatus(' ? code.slice(code.indexOf('showStatus(') + 'showStatus('.length) : valueOf(code, name);
        if (value === null || value === '') continue;
        assert.ok(
          !/^['"`]/u.test(value) || NOT_COPY.has(value.replace(/,\s*$/u, '')),
          `${file} passes a literal to ${name} — route it through t(): ${line.trim()}`,
        );
      }
    }

    // A dialog's options object spans lines and `detail:` is its last field, so
    // this one is matched across the whole object rather than line by line.
    // `detail:` elsewhere — `killTree` returns one — is diagnostic output for the
    // log and never reaches a user, which is why the pattern starts at the call.
    for (const dialog of text.matchAll(/showMessageBox\([\s\S]{0,600}?\}/gu)) {
      seen.set('dialog detail:', (seen.get('dialog detail:') ?? 0) + 1);
      for (const key of ['message', 'detail', 'title']) {
        const value = valueOf(dialog[0], key);
        assert.ok(
          value === null || !/^['"`]/u.test(value) || NOT_COPY.has(value),
          `${file} passes a literal to a dialog's ${key} — route it through t(): ${value}`,
        );
      }
    }
  }
  // Every pattern must match something on its own: a typo in one of them would
  // otherwise turn it into a check that can no longer fail.
  for (const [name, count] of seen) {
    assert.ok(count > 0, `the ${name} pattern matched nothing, so it guards nothing`);
  }
});

test('the translator substitutes every value it is given', () => {
  const t = createTranslator('zh');
  assert.equal(t('harness.bootTimeout', { seconds: 30 }).includes('30'), true);
  assert.equal(t('harness.bootTimeout', { seconds: 30 }).includes('{seconds}'), false);
  assert.equal(t('status.restartingAttempt', { attempt: 2 }).includes('2'), true);
  // A message with no placeholders ignores a params object rather than throwing.
  assert.equal(typeof t('menu.file', { unused: 1 }), 'string');
});

test('a value missing from a params object throws instead of rendering a literal', () => {
  const t = createTranslator('en');
  assert.throws(() => t('status.restartingWorkspace', {}), /needs a value for \{workspace\}/u);
  // No params at all is the "render me the template" case, and the braces stay
  // visible on the screen rather than being silently emptied.
  assert.equal(t('status.restartingWorkspace').includes('{workspace}'), true);
});

test('English is the fallback for an unknown language and an unknown key', () => {
  assert.deepEqual(messagesFor('ja'), MESSAGES[FALLBACK_LANGUAGE]);
  assert.deepEqual(messagesFor(undefined), MESSAGES[FALLBACK_LANGUAGE]);
  const t = createTranslator('ja');
  assert.equal(t('menu.quit'), MESSAGES.en['menu.quit']);
  // A key nothing defines renders as itself, which is visible rather than silent.
  assert.equal(t('not.a.real.key'), 'not.a.real.key');
});

test('an injected table overrides the built-in one', () => {
  const t = createTranslator('zh', { 'menu.quit': 'bye {who}' });
  assert.equal(t('menu.quit', { who: 'now' }), 'bye now');
  // Keys the override does not carry still come from the built-in English table.
  assert.equal(t('menu.file'), MESSAGES.en['menu.file']);
});
