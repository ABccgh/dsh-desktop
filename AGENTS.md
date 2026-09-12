# AGENTS.md — DSH Desktop

A Windows desktop shell for **DeepSeek Harness (DSH)**. It is a *supervisor*: Electron owns one
window and one child process, and the harness itself runs in that child, on the **system Node**,
booted from the user's own `web` profile.

This project is deliberately **outside** `D:\DeepSeek Harness` (the `dsh-smith` preset repository),
whose rule 7 is "this repo ships presets and nothing else". Do not move it in.

## The four facts that shape every change

1. **The harness is a child process, never in-process.** `installFailLoud` binds
   `process.on('unhandledRejection', …)` to `process.exit(1)`
   (`@deepseek-ai/dsh-app-boot/lib/index.js:1409,1420`, installed by `runProfile` at
   `@deepseek-ai/dsh/lib/profile-boot-Dk-7KqJc.js:301-303`). Any stray rejection anywhere would kill
   the whole app if the harness shared Electron's process. See `docs/agent-notes/DECISIONS.md` D-1.
2. **Windows delivers no signal to the child.** Measured: `child.kill('SIGTERM' | 'SIGINT' |
   'SIGBREAK')` reports the signal back in the exit event while the child's own handler never runs.
   Termination is `taskkill /PID <pid> /T /F` — a tree kill — because that is the only thing that
   also catches the tool subprocesses the harness has spawned. D-3.
3. **The readiness signal is the child's stdout line**, `dsh web: http://127.0.0.1:<port>/?token=…`.
   There is no HTTP probe; the port is chosen by the OS (`--port 0`) and read from that line. D-4.
4. **stdout is optional in a packaged GUI app, and using it unguarded is fatal.** A packaged Windows
   app has no console; when a supervisor closes the pipe, `process.stdout.write` emits an `error`
   event and Node treats an unhandled one as fatal **to the JavaScript context** — the process and
   its window stay alive while nothing further runs, which presents as a window stuck on Chromium's
   error page with no failing event to point at. Every write goes through a guard and both streams
   carry an `error` listener. This defect is unreachable under `npm start`, so "it works in dev" is
   not evidence for this class of bug. D-7 is the full chain, including four causes that were tested
   and ruled out.

## Rules

- **Never touch the user's own `dsh web`** — not its port (3080 here), not its process, not its
  session. The shell launches with `--port 0` precisely so it cannot collide, and the only process
  it ever kills is one it spawned or verified as its own by argv **and** start time (`src/reap.mjs`).
- **Never write under `$DSH_HOME`.** The shell reads `$DSH_HOME/profiles/node_modules/@deepseek-ai/dsh`
  to find the installation and reads `$DSH_HOME/profiles/web` by booting it. It writes nothing there;
  its own state lives under Electron's `userData` (`%APPDATA%\DSH Desktop`).
- **Never parse, store, or replay the launch token.** It arrives in the readiness URL, is handed to
  the window once, and is kept out of the log. Do not add an HTTP probe of that URL.
- **Never put a user-influenced string into the child's argv.** An `-h`/`--help` there makes the web
  command print help and never provide `webStartup`, so the server never mounts and the app hangs
  with no error. The workspace is passed as the child's `cwd`. `src/args.mjs` asserts the exact array.
- **`npm install` does not fetch Electron's binary** in this major — see `RUNBOOK.md`. A successful
  `npm install` with an empty `node_modules/electron/dist` is the expected failure, not a mystery.

## Where things are

| Path | Responsibility |
| --- | --- |
| `src/main.js` | Electron main: window, menu, tray, lifecycle, own state under `userData` |
| `src/harness.mjs` | The child: spawn, readiness, restart policy, tree-kill, environment hygiene |
| `src/reap.mjs` | Identifying and terminating a child left by a previous run; the only kill of a process we did not spawn |
| `src/url-line.mjs` | The readiness-line contract, and the chunk-reassembling scanner |
| `src/args.mjs` | The child's argv, in one place, asserted exactly by a test |
| `src/config.mjs` | Settings: defaults, validation, per-field fallback |
| `src/paths.mjs` | `DSH_HOME`, the installation anchor, and the Node executable |
| `src/restart-policy.mjs` | When a crash loop must stop |
| `src/loading.html` | The pre-harness page and the failure page |
| `bin/pack.mjs` | Portable packaging into `dist\DSH Desktop\` |
| `bin/shortcut.ps1` | Start Menu and Desktop shortcuts |
| `tools/make-icon.mjs` | Icon: SVG → PNG (via an offscreen Electron window) → ICO |
| `docs/agent-notes/**` | Project memory: runbook, chronicle, decisions, board |
