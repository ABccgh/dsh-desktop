/**
 * The shell's own settings, validated rather than trusted.
 *
 * @module dsh-desktop/config
 */

import { LANGUAGES, createTranslator } from './i18n.mjs';

/**
 * The English table, used when a caller injects no translator.
 *
 * `normalizeConfig` is called before the language is chosen — its notes are what
 * the startup log is made of — so the default has to render rather than fail.
 */
const englishMessages = createTranslator('en');

/**
 * Render one rejected-value note as text.
 *
 * The note is structured so the same rejection can be read in any language; this
 * is the only place it becomes a sentence. A key the field's own name is used
 * for is deliberate: it is the name in `config.json`, which is where a user who
 * wants to fix it has to look.
 *
 * @param problem - the note from `normalizeConfig`.
 * @param t - optional translator; defaults to English.
 * @returns the sentence to show or log.
 */
export function problemMessage(problem, t) {
  const say = typeof t === 'function' ? t : englishMessages;
  const params = {
    key: problem.key,
    kind: problem.kind,
    min: problem.min,
    max: problem.max,
    allowed: Array.isArray(problem.allowed) ? problem.allowed.join(', ') : problem.allowed,
    got: JSON.stringify(problem.got),
    using: JSON.stringify(problem.using),
  };
  // `kind` is a closed set chosen inside this module, so an unrecognised one
  // means the note and this function have drifted apart; saying so beats
  // indexing a missing message and showing `undefined`.
  return say(`config.problem.${problem.kind}`, params);
}

/**
 * Defaults, and the accepted range of each field.
 *
 * `port: 0` is the default on purpose: the OS assigns a free port, so the shell
 * can never collide with the user's own `dsh web` (3080 on this machine) and
 * needs no port scan. A fixed port is available for anyone who wants a stable
 * URL, at the cost of a possible collision.
 */
export const DEFAULT_CONFIG = Object.freeze({
  /** Listen port for the child; 0 lets the OS pick a free one. */
  port: 0,
  /** Workspace directory the child runs in; null means "last used, else home". */
  workspace: null,
  /** Interface language: `auto` follows the system, otherwise `zh` or `en`. */
  language: 'auto',
  /** Unexpected child exits tolerated inside the window before giving up. */
  restartLimit: 3,
  /** The window those exits are counted over. */
  restartWindowMs: 60_000,
  /** How long to wait for the readiness line before treating the boot as failed. */
  bootTimeoutMs: 120_000,
  /** Grace period for a graceful child exit before forcing the tree down. */
  graceMs: 8_000,
  /** Closing the window hides to the tray instead of quitting. */
  closeToTray: false,
  /** Global shortcut that shows or hides the window; null disables it. */
  globalHotkey: 'Control+Alt+D',
  /** Tell the user through the tray when the harness gives up. */
  notifyOnFailure: true,
  /** How many workspace windows may be open at once. Each one is a whole harness. */
  maxWindows: 4,
});

/**
 * Coerce arbitrary parsed JSON into a usable config.
 *
 * Unknown keys are dropped and invalid values fall back to their default, so a
 * hand-edited config can never make the shell unstartable. Each drop is reported
 * through `onProblem` as a **structured** note — the field, the constraint, and
 * the values involved — rather than a finished sentence, because that sentence
 * has to come out in the reader's language and this module cannot know which one
 * that is. See `problemMessage` for the one place a note becomes text.
 *
 * @param raw - the parsed config file, or undefined when it does not exist.
 * @param onProblem - called with one note per rejected value.
 * @returns a complete config.
 */
export function normalizeConfig(raw, onProblem = () => {}) {
  const config = { ...DEFAULT_CONFIG };
  if (raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    if (raw !== undefined) onProblem({ key: 'config', kind: 'notObject' });
    return config;
  }

  const integer = (key, min, max) => {
    const value = raw[key];
    if (value === undefined) return;
    if (!Number.isInteger(value) || value < min || value > max) {
      onProblem({ key, kind: 'integer', min, max, got: value, using: config[key] });
      return;
    }
    config[key] = value;
  };

  integer('port', 0, 65535);
  integer('restartLimit', 0, 100);
  integer('restartWindowMs', 1000, 3_600_000);
  // The floor is 30 s because a harness boot was measured at 8.7–10.2 s over
  // nine runs on this machine, and the previous floor of 5 s sat below that:
  // setting the documented minimum made every launch time out, with recovery
  // only by hand-editing the file that the app never shows a path to.
  integer('bootTimeoutMs', 30_000, 1_800_000);
  integer('graceMs', 0, 120_000);
  integer('maxWindows', 1, 8);

  const workspace = raw.workspace;
  if (workspace !== undefined && workspace !== null) {
    if (typeof workspace === 'string' && workspace.trim() !== '') config.workspace = workspace;
    else onProblem({ key: 'workspace', kind: 'nonEmptyString', got: workspace, using: null });
  }

  const closeToTray = raw.closeToTray;
  if (closeToTray !== undefined) {
    if (typeof closeToTray === 'boolean') config.closeToTray = closeToTray;
    else onProblem({ key: 'closeToTray', kind: 'boolean', got: closeToTray, using: config.closeToTray });
  }

  // An unknown language is refused rather than kept: it would resolve to `auto`
  // deep inside the translator, where the reason for the fallback is invisible.
  const language = raw.language;
  if (language !== undefined) {
    if (LANGUAGES.includes(language)) config.language = language;
    else onProblem({ key: 'language', kind: 'oneOf', allowed: LANGUAGES, got: language, using: config.language });
  }

  const notifyOnFailure = raw.notifyOnFailure;
  if (notifyOnFailure !== undefined) {
    if (typeof notifyOnFailure === 'boolean') config.notifyOnFailure = notifyOnFailure;
    else onProblem({ key: 'notifyOnFailure', kind: 'boolean', got: notifyOnFailure, using: config.notifyOnFailure });
  }

  // Null disables the hotkey; a string is passed to Electron as-is, and a
  // registration failure is reported at startup rather than refused here —
  // whether an accelerator is available is not knowable until the app runs.
  const globalHotkey = raw.globalHotkey;
  if (globalHotkey !== undefined && globalHotkey !== null) {
    if (typeof globalHotkey === 'string' && globalHotkey.trim() !== '') config.globalHotkey = globalHotkey.trim();
    else onProblem({ key: 'globalHotkey', kind: 'nonEmptyString', got: globalHotkey, using: config.globalHotkey });
  } else if (globalHotkey === null) {
    config.globalHotkey = null;
  }

  return config;
}
