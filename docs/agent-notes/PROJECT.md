# DSH Desktop — chronicle

## What this is

A Windows **desktop shell for DeepSeek Harness (DSH)**: one app window showing the user's own DSH
GUI, with no browser chrome, no terminal, and no separate server to start. It lives at
`D:\dsh-desktop`, **outside** `D:\DeepSeek Harness`, whose rule 7 is "this repo ships presets and
nothing else" (see `DECISIONS.md` D-5).

It is a **supervisor, not a host**. Electron owns a window and a child process; the harness runs in
that child on the system Node, booted from the user's own `web` profile.

## Architecture (verified)

Each line names how it was established. Session of record: 2026-09-12, DSH 0.1.5-rc.1, Node v26.8.1,
Electron 44.3.0.

- **The harness runs in a child process, and that is decided by a process-level kill switch, not by
  an ABI argument.** `installFailLoud` registers `process.on('unhandledRejection', handler)` and the
  handler calls `proc.exit(1)` (`@deepseek-ai/dsh-app-boot/lib/index.js:1401-1425`; exits at `:1409`,
  `:1420`), installed by `runProfile` (`@deepseek-ai/dsh/lib/profile-boot-Dk-7KqJc.js:301-303`). Read
  directly, not reported. Confirming cost, measured from the binary: Electron 44.3.0 bundles
  **Node v24.20.0** and Chromium **152.0.7977.78**, against this machine's **v26.8.1** — printed by
  `process.versions` in an Electron main process, which is sharper than the release-note figure of
  v24.18.1 that a reviewer supplied.
- **The child's argv is `--profile web --port 0 --no-open`**, and the observed command line in the
  process table is exactly
  `"D:\Program Files\nodejs\node.exe" …\@deepseek-ai\dsh\lib\bin.js --profile web --port 0 --no-open`
  with `--port 0` resolved by the OS (measured ports: 51906, then 53868 — different every launch).
  `--port 0` is documented by the app itself: `dsh-web-app/lib/startup.js:22` says "listen port; pass
  0 to let the OS pick a free one", and it survives the fallback because
  `dsh-web-app/cordis.patch.yml:140` uses `ctx.webStartup.port ?? 3080` — nullish, not falsy.
- **Readiness is the child's stdout line**, `dsh web: http://127.0.0.1:<port>/?token=…`, emitted by
  `console.log` at `dsh-web-app/lib/index.js:203`. Measured end to end: the line arrives ~9 s after
  spawn, and the port in it was the port actually listening.
- **The launch token is replayable, not single-use.** `authorizeIndex` re-mints the cookie on every
  valid `GET /?token=` with no one-shot state (`dsh-client-connection/lib/index.js:386-425`). A review
  asserted otherwise; the source disagrees. Measured against the live server: `GET /` with no cookie
  → **401** `dsh web authentication required; reopen the URL printed by dsh web.`, and
  `GET /?token=<43 chars>` → **303** with `location: /` and a `Set-Cookie`.
- **Windows delivers no signal to the child.** Measured with a three-signal probe: a child with
  `SIGTERM`, `SIGINT`, and `SIGBREAK` handlers never ran any of them — `child.kill(signal)` returned
  `true` and the exit event reported the signal while the handler's sentinel file was never written.
  Termination is therefore `taskkill /PID <pid> /T /F`, which is also what DSH uses for its own
  Windows trees (`dsh-subprocess-local/lib/runner-launch-COYGu0Dl.js:842-851`, `detached: platform
  !== "win32"` at `:1145`).
- **The tree kill is not theoretical: it caught a grandchild.** On quit, taskkill reported
  `SUCCESS: … PID 3808 (child of 18512)` as well as 18512 itself — the harness had already spawned a
  subprocess, and `child.kill()` alone would have stranded it.
- **`npm install` does not fetch Electron's binary in this major.** The published manifest has **no
  `scripts` field at all** (read from `node_modules/electron/package.json`), exposing the installer as
  a bin instead (`"install-electron": "install.js"`). Measured: `npm install` exited 0, added 13
  packages, and left `node_modules/electron/dist` **empty** while `require('electron')` still
  resolved. See `DECISIONS.md` D-6 and `RUNBOOK.md`.
- **The mirror is byte-faithful, not merely fast.** npmmirror's `SHASUMS256.txt` for
  `electron-v44.3.0-win32-x64.zip` is `26bf9a617d58d81772b3d68305d59ee48272969c15083c06db634a77358a8d9d`,
  identical to the value in the npm-published `electron@44.3.0/checksums.json` that `@electron/get`
  validates against. Download measured at 7.48 MiB/s (8 MiB ranged GET); the full 158,149,320-byte
  artifact installed in 14 s.
- **`capturePage()` on a never-shown window does not work here.** It rejects with `UnknownVizError`;
  a `showInactive()` window captures correctly. Compounding trap: the capture returns **device**
  pixels, so a 256-pixel window on this 125 %-scaled display yields 320×320 — which is how an `.ico`
  entry ends up declaring 256 while carrying 320 px. The icon tool now normalises to 256 and
  cross-checks every entry's declared size against its PNG payload.
- **The app never writes under `$DSH_HOME`.** It reads `$DSH_HOME/profiles/node_modules/@deepseek-ai/dsh`
  to find the installation and boots `$DSH_HOME/profiles/web`. Its own state is under
  `%APPDATA%\DSH Desktop`. Note DSH itself rewrites `<profile>/cordis.yml` on boot
  (`dsh/lib/profile-boot-Dk-7KqJc.js:209`), so "the app does not write the profile" and "the profile
  is never written" are different claims; only the first is true.
- **A packaged Windows GUI app must treat stdout as optional, and this cost the whole first packaged
  milestone.** An unguarded `process.stdout.write` in the log helper emitted an `error` event when a
  supervisor closed the pipe; with no listener, Node treats it as fatal to the JavaScript context —
  the process and its window survived (`Responding: True`) while no further JavaScript ran, so a
  `setTimeout` watchdog never fired and a started navigation never completed. The window sat on
  Chromium's own error page under the title `Error`. The defect is **unreachable in development**,
  where stdout is a real console, which is exactly why `npm start` passing was not evidence. Full
  chain, including the four causes ruled out by measurement, in `DECISIONS.md` D-7.
- **Measured against the live, fixed build** — the three-layer connectivity probe
  (`DSH_DESKTOP_DIAG=1`): `nodeFetch=HTTP 401`, `chromiumNet=HTTP 401`, `renderer=HTTP 200`. The
  renderer reaching `200` on the clean root is the cookie exchange having completed; the other two
  are unauthenticated clients and correctly get `401`.

## Component map

| Path | Responsibility |
| --- | --- |
| `src/main.js` | Electron main: window, menu, tray, lifecycle, page-mount diagnostic, own state |
| `src/harness.mjs` | The child: spawn, env hygiene, readiness, restart policy, tree kill, `restartWith` |
| `src/reap.mjs` | Identity-checked termination of a child left by a previous run |
| `src/url-line.mjs` | The readiness-line contract, the chunk-reassembling scanner, token redaction |
| `src/args.mjs` | The child's argv — asserted exactly by a test |
| `src/config.mjs` | Settings defaults and per-field validation |
| `src/geometry.mjs` | Where the window goes next launch — pure, so the off-screen branch is testable |
| `src/state.mjs` | Making `state.json` safe to read; object-or-nothing, unknown keys preserved |
| `src/paths.mjs` | `DSH_HOME`, the installation anchor, the Node executable, the workspace in argv |
| `src/restart-policy.mjs` | When a crash loop must stop |
| `src/loading.html` | The pre-harness page and the failure page |
| `src/icon.svg` | Not present: the mark is read from the installed DSH frontend favicon at build time |
| `tools/make-icon.mjs` | SVG → PNG (visible offscreen window) → hand-built ICO, with payload validation |
| `bin/pack.mjs` | Portable packaging into `dist\DSH Desktop\` |
| `bin/shortcut.ps1` | Start Menu and Desktop shortcuts |
| `test/*.test.mjs` | 42 assertions over the pure modules (`npm test`) |

## Current state

Working and verified end to end on 2026-09-12: the shell starts, spawns the child on the system Node,
captures the readiness URL, loads the GUI, and quits cleanly reaping the whole process tree. The
user's own `dsh web` on 3080 was process-identical (`9420`) before and after every run.

| Item | Outcome |
| --- | --- |
| Child spawned with the intended argv | **Yes** — observed in the process table |
| OS-assigned port, no collision logic | **Yes** — 51906, then 53868 |
| Readiness URL captured from stdout | **Yes** — logged, token redacted |
| Auth fence intact (no cookie → 401) | **Yes**, and the token URL → 303 + cookie |
| Token absent from log and state file | **Yes** — re-verified after a defect was found and fixed |
| User's 3080 instance untouched | **Yes** — PID 9420 unchanged across four launches |
| Quit reaps the whole tree | **Yes** — taskkill killed the child and one grandchild |
| Tray icon, `interface mounted: true` | **Yes** — both in the same run |
| Portable package builds and runs | **Yes** — 367.5 MB, 11 structural checks, then launched from the Desktop shortcut: `navigated (HTTP 200)`, `interface mounted: true`, window `DSH Desktop` |
| A hard kill is survivable | **Yes** — the next launch logged `not reaping pid <n>: process is gone` and started a fresh child; a stale record is repaired, never guessed at |
| Packaged app quits cleanly | **Yes** — taskkill killed the child and grandchild `17928`; 0 Electron processes after |

## Known gaps

- **The exe icon is Electron's default.** Setting it needs `rcedit`/`electron-builder`, i.e. another
  GitHub-hosted binary; window and tray icons are ours (`build/icon.ico`, `build/icon.png`). The
  shortcut points at our `.ico`, so Explorer shows the right icon.
- **A workspace change restarts the harness.** The child's cwd is the workspace root and cannot be
  changed in place, so `File → Open Folder…` stops and starts the child; an in-flight turn is lost.
- **Only one workspace at a time.** One window, one child. Multiple windows would need per-window
  child ownership and is not designed.
- **`graceMs` is honest but unused for shutdown semantics.** Because Windows cannot signal the child,
  the harness's own `SIGTERM` teardown never runs; committed session-log appends are already on disk,
  but in-flight disposal is lost. D-3 records this rather than claiming a clean shutdown.
- **`NODE_OPTIONS` is passed through to the child and warned about by the packaged shell.** This
  machine's environment carries `--use-system-ca`, which the harness child benefits from (it is the
  fix for Node's TLS failure against GitHub) but which a packaged Electron app rejects with a
  one-line stderr warning. Stripping it from the shell's own environment while keeping it for the
  child was **not** attempted; the warning is cosmetic and the app works with the variable set.

## Stale claims to re-check

- The token's single-use claim came from a review and is **false**; D-4 carries the correction. If a
  future version adds one-shot state, the no-probe rule would become load-bearing rather than merely
  simpler.
- Port numbers, PIDs, and byte sizes above are a snapshot of one session. Re-measure before quoting.

## M1 hardening, measured (added after the plan's first milestone)

Thirteen defects were fixed and re-measured. The decisions are D-8…D-13; what follows is the
evidence, because two of them contradict advice that was given to this project by a reviewer.

- **A `null` in `state.json` used to make the app permanently unstartable**, and the mechanism is
  worth keeping: every key is read during module evaluation, so the process died before a window
  existed. After the fix, with the file literally containing `null`, the packaged build logged
  `state: state is not a JSON object (null); ignoring it` and mounted the interface.
- **The test suite could tree-kill a real process.** `test/reap.test.mjs` called `reapStaleChild`
  with no probe, so `npm test` ran a real PowerShell query and would have run `taskkill /PID /T /F`
  against whatever held the fixture's pid. It passed only because that pid was gone. The suite now
  runs 72 assertions in **0.3 s**; the old run cost **534 ms**, and the difference is the proof.
- **Two reviewer findings were refuted by measurement, and are recorded so they are not re-chased:**
  the `console-message` handler is *not* broken on Electron 44 — the log contains real lines like
  `[page:warning] [connection] connection lost, retry #3 (…)`, so `event.message` and `event.level`
  work — and `redactToken('?token=a.b+c/d=e')` returns exactly `"?token=***"`, leaving nothing behind.
  A third finding was half right: the quit path *always* settles because `graceMs` is capped at
  120 000 and its timer is inside the race, so the consequence is a bounded stall, not a zombie
  process. A fourth was wrong in a way that would have broken the feature: requiring the reaped
  process's parent to be *this* process refuses every real reap, because a stale child's parent is
  the previous run, which is dead by definition.
- **Two of the tests the reviewer flagged were right and are fixed**: the "user's own dsh is never
  reaped" case was testing the *time* branch only (its fixture even used `--profile web`, which the
  real `dsh web` on this machine does not carry), and "the defaults match the config module" asserted
  the function's own literals without ever consulting `DEFAULT_CONFIG`.
- **Log timestamps are local with an offset** (`2026-09-12T14:59:55.328+08:00`). The file name and
  the file's own modification time now agree to within a minute; they used to disagree by eight hours.
- **The reaper now matches a description, not a guess.** The record carries `nodeExe`, `parentPid`
  and `args` alongside the bin path and start time, and all of them must agree. The argv is matched
  as one contiguous run because a test caught that per-token matching accepted `--port 3080` — it
  contains the recorded token `0`.
- **The boot-timeout floor rose from 5 s to 30 s** because nine measured boots took 8.67–10.20 s;
  the documented minimum was below the mean, so choosing it made every launch time out.
- **A defect was found by testing rather than by reading**: with `closeToTray` on, a second launch
  focused a hidden window without showing it. `focus()` does nothing to a hidden window.

