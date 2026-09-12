/**
 * The harness child: spawn it, learn its URL, restart it, and make sure it
 * cannot outlive the shell.
 *
 * Ownership, stated once because it is the whole design:
 * - **This module owns the child handle.** Nothing else spawns, signals, or
 *   restarts the harness.
 * - **The child owns its port.** It is launched with `--port 0` and reports
 *   what the OS gave it; this module reads that port and never picks, probes,
 *   or retries one.
 * - **The harness owns the launch token.** It arrives inside the readiness URL,
 *   is handed to the window exactly once, and is never parsed out, stored, or
 *   replayed here.
 *
 * @module dsh-desktop/harness
 */

import { spawn, spawnSync } from 'node:child_process';
import { harnessArgs } from './args.mjs';
import { shouldRestart } from './restart-policy.mjs';
import { createReadyScanner, redactToken } from './url-line.mjs';

/**
 * Environment variables removed from the child's environment.
 *
 * - `ELECTRON_RUN_AS_NODE` — set by Electron in some launch paths; inherited, it
 *   makes a nested Electron binary behave as plain Node and confuses tooling
 *   that spawns Electron.
 * - `SSH_CONNECTION` / `SSH_CLIENT` / `SSH_TTY` — a stale one makes the harness
 *   believe it was launched over SSH, which suppresses the browser handoff and
 *   (per `dsh-host-directory-picker-auto/README.md:32`) flips its directory
 *   picker from the native OS chooser to an in-page browser.
 *
 * `DSH_HOME` is deliberately passed through untouched.
 *
 * @param base - the environment to copy; defaults to this process's.
 * @returns a copy of the environment with those keys absent.
 */
export function childEnv(base = process.env) {
  const env = { ...base };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY']) delete env[key];
  return env;
}

/**
 * Terminate a process and every process below it.
 *
 * A tree kill, not a signal, and that is not a shortcut. Measured on this
 * machine: a Node child on Windows never runs its `SIGTERM`, `SIGINT`, or
 * `SIGBREAK` handler — `child.kill(signal)` reports the signal back in the exit
 * event while the handler's side effect never happens, because Windows
 * terminates the process outright. So there is no graceful step to take first,
 * and `child.kill()` alone would also strand the tool subprocesses the harness
 * has already spawned.
 *
 * `taskkill /T /F` is the same mechanism `dsh-subprocess-local` uses for its own
 * Windows tree termination (`lib/runner-launch-COYGu0Dl.js:842-851`,
 * `detached: platform !== "win32"` at `:1145`).
 *
 * @param pid - the root of the tree to terminate.
 * @returns the taskkill outcome; a nonzero status is reported, never thrown,
 *   because "already gone" is the normal case on a second call.
 */
export function killTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return { status: null, detail: 'no pid' };
  if (process.platform !== 'win32') {
    try {
      process.kill(pid, 'SIGKILL');
      return { status: 0, detail: 'SIGKILL' };
    } catch (error) {
      return { status: null, detail: error.message };
    }
  }
  const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
    windowsHide: true,
    encoding: 'utf8',
  });
  return {
    status: result.status,
    detail: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(),
  };
}

/**
 * Supervises exactly one harness process at a time.
 */
export class HarnessSupervisor {
  #child = null;
  #scanner = null;
  #attempts = [];
  #stopping = false;
  #gaveUp = false;
  #url = null;
  #bootTimer = null;
  #restartTimer = null;

  /**
   * @param options - everything the supervisor needs, injected so it holds no
   *   ambient state of its own.
   */
  constructor({ nodeExe, anchor, config, cwd, log, onReady, onStatus, onRecord, onGiveUp }) {
    this.nodeExe = nodeExe;
    this.anchor = anchor;
    this.config = config;
    this.cwd = cwd;
    this.log = log;
    this.onReady = onReady ?? (() => {});
    this.onStatus = onStatus ?? (() => {});
    this.onRecord = onRecord ?? (() => {});
    this.onGiveUp = onGiveUp ?? (() => {});
  }

  /** The current child's pid, or null. */
  get pid() {
    return this.#child?.pid ?? null;
  }

  /** The readiness URL of the current child, or null before it is known. */
  get url() {
    return this.#url;
  }

  /** True while a child is spawned and has not exited. */
  get running() {
    return this.#child !== null && this.#child.exitCode === null && this.#child.signalCode === null;
  }

  /**
   * Spawn the harness, unless one is already running.
   * @returns nothing.
   */
  start() {
    if (this.running) return;
    this.#stopping = false;
    this.#url = null;

    const args = harnessArgs({ port: this.config.port });
    this.log(`spawn: ${this.nodeExe} ${this.anchor.binPath} ${args.join(' ')}`);
    this.log(`spawn: cwd=${this.cwd} dsh=${this.anchor.version} (${this.anchor.dir})`);

    let child;
    try {
      child = spawn(this.nodeExe, [this.anchor.binPath, ...args], {
        cwd: this.cwd,
        env: childEnv(),
        // stdin stays an open pipe on purpose: never written, never ended. A
        // stdio-protocol app (acp, sdk) exits on stdin EOF; the web app does
        // not (`exitOnStdinEnd` is bound only by those two apps), and keeping
        // the pipe open keeps that true if a future version binds it.
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      this.log(`spawn failed: ${error.message}`);
      this.#fail(error.message);
      return;
    }

    this.#child = child;
    this.onStatus({ kind: 'starting', pid: child.pid });
    this.log(`child pid=${String(child.pid)}`);
    this.onRecord({ pid: child.pid, startedAt: Date.now() });

    this.#scanner = createReadyScanner({
      // Redacted: the readiness line carries the process launch token, and the
      // log is written to disk. See redactToken().
      onLine: (line) => this.log(`[child] ${redactToken(line)}`),
      onUrl: (url) => {
        this.#url = url;
        this.log(`ready: port=${url.port} pid=${String(child.pid)}`);
        this.onStatus({ kind: 'ready', pid: child.pid, url });
        this.onReady(url);
      },
    });

    child.stdout.on('data', (chunk) => this.#scanner.push(chunk));
    child.stderr.on('data', (chunk) => this.log(`[child:err] ${String(chunk).replace(/\n$/, '')}`));

    this.#bootTimer = setTimeout(() => {
      if (this.#scanner?.isReady === true) return;
      this.log(`no readiness line within ${this.config.bootTimeoutMs} ms; terminating the child`);
      killTree(child.pid);
      this.#fail(
        `The harness did not report a URL within ${Math.round(this.config.bootTimeoutMs / 1000)}s. ` +
          `Its output is in the log. This usually means the DSH tree failed to load, or that the ` +
          `Node.js on PATH is too old for it.`,
      );
    }, this.config.bootTimeoutMs);

    child.on('error', (error) => {
      this.log(`child error event: ${error.message}`);
      this.#fail(`Could not start the harness: ${error.message}`);
    });

    child.on('exit', (code, signal) => {
      this.#scanner?.flush();
      clearTimeout(this.#bootTimer);
      this.#bootTimer = null;
      this.#child = null;
      const wasReady = this.#url !== null;
      this.#url = null;
      this.log(`child exited: code=${String(code)} signal=${String(signal)} ready=${String(wasReady)}`);
      this.onRecord(null);
      if (this.#stopping) {
        this.onStatus({ kind: 'stopped' });
        return;
      }
      this.#onUnexpectedExit(code, signal);
    });
  }

  /**
   * Decide what an unexpected exit means, and either schedule a restart or give
   * up loudly. Exposed for the restart-policy unit tests through its pure half.
   *
   * @param code - the exit code, when it exited on its own.
   * @param signal - the terminating signal, on platforms that report one.
   * @returns nothing.
   */
  #onUnexpectedExit(code, signal) {
    const now = Date.now();
    this.#attempts.push(now);
    const { restart, recent } = shouldRestart({
      attempts: this.#attempts,
      now,
      limit: this.config.restartLimit,
      windowMs: this.config.restartWindowMs,
    });
    this.#attempts = recent;

    const reason = `The harness exited (code=${String(code)} signal=${String(signal)}).`;
    if (!restart) {
      this.#fail(`${reason} It exited ${recent.length} times in a row, so this shell has stopped restarting it.`);
      return;
    }
    this.log(`restarting in 1000 ms (${recent.length}/${this.config.restartLimit} recent exits)`);
    this.onStatus({ kind: 'restarting', attempt: recent.length });
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = null;
      if (!this.#stopping) this.start();
    }, 1000);
  }

  /**
   * Report a condition the shell cannot recover from on its own.
   * @param message - human-readable text shown in the window and the log.
   * @returns nothing.
   */
  #fail(message) {
    if (this.#gaveUp) return;
    this.#gaveUp = true;
    this.log(`giving up: ${message}`);
    this.onStatus({ kind: 'failed', message });
    this.onGiveUp(message);
  }

  /**
   * Terminate the child and everything it spawned.
   * @returns a promise settling once the child is gone or the grace period ends.
   */
  async stop() {
    this.#stopping = true;
    this.#gaveUp = true;
    clearTimeout(this.#restartTimer);
    clearTimeout(this.#bootTimer);
    const child = this.#child;
    if (child === null || child.pid === undefined) return;

    const exited = new Promise((resolve) => child.once('exit', resolve));
    const result = killTree(child.pid);
    this.log(`stop: pid=${String(child.pid)} taskkill status=${String(result.status)} ${result.detail}`);
    if (result.status !== 0 && child.exitCode === null) {
      // taskkill refused (already gone, or access denied); fall back to the
      // direct kill so a single stubborn process cannot block quitting.
      this.log('stop: falling back to child.kill()');
      child.kill();
    }
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, this.config.graceMs))]);
  }

  /**
   * Stop the child and start a fresh one in another working directory.
   *
   * The harness takes its workspace root from the invoking directory, so a
   * workspace change cannot be applied to a running child — it is a restart,
   * not a setting.
   *
   * @param cwd - the directory the new child runs in.
   * @returns a promise settling once the replacement has been started.
   */
  async restartWith(cwd) {
    await this.stop();
    this.cwd = cwd;
    this.#attempts = [];
    this.#gaveUp = false;
    this.#stopping = false;
    this.start();
  }
}
