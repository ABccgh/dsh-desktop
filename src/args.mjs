/**
 * The child's argv, in one place so it can be asserted exactly.
 *
 * Shape: `<node> <dsh bin> --profile web --port <n> --no-open`
 *
 * Why each token:
 * - `--profile web` — the launcher flag form of `dsh web` (`@deepseek-ai/dsh/lib/bin.js:100-104`
 *   makes `web` an alias of `--profile web`). Spelled out rather than aliased so the process
 *   command line identifies itself to an operator reading `Get-CimInstance Win32_Process`.
 * - `--port <n>` — default 0, which `@deepseek-ai/dsh-web-app/lib/startup.js:22` documents as
 *   "pass 0 to let the OS pick a free one", and `dsh-host-webserver/lib/index.js:162-163`
 *   resolves to the real bound port. Port 0 also guarantees the child can never collide with
 *   the user's own long-running `dsh web` on 3080.
 * - `--no-open` — suppresses the default-browser handoff (`dsh-web-app/lib/index.js:174`).
 *   This window is the browser.
 *
 * Everything after `--profile web` reaches the app's own commander tree
 * (`dsh/lib/bin.js:10-21` documents the handoff; `dsh-cmdline/lib/index.js:92-98`
 * parses it), which is why no other token may be added casually: an `-h`/`--help`
 * anywhere here makes the web command print help and never provide `webStartup`,
 * leaving the webserver row unmounted and the app hanging with no error
 * (`dsh-web-app/lib/startup.js:38-49`). No user-influenced string is ever placed
 * in this array — the workspace is passed as the child's `cwd`, not as an argument.
 *
 * @module dsh-desktop/args
 */

/** The profile the desktop shell boots. The user's own, with their plugins. */
export const DSH_PROFILE = 'web';

/**
 * Build the harness child's argument list.
 * @param options - the listen port; 0 (the default) means "let the OS choose".
 * @returns the argv slice after the dsh bin path.
 */
export function harnessArgs({ port = 0 } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`dsh-desktop: port must be an integer in 0..65535, got ${String(port)}`);
  }
  return ['--profile', DSH_PROFILE, '--port', String(port), '--no-open'];
}
