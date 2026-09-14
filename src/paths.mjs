/**
 * Where everything lives. Pure lookups, no side effects, so the failure of each
 * one can name the exact path it wanted.
 *
 * @module dsh-desktop/paths
 */

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';

import { createTranslator } from './i18n.mjs';

/**
 * A translator with the English table, used when a caller injects none.
 *
 * These failures are shown to the user (the startup path puts the message on
 * the loading page), which is why they are translated at all — and why the
 * default stays English rather than empty.
 */
const defaultMessage = createTranslator('en');

/**
 * Translate a message for a caller that may not have supplied a translator.
 * @param t - the injected translator, if any.
 * @param key - the message key.
 * @param params - its replacements.
 * @returns the rendered message.
 */
function say(t, key, params) {
  return (typeof t === 'function' ? t : defaultMessage)(key, params);
}

/**
 * The message keys this module can raise, so a caller can match one without
 * copying an English sentence and a test can assert the wording landed.
 */
export const INSTALL_MESSAGE_KEYS = Object.freeze({
  notFound: 'install.notFound',
  noManifest: 'install.noManifest',
  badManifest: 'install.badManifest',
  noBin: 'install.noBin',
  binMissing: 'install.binMissing',
});

/** The one key `resolveNodeExe` can raise. */
export const NODE_MESSAGE_KEY = 'node.notFound';

/** The `DSH_NODE` override pointing at nothing. */
export const DSH_NODE_MESSAGE_KEY = 'node.dshNodeMissing';

/**
 * The Harness home.
 *
 * `DSH_HOME` is read from the environment only. It is deliberately not read
 * from a `.env`: `@deepseek-ai/dsh-app-boot/lib/index.js:1026-1029` refuses
 * `DSH_*` from any environment file, so honouring one here would let the shell
 * disagree with the harness it launches.
 *
 * @param env - an environment mapping; defaults to this process's.
 * @returns the absolute Harness-home path.
 */
export function resolveDshHome(env = process.env) {
  const fromEnv = env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv;
  return join(homedir(), '.dsh');
}

/**
 * The dsh installation to run, discovered the same way the harness itself
 * maintains it.
 *
 * `$DSH_HOME/profiles/node_modules/@deepseek-ai/dsh` is a junction into the
 * real installation (measured on this machine: it points at the npx checkout).
 * It is resolved through `realpathSync` on every launch because the target is
 * not stable — an npx cache prune or a new release candidate gives a different
 * directory — which is what keeps this shell working across DSH upgrades
 * instead of pinning a hash directory.
 *
 * @param dshHome - the Harness home.
 * @param t - optional translator; defaults to the English table.
 * @returns the resolved installation: directory, version, and the CLI entry path.
 * @throws when the junction, the manifest, its `bin.dsh`, or that file is absent.
 */
export function resolveInstallAnchor(dshHome, t) {
  const link = join(dshHome, 'profiles', 'node_modules', '@deepseek-ai', 'dsh');
  if (!existsSync(link)) {
    throw new Error(say(t, INSTALL_MESSAGE_KEYS.notFound, { link }));
  }
  const dir = realpathSync(link);

  const manifestPath = join(dir, 'package.json');
  if (!existsSync(manifestPath)) {
    throw new Error(say(t, INSTALL_MESSAGE_KEYS.noManifest, { dir, link }));
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(say(t, INSTALL_MESSAGE_KEYS.badManifest, { dir, message: error.message }));
  }

  const relative = manifest?.bin?.dsh;
  if (typeof relative !== 'string' || relative === '') {
    throw new Error(say(t, INSTALL_MESSAGE_KEYS.noBin, { manifest: manifestPath }));
  }
  const binPath = join(dir, relative);
  if (!existsSync(binPath)) {
    throw new Error(say(t, INSTALL_MESSAGE_KEYS.binMissing, { binPath }));
  }

  return {
    dir,
    version: typeof manifest.version === 'string' ? manifest.version : 'unknown',
    binPath,
  };
}

/**
 * The workspace named on the command line, if there is one.
 *
 * Two rules, both learned from how this app is actually launched:
 *
 * - **Only absolute paths count.** Electron's own argv contains the app path,
 *   which is `.` under `npm start` and resolves to whatever the process's
 *   working directory happens to be. Treating that as a workspace silently
 *   moved the harness to the app's own directory.
 * - **An explicit `--workspace` wins, and a bad one is refused rather than
 *   skipped.** Falling through to some other argument after a mistyped flag
 *   would switch the workspace to a directory the user never named.
 *
 * @param argv - the argument list, without the executable itself.
 * @param options - `isDirectory` is injected so this is testable without a disk.
 * @returns the absolute workspace path, or null when none was named usably.
 */
export function workspaceFromArgv(argv, options = {}) {
  if (!Array.isArray(argv)) return null;
  const isDirectory = options.isDirectory ?? ((candidate) => {
    try {
      return existsSync(candidate) && statSync(candidate).isDirectory();
    } catch {
      return false;
    }
  });

  const flag = argv.indexOf('--workspace');
  if (flag !== -1) {
    const value = argv[flag + 1];
    if (typeof value !== 'string' || value === '') return null;
    return isDirectory(value) ? value : null;
  }

  for (const argument of argv) {
    if (typeof argument !== 'string' || argument.startsWith('-')) continue;
    if (!isAbsolute(argument)) continue;
    if (isDirectory(argument)) return argument;
  }
  return null;
}

/**
 * The Node executable the child runs on.
 *
 * A child on the system Node — the runtime the user's own harness already runs
 * on — rather than Electron's bundled Node, whose major version differs. See
 * `docs/agent-notes/PROJECT.md` for the measurements.
 *
 * @param env - an environment mapping; defaults to this process's.
 * @param t - optional translator; defaults to the English table.
 * @returns the Node executable path.
 * @throws when neither `DSH_NODE` nor a PATH entry resolves.
 */
export function resolveNodeExe(env = process.env, t) {
  const override = env.DSH_NODE;
  if (typeof override === 'string' && override.trim() !== '') {
    if (!existsSync(override)) throw new Error(say(t, DSH_NODE_MESSAGE_KEY, { override }));
    return override;
  }

  const executable = process.platform === 'win32' ? 'node.exe' : 'node';
  const searchPath = env.PATH ?? env.Path ?? '';
  const tried = [];
  for (const entry of searchPath.split(delimiter)) {
    if (entry.trim() === '') continue;
    const candidate = join(entry, executable);
    tried.push(candidate);
    if (existsSync(candidate)) return candidate;
  }
  // English picks a plural with `{plural}` because the noun changes; Chinese
  // passes an empty string, since it has no plural form to agree with.
  throw new Error(
    say(t, NODE_MESSAGE_KEY, {
      executable,
      count: tried.length,
      plural: tried.length === 1 ? 'y' : 'ies',
    }),
  );
}
