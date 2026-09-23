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
Electron 44.3.0. **Re-verified against DSH 0.1.5-rc.3 on 2026-09-23 — see the section at the end of
this file for what was re-measured and what did not change.**

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
| `src/main.js` | Electron main: window, menu, tray, lifecycle, CLI switches, hotkey, jump list, page-mount diagnostic, own state |
| `src/i18n.mjs` | Every string the shell shows (`zh`/`en`), the `{name}` substitution, and the resolver from a system language list to one of the two |
| `src/harness.mjs` | The child: spawn, env hygiene, readiness, restart policy, tree kill, `restartWith`; its failures are message keys rendered through an injected translator |
| `src/reap.mjs` | Identity-checked termination of a child left by a previous run |
| `src/url-line.mjs` | The readiness-line contract, the chunk-reassembling scanner, both token redactors |
| `src/args.mjs` | The child's argv — asserted exactly by a test |
| `src/config.mjs` | Settings defaults and per-field validation |
| `src/geometry.mjs` | Where the window goes next launch — pure, so the off-screen branch is testable |
| `src/state.mjs` | Making `state.json` safe to read; object-or-nothing, unknown keys preserved |
| `src/diagnostics.mjs` | The support bundle: versions, paths, windows, config, state, log tail — redacted field by field |
| `src/paths.mjs` | `DSH_HOME`, the installation anchor, the Node executable, the workspace in argv |
| `src/restart-policy.mjs` | When a crash loop must stop |
| `src/loading.html` | The pre-harness page and the failure page |
| `src/settings.html`, `src/settings-preload.cjs` | The settings window and its bridge — sandboxed, so the preload must be CommonJS |
| `src/icon.svg` | Not present: the mark is read from the installed DSH frontend favicon at build time |
| `tools/make-icon.mjs` | SVG → PNG (visible offscreen window) → hand-built ICO, with payload validation |
| `bin/pack.mjs` | Portable packaging into `dist\DSH Desktop\`, including exe icon and version via rcedit's binary |
| `bin/smoke.mjs` | The acceptance ladder against a real launch (`npm run smoke`, `smoke:dev`) — **20 checks**, including which DSH version the child actually was |
| `bin/dsh-surface.mjs` | The coupling surface: which installed DSH files this shell's contracts live in, compared against the bytes last read and measured (`npm run surface`) |
| `bin/shortcut.ps1` | Start Menu and Desktop shortcuts, optionally pinned to a workspace |
| `electron-builder.yml` | The NSIS installer target — **configured, never built** |
| `test/*.test.mjs` | 101 tests over the pure modules (`npm test`, ~0.35 s) |

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

- **The exe icon and version are set, and the earlier "gap" here was wrong in an instructive way.**
  It used to read "setting it needs `rcedit`/`electron-builder`, i.e. another GitHub-hosted binary".
  It does need `rcedit` — and `rcedit@5.0.0` publishes `files: ["bin", "lib/index.d.ts"]`, so the
  binary ships and the JavaScript wrapper does not. `bin/pack.mjs` calls the binary directly, with
  the flags the binary prints for itself, and reads the result back (`ProductName` →
  `DSH Desktop`). D-16/D-17.
- **The NSIS installer target is configured and has never been built.** `electron-builder.yml` and
  `npm run installer` exist; no run of either has been recorded, so the toolchain and the artifact
  are both unproven. `bin/pack.mjs` is the supported path, and the README says so.
- **One window and one workspace, still.** M3 (multiple windows) is **neither designed nor started**
  — the only artefact is a size estimate, not a design; see `BOARD.md`. The single `win` variable is
  referenced 113 times in `src/main.js`, which is the size of that change rather than a measure of
  its difficulty. The session write lease is a kernel lock and the credential file is replaced
  atomically, but shared `storage` JSON is last-writer-wins with no cross-process check — unmeasured
  for two windows on one profile.
- **`maxWindows` is a control that does nothing.** `src/config.mjs:35` defaults it to 4, `:75`
  validates it over 1–8, and `src/settings.html:75-76,106` renders it as **Workspace windows** — but
  nothing reads it: no file outside `config.mjs` and `settings.html` mentions the key. It is a
  placeholder for M3 that is visible to the user, which is worse than an internal one. Either wire it
  up with M3 or remove it from the form.
- **A workspace change restarts the harness.** The child's cwd is the workspace root and cannot be
  changed in place, so `File → Open Folder…` stops and starts the child; an in-flight turn is lost.
- **`graceMs` is honest but unused for shutdown semantics.** Because Windows cannot signal the child,
  the harness's own `SIGTERM` teardown never runs; committed session-log appends are already on disk,
  but in-flight disposal is lost. D-3 records this rather than claiming a clean shutdown.
- **`NODE_OPTIONS` is passed through to the child and warned about by the packaged shell.** This
  machine's environment carries `--use-system-ca`, which the harness child benefits from (it is the
  fix for Node's TLS failure against GitHub) but which a packaged Electron app rejects with a
  one-line stderr warning. Stripping it from the shell's own environment while keeping it for the
  child was **not** attempted; the warning is cosmetic and the app works with the variable set.
- **Two DSH couplings the shell itself does not check, both holding today — found by the 0.1.5-rc.3
  contract review.** `dsh/lib/bin.js:168` is `if (import.meta.main) await runCli();`, and
  `resolveNodeExe` pins no minimum Node version: it takes the first `node.exe` on `PATH`. On a Node
  without `import.meta.main` the child would load the module, never call `runCli`, exit 0 and print no
  readiness line — the shell would spend its three restarts and then report "exited with code 0".
  Measured here: Node v26.8.1, `typeof import.meta.main === 'boolean'`. And
  `dsh-host-webserver/lib/index.js:142` is `port: z.natural().max(65535).required()`, which accepts 0;
  a future `min(1)` or a falsy test would silently turn `--port 0` into a fixed port. Both files are in
  the `npm run surface` baseline now, so a change to either is *reported* rather than discovered late.
- **`src/url-line.mjs` requires a non-empty `url.port`, so a readiness line on port 80 would be
  rejected.** `new URL('http://127.0.0.1:80/?token=x').port` is `""` (executed, not recalled).
  Unreachable in practice — `--port 0` never yields 80 and the shell never asks for it — and recorded
  rather than worked around, because the alternative is a parser that accepts a URL with no port.

## Stale claims to re-check

- The token's single-use claim came from a review and is **false**; D-4 carries the correction. If a
  future version adds one-shot state, the no-probe rule would become load-bearing rather than merely
  simpler.
- Port numbers, PIDs, and byte sizes above are a snapshot of one session. Re-measure before quoting.
- **The rc.1 → rc.3 byte-identity table (at the end of this file) is evidence about those two
  revisions only.** It says nothing about 0.1.7-rc.1, or about anything published after 2026-09-23.
  `npm run surface` is the check that answers it for the next upgrade, and it answers it for the
  *installed* DSH — not for a version read about somewhere.

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
  *(The runner counts tests, not assertions: 79 of them as of M4, 101 as of M7, still ~0.35 s.
  "Assertions" is this file's older word for the same measurement.)*
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

## M2, M4, M5, measured

The settings window (F1), then the shell's own desktop surfaces. Each row is an observation, not an
intent.

| Item | Evidence |
| --- | --- |
| Sandboxed preload works | The page logged `settings bridge: object` — the milestone's one stated assumption, probed before anything was built on it. **Read it for exactly what it is:** `typeof window.dshSettings` proves the preload executed and the bridge exists, not that any of the seven calls answers. The seven `ipcMain.handle` names are a registration, not a probe; exercise the form by hand after any change to the IPC surface |
| Settings round-trip | Seven IPC calls over `contextBridge` — six `settings:*` plus `diagnostics:export`. An empty field means **leave that setting alone**, not "fall back to the default": `undefined` values are dropped before `normalizeConfig` (`src/main.js:879-885`), which is D-15's decided branch — quoting the default here would have stated the branch D-15 rejects |
| Global hotkey | `global hotkey registered: Control+Alt+D`; an accelerator another program owns logs a refusal instead of failing startup |
| Jump list | `jump list: ok (1 tasks)` on the first run and `ok (2 tasks)` once a workspace was seeded — `setJumpList` **returns** its result, so the return value is logged rather than assumed. The first-run count is the pinned entry alone, so it proves the call answered rather than that a workspace entry was present |
| DSH version change | Logged when `lastDshVersion` differs, and recorded in `state.json` |
| Diagnostics export | 7785 bytes, all six sections, **0 token leaks** — written by the same function the Help menu calls |
| Exe icon and version | `exe ProductName reads back as "DSH Desktop"`, read back with rcedit's own getter |
| `--version` / `--help` | Printed and exited, leaving **0 Electron processes**; they run before the single-instance lock, so they answer while another copy is running |
| Acceptance ladder | `npm run smoke` — **12/12** on the packaged build, with the user's own 3080 GUI process-identical before and after |

**The redactor needed a second, wider pass, and the narrow one hid it.** `redactToken` matched
`token=` followed by non-space characters, which covers the readiness URL; the diagnostics bundle
carried the same secret in **four of seven** places it appeared — a header, a JSON field, a
`--token <value>` pair, and one bare 43-character run. `redactTokenLike` was added beside it and is
what the bundle uses; the 64-character session hash is deliberately left alone. Re-measured: 0 leaks
across the whole bundle. The narrow function stays because the log wants the narrow behaviour.

**A shortcut that is re-created does not start from empty.** `WScript.Shell.CreateShortcut()` loads an
existing `.lnk`, so `bin/shortcut.ps1` assigns `Arguments` unconditionally now — skipping the
assignment when it was empty would have left a previous run's `-Workspace` silently in place.

## M6, the Chinese interface, measured (2026-09-14)

The user asked whether the whole desktop application could be Chinese and supplied a screenshot of its
`Help` menu in English while the GUI behind it showed `工作区`. That screenshot is the finding: the
window is two programs, and only one of them was localized.

- **The web GUI was already Chinese, and had been all along.** The GUI resolves its language from
  `navigator.languages`, and this shell's renderer reports `["zh-CN","zh-Hans-CN"]` (probed directly
  in an Electron window, not inferred). `dsh-client-locale` ships `zh` and `en` and matches a browser
  tag by exact id and then by **primary subtag** (`dsh-client-locale/lib/client.js:1344-1355`), so
  `zh-CN` selects `zh`. No configuration, no plugin, and nothing to change in the shell: the GUI
  follows the system locale, and the user's own `dsh web` on 3080 behaves the same way.
- **The shell was entirely English, including the parts Electron claims to own.** Every string was
  inline in `main.js`, `settings.html`, `loading.html`, `harness.mjs` and `paths.mjs`. Measured on
  Electron 44.3.0: a `role:` menu item renders an **English** label on Windows (`Reload`,
  `Actual Size`, `Zoom In`, `Toggle Full Screen`) whatever the app's locale, and a custom `label:`
  overrides the text while the role keeps supplying the accelerator. Without that, "Chinese
  interface" would have stopped at the `View` menu.
- **The language is two decisions, not one.** Chromium reads `--lang` once, at process start, so the
  shell appends it before `whenReady` — and only for an explicit `zh`/`en`, because `auto` exists to
  *follow* the system and a switch would override the very thing it means. The shell's own surfaces
  re-render immediately on a change; the GUI cannot, which is why the settings window says a restart
  is required. Measured both directions end to end (`language: zh (setting auto, system zh)` and
  `language: en (setting en, system zh)`).
- **`config.language` is `auto | zh | en`, validated in `config.mjs` exactly like every other field.**
  An unknown id is refused where the reason is visible rather than falling through to `auto` deep in
  the translator.
- **Nothing writes `$DSH_HOME/settings.yaml`, which is a decision and not an omission.** The GUI's own
  preference mechanism is that file's `locale.preference`; the shell deliberately does not touch it,
  because it is shared with the user's own running `dsh web` and because the shell writes nothing
  under `DSH_HOME`. D-23 records the reasoning and what would reverse it. *(This paragraph cited D-19
  until it was checked; D-19 is about publishing this repository over the REST API.)*
- **The acceptance ladder grew from 12 checks to 19**, and one of the new ones is the falsification
  that matters: a **second launch** with `--language en` on a `zh` system must resolve to `en`.
  `npm run smoke:dev` and `npm run smoke` both pass 19/19.
- **A pre-existing defect the ladder found by being run repeatedly: the cookie jar grew without bound
  and eventually made the window blank.** The GUI's server names its auth cookie after the launch
  authority (`dsh-auth-<43 chars>`), and the authority changes every launch because the port does — so
  each run *added* a cookie rather than replacing one. Measured at **70 rows**: the token exchange
  answered **HTTP 431**, the interface mounted nothing, and the only trace was `interface mounted:
  false` in the log with no error of the shell's own. The shell now sweeps those cookies at startup
  (D-27); the jar holds one and stays at one across repeated launches. The lesson is about evidence as
  much as code: **this could only appear after enough runs, so a single green ladder is not evidence
  that the ladder is sound.**
- **An explicit language choice steers the GUI too, and this file said otherwise until it was
  measured.** It used to claim the `--lang` switch "changes nothing about the GUI" because the GUI's
  harness is a separate process. False, and corrected here: the GUI is a *renderer of this Electron
  instance*, so `app.commandLine.appendSwitch('lang','en-US')` moves `navigator.languages` to
  `en-US | en-US,zh-Hans-CN` in the renderer, and the GUI's own resolver walks exactly that list
  (`dsh-client-locale/lib/client.js:1344-1355`), with no `locale.preference` in `settings.yaml` to
  override it. So `language: 'en'` gives an English shell **and** an English GUI after a restart;
  `auto` is the setting that leaves the GUI to the system. The smoke check asserts only the log line,
  so it could never have caught this — a reminder that a check "proving" a negative needs to look at
  the thing being denied. D-24 supersedes D-22 on this point.

**Four defects in the verification itself, worth keeping because each produced a confident wrong
reading rather than an error:**

- Two `executeJavaScript` probes failed with "An object could not be cloned" because they returned a
  **Promise** and an **array of DOM nodes**. The fix is primitive returns — the probe pages now write
  a JSON string into `document.title`.
- A `^language:` regex never matched a log line, because every line is prefixed with a **local
  timestamp**. Three consecutive runs reported "no language line" for logs that plainly carried one;
  the pattern now tolerates the prefix.
- The resolved-language line named `config.language` rather than the **effective** choice, so a forced
  launch logged `setting auto` while behaving as `en` — a log that described something other than what
  happened. `smoke.mjs` caught it, which is the only reason it was found.
- Reading the log immediately after the readiness line is a **race**: the file is appended line by line
  by another process, so the language line can be a moment behind. The check now retries with a bound.

**A probe left processes behind, and cleaning them up is part of the work.** Two Electron probe groups
and one real launch were still running after their harnesses had been started; they were killed by
**exact pid with `taskkill /T /F`**, never by name, and the session's own process (`node.exe` behind
3080) was verified untouched afterwards. The lesson worth carrying: a launch that holds the
single-instance lock can be a *real* launch, so before starting one check what is already running.

## The tidy-up after M7 (2026-09-14)

Asked for as "全面清理和全面整理，并上传 GitHub". The published tree was already clean — 42 tracked
files, three ignored directories, and the two new files were not caught by any ignore rule — so the
work was the parts of the repository that had gone stale, plus one dead control the notes had been
carrying as a "known gap" for three milestones.

- **`maxWindows` is gone, not hidden.** It was defaulted, validated over 1–8, rendered in the settings
  form, and read by nothing: `grep` found it only in `config.mjs`, `settings.html` and the dictionary.
  The notes had called it "a control that silently does nothing is worse than an absent one" and then
  left it in place for three milestones. A `config.json` that still carries the key is now simply a
  config with an unknown key, which is dropped silently — the house rule for unknown keys.
- **`notifyOnFailure` now does what its comment always said.** It was in the same state — validated,
  never read. `tray.displayBalloon({ title, content })` was probed on this machine first and answered
  `DISPLAY_BALLOON ok`, and `DisplayBalloonOptions` states no length limit, which is why the title is
  the product's short name and the sentence goes in `content`. The call sits at the **top** of
  `surfaceFailure`, before its two early returns, because the window being gone or hidden is precisely
  the case a tray balloon exists for.
- **A dead key is now a test failure.** `test/config.test.mjs` scans `src/` and `bin/` for a
  `config.<key>` read of every key in `DEFAULT_CONFIG`. It took three attempts to make it real, and
  each failure is worth keeping:
  1. it matched the key where it appeared in a **log message and a doc comment**, so deleting the one
     real read still passed — a mention in prose is not a read;
  2. the fix escaped the pattern as `'\\bconfig\\.${key}\\b'` inside a **regex literal**, where `\\b`
     is a backslash followed by the letter b — so it matched nothing and passed forever;
  3. the exclusion of `config.mjs` compared against `\config.mjs` while the map held **absolute**
     paths, so the exclusion never applied and the module that *declares* the key counted as a reader.
  Only the **mutation test** found all three: delete the single read of `notifyOnFailure`, expect the
  suite to fail, restore it. A guard that has never been shown to fail is not a guard.
- **Documentation corrections, each checked against the code rather than trusted:** `PROJECT.md` cited
  D-19 for the `settings.yaml` decision when D-23 is the entry that holds it; `BOARD.md` still called
  the plan "six-milestone" after M7 made it seven; `package.json` had **no** `repository` field at all,
  while `D:\DeepSeek Harness\AGENTS.md` described it as naming the intended target — it now does, and
  that sentence in the other repository was corrected to match.
- **`README.zh.md`** was added, with the two READMEs linking to each other. The product speaks Chinese;
  the repository did not.

## The 0.1.5-rc.3 update, measured (2026-09-23)

Asked for as "dsh已更新到最新版本，对dsh desktop进行更新". The premise was checked before anything was
changed, because "update the shell" had three possible meanings — run the new DSH, rebuild the artifact,
correct the version in the record — and the honest answer is that the **runtime needed no change at
all**, which is a claim that had to be established rather than asserted.

**What the upgrade was.** `npm view @deepseek-ai/dsh dist-tags` → `{ latest: '0.1.5-rc.3',
next: '0.1.7-rc.1', alpha: '0.1.7-alpha.2' }`, and the installation the shell resolves
(`…\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh`, reached through the
`$DSH_HOME\profiles\node_modules\@deepseek-ai\dsh` junction) is 0.1.5-rc.3, unpacked 2026-09-23 22:57.
So `latest` is what is installed. The user's own `dsh web` on 3080 was restarted onto it at 23:00:01 —
PID **14972**, unchanged before and after every run below.

**The measurement that decided the shape of this milestone: the shell's coupling surface is
byte-identical between rc.1 and rc.3.** rc.1's tarballs were fetched from the npm registry and unpacked
in memory — no rc.1 copy remains on disk — and each file was compared with the installed rc.3 file by
sha256:

| File | rc.1 | rc.3 |
| --- | --- | --- |
| `dsh/lib/bin.js` | 9165 B `0ff7f1d72c4e0cbe` | **identical** |
| `dsh-web-app/lib/index.js` | 10306 B `f93d006de823bad3` | **identical** |
| `dsh-web-app/lib/startup.js` | 2772 B `95a47053483fbe8e` | **identical** |
| `dsh-web-app/cordis.patch.yml` | 18588 B `1c0209b817d05d25` | **identical** |
| `dsh-client-connection/lib/index.js` | 32900 B `bbe7c9aa6d82a7a4` | **identical** |
| `dsh-app-boot/lib/index.js` | 69668 B `d8fdfe41996a4fef` | **identical** |
| `dsh-client-locale/lib/client.js` | 55547 B `cff36c3b5f57b0f2` | **identical** |
| `dsh-host-directory-picker-auto/README.md` | 7301 B `db2a66618c0c5677` | **identical** |
| `dsh-subprocess-local/lib/runner-launch-COYGu0Dl.js` | 60094 B `674f0acce6cf7969` | **identical** |
| `dsh-web-frontend/dist/favicon.svg` | 3721 B `c61a62a9d47d8660` | **identical** |

That is why not one line of `src/` changed: the readiness line, the argv hand-off, the port fallback,
the auth-cookie prefix, the fail-loud kill switch, the locale rule and the icon's source are the same
bytes as the build the earlier sessions measured.

**An independent contract review, run in parallel, reached the same conclusion from the other
direction.** Nine contracts were read one at a time against the installed rc.3 — the anchor; the argv
(verified by *executing* the installed commander against `bin.js`'s own program, which yielded
`{"mode":"profile","profile":"web","args":["--port","0","--no-open"]}`); the readiness line (still on
stdout, `printUrl` default-on, still emitted under `--no-open`); the cookie prefix and its host-only
scoping; the 401/303 fence; stdin EOF; `installFailLoud` (both `proc.exit(1)` lines and the
`runProfile` call site, unchanged line-for-line); the locale rule; and the `taskkill /T /F` precedent.
**Verdict: SOUND for all nine contracts.** Two couplings it found that this file did not previously
cover are recorded under "Known gaps" above.

**The ladder, and the one check it gained.** Both ladders pass **20/20** — `npm run smoke:dev` and
`npm run smoke` against the rebuilt artifact. (The `19/19` readings elsewhere in this file and in
`BOARD.md` are the runs of 2026-09-14, when the ladder had 19 checks; they are history and stay as
they were written.) Readings, all from the logs:

| Reading | Value |
| --- | --- |
| `the harness child is the installed DSH version` | `log=0.1.5-rc.3 installed=0.1.5-rc.3` — the **new** 20th check |
| `dsh: 0.1.5-rc.3 at …` | every launch |
| `the installed DSH changed: 0.1.5-rc.1 -> 0.1.5-rc.3` | exactly once, on the first launch after the upgrade |
| `cleared 1 stale launch-token cookie(s)` | both dev launches — the sweep still matches rc.3's cookie names, which is what keeps the HTTP-431 blank window from coming back |
| `ready: port=` | 54689, 64158 (dev ladder); 58329, 54615 (packaged ladder) — none of them 3080 |
| `interface mounted: true`, `HTTP 431` | mounted every launch; 0 oversized-header refusals |
| 3080's PID | 14972 before and after every run |
| `state.json` `lastDshVersion` | `0.1.5-rc.1` → `0.1.5-rc.3` |

Without the new check, "the ladder passed" and "the ladder ran the version that is installed now" are
two different claims, and this session had to establish the second by hand — so it became a check.
**It was falsified before it was trusted:** with the expected version planted as `0.0.0` the ladder
reported `FAIL  the harness child is the installed DSH version — log=0.1.5-rc.3 installed=0.0.0` and
`19/20 checks passed`, exit 1; restored, it is 20/20 again.

**The icon was measured, not inferred.** `tools/make-icon.mjs` draws the mark from
`dsh-web-frontend/dist/favicon.svg`, which is one of the byte-identical files above — but "so the icon
is unchanged" is a different claim from a measurement, so `npm run icon` was run twice: both runs wrote
`icon.png` `2E9D20F1…` and `icon.ico` `3E776B12…`, identical to each other and to the files already on
disk. Nothing to regenerate, nothing to keep, and the rasteriser is deterministic here.

**What was rebuilt.** `npm run pack` → `PACK OK`, all 11 structural checks plus `exe ProductName reads
back as "DSH Desktop"`, **367.6 MB**, and the exe now reports FileVersion/ProductVersion **0.1.1**
(taken from `package.json`, which moved 0.1.0 → 0.1.1 because a rebuilt artifact indistinguishable from
the one it replaces cannot be told apart). The two shortcuts were deliberately **not** re-created: they
point at the same exe path and carry no workspace argument, and `bin/shortcut.ps1` rewrites `Arguments`
unconditionally, so running it could only lose information.

**`npm run surface` exists because "nothing changed this time" should be checkable rather than
remembered.** `bin/dsh-surface.mjs` records sha256 for 12 coupling patterns (13 files) in
`docs/agent-notes/dsh-surface.json`, and reports `IDENTICAL / CHANGED / MOVED / MISSING` against the
installed DSH: `--record` re-baselines after a verification, `--against` checks against another baseline.
`CANNOT CHECK` (exit 2 — no install, no baseline, nothing compared) is deliberately distinct from a
change (exit 1), because "could not read it" must never read like "it is fine". **Falsified on copies**
of the baseline, never on the file in this tree: an altered sha → `CHANGED` + exit 1; a renamed hashed
file → `MOVED` + exit 1; a missing baseline → `CANNOT CHECK` + exit 2.

**One observation that is not resolved, and is not the shell's to resolve.** The last rc.1 run logged
**75 `[page:error]` lines in its final three minutes** (Lexical #14/#19/#20/#63/#66, 22:49:12–22:52:06)
while the user was working in the GUI — plausibly the reason DSH was updated at all. Under rc.3 the
ladder logs **0**, but the ladder mounts the interface and quits without touching the editor, so that is
not evidence the error is gone; it is evidence that the ladder does not exercise that path. Recorded
rather than claimed.

