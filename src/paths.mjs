/**
 * Where everything lives. Pure lookups, no side effects, so the failure of each
 * one can name the exact path it wanted.
 *
 * @module dsh-desktop/paths
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

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
 * @returns the resolved installation: directory, version, and the CLI entry path.
 * @throws when the junction, the manifest, its `bin.dsh`, or that file is absent.
 */
export function resolveInstallAnchor(dshHome) {
  const link = join(dshHome, 'profiles', 'node_modules', '@deepseek-ai', 'dsh');
  if (!existsSync(link)) {
    throw new Error(
      `DSH installation not found at ${link}. Install or reinstall DeepSeek Harness ` +
        `(the \`dsh\` command), or set DSH_HOME if it lives elsewhere.`,
    );
  }
  const dir = realpathSync(link);

  const manifestPath = join(dir, 'package.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`DSH installation at ${dir} has no package.json (resolved from ${link}).`);
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`DSH installation at ${dir} has an unreadable package.json: ${error.message}`);
  }

  const relative = manifest?.bin?.dsh;
  if (typeof relative !== 'string' || relative === '') {
    throw new Error(`DSH package at ${manifestPath} declares no bin.dsh entry.`);
  }
  const binPath = join(dir, relative);
  if (!existsSync(binPath)) {
    throw new Error(`DSH CLI entry ${binPath} (from bin.dsh) does not exist.`);
  }

  return {
    dir,
    version: typeof manifest.version === 'string' ? manifest.version : 'unknown',
    binPath,
  };
}

/**
 * The Node executable the child runs on.
 *
 * A child on the system Node v26.8.1 — the runtime the user's own harness
 * already runs on — rather than Electron's bundled Node, whose major version
 * differs. See `docs/agent-notes/PROJECT.md` for the measurements.
 *
 * @param env - an environment mapping; defaults to this process's.
 * @returns the Node executable path.
 * @throws when neither `DSH_NODE` nor a PATH entry resolves.
 */
export function resolveNodeExe(env = process.env) {
  const override = env.DSH_NODE;
  if (typeof override === 'string' && override.trim() !== '') {
    if (!existsSync(override)) throw new Error(`DSH_NODE is set to ${override}, which does not exist.`);
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
  throw new Error(
    `Node.js was not found on PATH (looked for ${executable} in ${tried.length} ` +
      `director${tried.length === 1 ? 'y' : 'ies'}). Install Node.js, or set DSH_NODE to its full path.`,
  );
}
