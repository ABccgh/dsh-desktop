/**
 * Making the state file safe to use.
 *
 * `readJson` returns whatever the file parsed to, and every key in the state
 * file is read during module evaluation — before a window exists to report a
 * problem and before the menu that would reveal the file's path is built. So a
 * single bare `null` in this file made the application permanently unstartable
 * with no message anywhere. Object-or-nothing is the only safe shape here.
 *
 * Unknown keys are preserved, so a state file written by a newer build survives
 * a run of an older one instead of being silently stripped.
 *
 * @module dsh-desktop/state
 */

/**
 * Coerce arbitrary parsed JSON into a usable state object.
 *
 * @param raw - the parsed state file, or anything at all.
 * @param onProblem - called with a human-readable note for each rejected value.
 * @returns a plain object safe to read keys from.
 */
export function normalizeState(raw, onProblem = () => {}) {
  if (raw === undefined) return {};
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    onProblem(`state is not a JSON object (${JSON.stringify(raw)}); ignoring it`);
    return {};
  }

  const state = { ...raw };

  const drop = (key, why) => {
    delete state[key];
    onProblem(`state.${key} ${why}`);
  };

  if (state.window !== undefined) {
    const window = state.window;
    if (window === null) {
      // "Nothing saved yet" — legitimate, and not worth a note.
      delete state.window;
    } else if (typeof window !== 'object' || Array.isArray(window)) {
      drop('window', 'is not an object');
    } else {
      // Keep only the fields this app writes, so a hand edit cannot smuggle a
      // value into the BrowserWindow constructor.
      const clean = {};
      for (const key of ['x', 'y', 'width', 'height']) {
        if (Number.isInteger(window[key])) clean[key] = window[key];
      }
      if (typeof window.maximized === 'boolean') clean.maximized = window.maximized;
      state.window = clean;
    }
  }

  for (const key of ['lastWorkspace', 'guiUrl']) {
    if (state[key] !== undefined && state[key] !== null && typeof state[key] !== 'string') {
      drop(key, 'is not a string');
    }
  }

  if (state.child !== undefined && state.child !== null) {
    const child = state.child;
    if (typeof child !== 'object' || Array.isArray(child) || !Number.isInteger(child.pid) || child.pid <= 0) {
      drop('child', 'is not a process record with a usable pid');
    }
  }

  return state;
}
