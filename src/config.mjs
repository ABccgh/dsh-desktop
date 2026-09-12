/**
 * The shell's own settings, validated rather than trusted.
 *
 * @module dsh-desktop/config
 */

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
});

/**
 * Coerce arbitrary parsed JSON into a usable config.
 *
 * Unknown keys are dropped and invalid values fall back to their default, so a
 * hand-edited config can never make the shell unstartable. Each drop is
 * reported through `onProblem` rather than silently.
 *
 * @param raw - the parsed config file, or undefined when it does not exist.
 * @param onProblem - called with a human-readable note for each rejected value.
 * @returns a complete config.
 */
export function normalizeConfig(raw, onProblem = () => {}) {
  const config = { ...DEFAULT_CONFIG };
  if (raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    if (raw !== undefined) onProblem('config is not an object; using defaults');
    return config;
  }

  const integer = (key, min, max) => {
    const value = raw[key];
    if (value === undefined) return;
    if (!Number.isInteger(value) || value < min || value > max) {
      onProblem(`config.${key} must be an integer in ${min}..${max}, got ${JSON.stringify(value)}; using ${config[key]}`);
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

  const workspace = raw.workspace;
  if (workspace !== undefined && workspace !== null) {
    if (typeof workspace === 'string' && workspace.trim() !== '') config.workspace = workspace;
    else onProblem(`config.workspace must be a non-empty string or null, got ${JSON.stringify(workspace)}; using null`);
  }

  const closeToTray = raw.closeToTray;
  if (closeToTray !== undefined) {
    if (typeof closeToTray === 'boolean') config.closeToTray = closeToTray;
    else onProblem(`config.closeToTray must be a boolean, got ${JSON.stringify(closeToTray)}; using ${config.closeToTray}`);
  }

  return config;
}
