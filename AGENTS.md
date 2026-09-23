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
   `@deepseek-ai/dsh/lib/profile-boot-Dk-7KqJc.js:301-303` — reached through the two-line
   `lib/profile-boot-BP_C0vpU.js` re-export that `lib/bin.js:145` imports; re-read against
   0.1.5-rc.3 on 2026-09-23). Any stray rejection anywhere would kill
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
- **A test must never reach a real process.** `reapStaleChild` takes `{ probe, kill }` precisely so
  every test can pass stubs; the default inspector runs PowerShell and the default killer is
  `taskkill /PID /T /F`. The suite once called it with neither and would have tree-killed whatever
  held the pid in its fixture — it passed only because that pid happened to be gone. `npm test` must
  stay well under a second: a slow suite is the smell that something real is being spawned. D-13.
- **The development build and the packaged build share one `userData`, and therefore one
  single-instance lock.** `electron.exe` and `DSH Desktop.exe` both resolve to
  `%APPDATA%\DSH Desktop`, so a packaged instance left running silently rejects every later
  `npm start` with `another instance owns the lock; exiting` and no window. Measured: two dev
  launches disappeared this way, and the child killed as "a stray" was the packaged instance's own
  child, which its supervisor then correctly restarted. When a launch does nothing, list **both**
  process names before concluding anything — and prefer `npm run smoke`, which drives a real launch
  and fails loudly rather than quietly reusing someone else's window.
- **A DSH upgrade is a verification, not an edit — and the shell must never pin a DSH version.**
  `resolveInstallAnchor` follows the junction the harness maintains, so a new DSH arrives on its own
  and the one thing that can go stale is the ground under the contracts. The order is
  `npm run surface` → `node --test test/` → `npm run smoke:dev` → `npm run pack` → `npm run smoke`, and
  only then `npm run surface -- --record` (see `RUNBOOK.md`). A `CHANGED` line is a **trigger to go and
  read**, not a verdict: `surface` compares bytes, and which contract broke is a question only reading
  the file can answer. Measured once end to end on 2026-09-23 (rc.1 → rc.3, surface byte-identical,
  20/20 twice) — D-30.
- **Every user-visible string goes through `src/i18n.mjs`, and a `role:` menu item is not exempt.**
  Measured on Electron 44.3.0: `{ role: 'reload' }` and its six siblings render English labels on
  Windows no matter what language the app runs in, so each one carries an explicit `label:` here —
  the role still supplies the accelerator. The paired test in `test/i18n.test.mjs` greps the
  rendered modules for `t('…')` calls and fails when either dictionary is missing one, which is the
  only thing that catches a new English sentence before it reaches a Chinese screen.
- **The interface language is decided once per process, and it is two decisions.** Chromium reads
  `--lang` at startup, so `main.js` appends it before `whenReady` — and only for an explicit `zh`/`en`,
  because `auto` must leave the system locale alone. The GUI inside the window resolves its own
  language from `navigator.languages` (measured here: `["zh-CN","zh-Hans-CN"]`, which the shipped
  client matches by primary subtag), which is why a Chinese system gets a Chinese GUI with no
  configuration at all. The shell's own surfaces re-render immediately on a language change; the GUI
  cannot, so the settings window says a restart is needed.
- **A setting nobody reads is a defect, not a placeholder.** `maxWindows` and `notifyOnFailure` both
  shipped defaulted, validated, and read by nothing; the first was deleted and the second wired up.
  `test/config.test.mjs` now fails when any key in `DEFAULT_CONFIG` has no `config.<key>` read in
  `src/` or `bin/`. **Write the reader in the same change as the key.** If you ever harden that test,
  mutation-test it: delete a single read and confirm the suite fails — the first three versions of it
  passed no matter what, once because it matched the key inside a log message, once because `\\b` in a
  **regex literal** is a literal backslash, and once because its exclusion compared a relative path
  against an absolute one.

## Commands

```powershell
npm test            # node --test test/ — 101 tests, ~0.4 s, no real process touched
npm start           # electron .  (add -- "D:\some\project" to choose the workspace)
npm run icon        # build/icon.png + build/icon.ico
npm run pack        # dist\DSH Desktop\DSH Desktop.exe — portable, no extra toolchain
npm run smoke       # the acceptance ladder against the packaged build (needs pack first)
npm run smoke:dev   # the same ladder against `electron .`
npm run surface     # is the installed DSH still the surface this was verified against?
```

`npm install` installs Electron; the project's own `postinstall` then fetches and extracts its binary.
`npm run installer` (NSIS) has never been run — see `docs/agent-notes/RUNBOOK.md` before trusting it.

## Where things are

| Path | Responsibility |
| --- | --- |
| `src/main.js` | Electron main: window, menu, tray, lifecycle, CLI switches, hotkey, jump list, own state under `userData` |
| `src/i18n.mjs` | Every string the shell shows, in `zh` and `en`, plus the resolver that turns a system language list into one of them |
| `src/harness.mjs` | The child: spawn, readiness, restart policy, tree-kill, environment hygiene |
| `src/reap.mjs` | Identifying and terminating a child left by a previous run; the only kill of a process we did not spawn |
| `src/url-line.mjs` | The readiness-line contract, the chunk-reassembling scanner, and both token redactors |
| `src/args.mjs` | The child's argv, in one place, asserted exactly by a test |
| `src/config.mjs` | Settings: defaults, validation, per-field fallback |
| `src/paths.mjs` | `DSH_HOME`, the installation anchor, the Node executable, and the workspace in argv |
| `src/restart-policy.mjs` | When a crash loop must stop |
| `src/diagnostics.mjs` | The support bundle — redacted field by field, never assembled from raw state |
| `src/loading.html` | The pre-harness page and the failure page |
| `src/settings.html`, `src/settings-preload.cjs` | The settings window and its bridge; `sandbox: true` means the preload must be CommonJS |
| `bin/pack.mjs` | Portable packaging into `dist\DSH Desktop\`; calls rcedit's **binary**, not its missing wrapper |
| `bin/smoke.mjs` | The acceptance ladder against a real launch (`npm run smoke`, `smoke:dev`); its 20th check ties a green run to the installed DSH version |
| `bin/dsh-surface.mjs` | The DSH files this shell's contracts live in, compared with the bytes last read and measured (`npm run surface`, baseline `docs/agent-notes/dsh-surface.json`) |
| `bin/shortcut.ps1` | Start Menu and Desktop shortcuts, optionally pinned to a workspace |
| `tools/make-icon.mjs` | Icon: SVG → PNG (via an offscreen Electron window) → ICO |
| `electron-builder.yml` | The NSIS installer target — **configured, never built**; `bin/pack.mjs` is the supported path |
| `docs/agent-notes/**` | Project memory: runbook, chronicle, decisions, board |
