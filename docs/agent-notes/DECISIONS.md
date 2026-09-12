# Decisions

Append-only. One entry per settled question, with the reason, the rejected alternative, and what
would reverse it. Never rewrite an entry; supersede it with a new one.

## D-1: Does the harness run inside Electron's main process, or in a child process?

- **Decided:** In a **child process on the system Node**. Electron owns the window and the child
  handle; it never boots a Cordis tree.
- **Because:** the harness installs a **process-level kill switch**.
  `installFailLoud` registers `process.on('unhandledRejection', handler)` and the handler calls
  `proc.exit(1)` (`@deepseek-ai/dsh-app-boot/lib/index.js:1401-1425`; the exits are at `:1409` and
  `:1420`, read directly). `runProfile` installs it at boot
  (`@deepseek-ai/dsh/lib/profile-boot-Dk-7KqJc.js:301-303`), alongside `process.on('SIGTERM'/'SIGINT')`
  (`:295-300`). In-process, any stray rejection anywhere in Electron — its own included — would exit
  the whole application, and no `Service`/`WebContents` wrapper can intercept `proc.exit`. A child
  contains that blast radius and is restartable. The confirming cost, measured separately: Electron
  44 ships **Node v24.18.1** (its release notes) while this machine runs **v26.8.1**, the runtime DSH
  0.1.5-rc.1 was installed and is exercised on.
- **Rejected:** in-process boot (which `loadProfileDirectory`, `dsh-app-boot/lib/index.js:843`, makes
  technically easy). It buys nothing here for a second, independent reason: upstream's `file://`+IPC
  plan (`dsh-host-webserver/README.md:12`) has no frontend behind it — the shipped bundle
  `@deepseek-ai/dsh-web-frontend` publishes only `dist/`, and a scan of that dist for
  `electron|ipc|__DSH_IPC|file://` returns zero hits — so the UI would still be served over HTTP from
  a `webServer` the web app hard-requires (`dsh-web-app/lib/index.js:96-98`).
- **Reversed by:** a measurement showing Electron's bundled Node boots `dsh/lib/bin.js` **and** a
  process boundary inside that boot (so the fail-loud guard's blast radius is contained) **and** an
  accepted risk that a package bump breaks the instrumentation silently.

## D-2: Which profile does the desktop shell boot?

- **Decided:** The user's **existing `web` profile, unchanged** — no overlay file, no new profile.
- **Because:** it preserves everything the user already has (the `account-balance` badge and the
  `ima-kb` tools, both `insert:` rows in `$DSH_HOME/profiles/web/cordis.patch.yml`, and both `link:`ed
  into that profile), and nothing desktop-specific is needed: the browser handoff is already covered
  by `--no-open`, and the native folder picker already resolves on a loopback bind via
  `dsh-host-directory-picker-auto`.
- **Rejected:** (1) the reserved `desktop` profile — it is not merely reserved, it is **unreachable
  from a CLI child**: `rejectElectronProfile` errors for `--profile desktop` and for
  `plugin --profile desktop` (`@deepseek-ai/dsh/lib/bin.js:28-30,92,109`), and the launcher's only
  boot mode is `runProfile` (`:144-154`); it would also start with none of the user's plugins.
  (2) a custom non-`desktop` profile — it means re-`link:`ing both plugins for zero gain.
- **Reversed by:** a desktop-only host row becoming necessary. The seam is `--patch <file>`, which the
  launcher accepts after `--profile` (`dsh/lib/bin.js:101`) and applies **last** in the layer stack —
  but note it targets a *row id*, so it cannot add rows to a profile that does not exist, and a
  renamed id degrades to a warning rather than an error.

## D-3: How is the harness child terminated, given Windows has no signals?

- **Decided:** A **tree kill**: `taskkill /PID <pid> /T /F`. There is no graceful step, because there
  is none to take.
- **Because:** measured on this machine. A Node child that installs handlers for `SIGTERM`, `SIGINT`,
  and `SIGBREAK` never runs any of them: `child.kill(signal)` returns `true` and the exit event
  reports that signal while the handler's sentinel file is never written. Windows terminates the
  process outright. `child.kill()` alone would also strand the tool subprocesses the harness has
  already spawned, which is why `/T` matters. This matches what DSH itself does for Windows trees:
  `detached: platform !== "win32"` and `taskkill /PID <pid> /T /F`
  (`dsh-subprocess-local/lib/runner-launch-COYGu0Dl.js:1145-1146,842-851`).
- **Rejected:** `child.kill()` first and a tree kill only as a fallback — it trades a guaranteed
  orphan for nothing, since the "graceful" half never runs. Also rejected: claiming a clean shutdown.
  The harness's own shutdown path (`process.on('SIGTERM')`, `PROCESS_SHUTDOWN_TIMEOUT_MS = 5e3`) does
  not execute in this child, so in-flight disposal is lost; committed session-log appends are already
  on disk, so what is lost is teardown, not data.
- **Reversed by:** DSH gaining a control channel a supervisor can drive (a documented stdin command,
  or a shutdown RPC) — then the graceful path becomes available and should replace the tree kill.

## D-4: How does the shell learn the harness URL?

- **Decided:** By parsing the `dsh web: <url>` line from the child's **stdout**. No HTTP probe, no
  network call of any kind to discover readiness.
- **Because:** it is the documented supervisor contract —
  `dsh-web-app/README.md:80`: "supervisors RPC as soon as they observe the line" — the line is emitted
  by `console.log` after the Loader tree settles and the server has bound
  (`dsh-web-app/lib/index.js:200-203`), and it already carries the loopback port the OS chose and the
  process launch token. A probe would add a second, weaker readiness signal and could misread the
  fence's own `401` as failure.
- **Rejected:** an HTTP `GET /` probe (including a `net.request` prefetch).
- **Reversed by:** the line's format changing. Note the parser is strict on purpose: host must be the
  literal `127.0.0.1`, port must be present and in range, path must be `/`, and there must be exactly
  one non-empty `token`. **Correction recorded after a review claimed otherwise:** the token is
  **replayable**, not single-use. `authorizeIndex` re-mints the cookie on every valid
  `GET /?token=`, with no one-shot state (`dsh-client-connection/lib/index.js:386-425`), so a repeated
  load is harmless. The no-probe rule rests on the line being the better signal, not on token
  consumption.

## D-5: Where does the desktop app's source live?

- **Decided:** In its own repository at `D:\dsh-desktop`, **outside** `D:\DeepSeek Harness`.
- **Because:** the user chose it, and the DSH preset repository's own rule 7 says "this repo ships
  presets and nothing else"; its two prior out-of-repo precedents are the `dsh-account-balance` and
  `dsh-ima-kb` plugins, each in its own repository. Keeping this app out also means the app's
  packaging cannot affect that repository's published tarball.
- **Rejected:** a `desktop/` directory inside `D:\DeepSeek Harness` — it would require editing rule 7
  and the `files` allowlist, and a mistake in the latter is absent from the tarball while every local
  command still works.
- **Reversed by:** the user deciding the app should ship as part of the preset repository.

## D-6: How is Electron's binary obtained?

- **Decided:** An explicit install step, wired as this project's own `postinstall`:
  `node node_modules/electron/install.js`.
- **Because:** `electron@44.3.0`'s published `package.json` contains **no `scripts` field at all** —
  read from `node_modules/electron/package.json` after a clean install — and instead exposes the
  installer as a bin (`"install-electron": "install.js"`). So `npm install` exits 0, installs 13
  packages, and leaves `node_modules/electron/dist` **empty**; `require('electron')` still resolves,
  so the symptom is a broken-looking app rather than a missing download. The mirror variable names
  were re-read from the **installed** `@electron/get@5.1.0` (`dist/artifact-utils.js:20-33`):
  `npm_config_electron_mirror`, `NPM_CONFIG_ELECTRON_MIRROR`, `ELECTRON_MIRROR`.
- **Rejected:** relying on a transitive `postinstall` (there is none), and vendoring a prebuilt
  Electron directory.
- **Reversed by:** a future electron release restoring the `postinstall` script — then this step
  becomes redundant but harmless (the installer exits early when the dist is already correct).

## D-7: Why did the PACKAGED app hang on the harness URL when the development run worked?

- **Decided:** Every write to `process.stdout`/`process.stderr` goes through a guard, and both
  streams carry an `error` listener installed at startup. The log file is the log; the console is
  optional and must never be load-bearing. `log()` writes the file first, then the console, each in
  its own `try`.
- **Because:** measured, and the chain took a full afternoon to find, so each link is stated:
  1. **Symptom.** The packaged build showed the window on Chromium's own error page (title
     `Error`) while the child's readiness line had been received. The log ended at
     `loading http://127.0.0.1:<port>/`. There was no `did-fail-load`, no `did-navigate`, no
     finish, and — the tell — **neither the 20 s watchdog (`setTimeout`) nor the diagnostic's own
     8 s timeouts ever fired**, so the main process's event loop had stopped while the process
     stayed alive and its window kept the title `Error`. `CloseMainWindow()` returned `True` on a
     valid, `Responding` window and the app still would not quit.
  2. **The socket was a red herring twice.** The harness port showed only a `LISTEN` socket because
     `Get-NetTCPConnection -LocalPort <harnessPort>` filters the **local** port, and that
     connection's local port was different. Filtering by `-RemotePort` showed an `ESTABLISHED`
     connection to the harness — so the request did go out, and the fault was not the network.
  3. **Not the causes, each ruled out by measurement:** the `file://` loading page (a build that
     skipped it entirely failed identically), the persistent session partition (clearing it changed
     nothing, and the development build kept working throughout), Chromium's Local Network Access
     (the TCP connection was established, which a permission denial prevents), a missing network
     service (the `network.mojom.NetworkService` utility process was running), and `NODE_OPTIONS`
     (its value here is `--use-system-ca`; clearing it changed nothing).
  4. **The cause.** A packaged Windows GUI application has no console, and a supervisor that closes
     the stdout pipe makes `process.stdout.write` fail. Node emits an `error` event on the stream,
     and with no listener that is **fatal to the JavaScript context** — the process and its window
     survive, but no further JavaScript runs. The first `log()` call after the pipe broke threw out
     of whatever was executing, which is why the navigation began and then simply never finished.
     In development the same code path is attached to a real console, so nothing failed: the defect
     was reachable **only** in the packaged build, which is precisely why "it works with
     `npm start`" was not evidence.
  5. **The fix, verified.** Guarding the write and adding `process.stdout.on('error', …)` made the
     packaged app complete the navigation: `navigated (HTTP 200)`,
     `interface mounted: true`, and the three-layer probe answering
     `nodeFetch=HTTP 401 | chromiumNet=HTTP 401 | renderer=HTTP 200`.
- **Rejected:** the three explanations the evidence first suggested — a Chromium permission fence, a
  poisoned session partition, and `NODE_OPTIONS`. Each was tested and each was wrong; the socket
  being established and the timers being dead were the two observations that pointed at the main
  process itself.
- **Reversed by:** nothing plausible. Even if a future Electron stopped emitting the stream error,
  an unguarded write in a GUI process with no console would remain a defect waiting for the next
  missing stdout.

## D-8: Is `state.json` safe to read, given that it is read during module evaluation?

- **Decided:** No. It goes through `normalizeState` (`src/state.mjs`), which returns a plain object
  for anything that is not one and reports what it discarded — the treatment `config.json` already had.
- **Because:** `readJson` returns whatever the file parsed to, and a bare `null` is valid JSON. Every
  key is then read during module evaluation — `resolveWorkspace()` dereferences `state.lastWorkspace`
  at the top level — so the process died **before a window existed to report anything**, and before
  the menu that reveals the file's path was built. Executed counterexample: both `JSON.parse('null').window`
  and `.lastWorkspace` throw `TypeError`. Measured after the fix: with `state.json` containing `null`,
  the packaged app logs `state: state is not a JSON object (null); ignoring it` and starts normally.
- **Rejected:** trusting the shape because the app is the only writer. It is the only writer *while it
  runs*; a truncated write, a hand edit, or a crash mid-write is exactly when this file is read most
  eagerly — at the next start.
- **Reversed by:** nothing. Validating input read from disk cannot be made wrong by a later change.

## D-9: What identifies the child process the reaper is allowed to kill?

- **Decided:** The **whole recorded description** must match: the dsh entry path, the Node binary, the
  parent it was spawned from, the argv as one contiguous run, and the start time within ±10 s.
- **Because:** the process this must never kill is the user's own `dsh web`, which runs the same CLI
  entry file. The previous check was two substrings plus a time window, and the user's GUI was spared
  only by argv *spelling* — the npx shim spells the same file through `.bin\..\`, so the recorded path
  happened not to appear in it. That is a coincidence, not a check. The argv is matched as one run
  rather than token by token because a test caught that `--port 3080` contains both the recorded token
  `0` and `--port`; the joined string cannot be fooled that way.
- **Rejected:** two changes that look like strengthenings and are not. (1) Requiring
  `live.parentPid === process.pid` would refuse **every** real reap — a stale child's parent is the
  *previous* run of the shell, dead by definition — so the check compares against the **recorded**
  parent. (2) Hard-coding `--port 0` would silently stop reaping for anyone who pinned a port, which
  is why the record carries the argv instead.
- **Reversed by:** a future where the child is spawned through an intermediate process, changing what
  "the recorded parent" means.

## D-10: How does a failure reach the user once the interface has loaded?

- **Decided:** `surfaceFailure()` — the loading page keeps showing the message inline, and once the
  interface is up a native dialog carries it, with **Restart DSH / Show Logs / Dismiss**.
- **Because:** `showStatus` writes through `window.__dshSetStatus`, which exists only on the loading
  page. Once the GUI replaced it every status update was silently dropped, so a harness that gave up
  left a window retrying forever — indistinguishable from a GUI that is merely slow, which is exactly
  what `[connection] connection lost, retry #1..#3` in a real log looks like. Measured after the fix:
  the crash-loop run logged `giving up:` once, then `failure surfaced to the user:` once.
- **Rejected:** relying on a tray balloon alone; it is invisible when the window is in front, which is
  precisely when a user is watching the interface fail to respond.
- **Reversed by:** the interface gaining its own failure surface, which would make the dialog
  redundant rather than wrong.

## D-11: Should the harness GUI's own console output be logged?

- **Decided:** Only errors, truncated to 300 characters; everything else needs `DSH_DESKTOP_DIAG=1`.
- **Because:** measured, three page messages were 7962 characters — **29% of every byte the shell had
  ever logged** — and the longest single line was 2654 characters. It is also content the shell does
  not control, written to a file on disk.
- **Rejected:** keeping all of it, on the grounds that a failed boot needs the page's messages. Errors
  are still kept by default, and the truncation states how much it dropped rather than hiding it.
- **Reversed by:** the GUI gaining a log of its own that the shell can point at instead.

## D-12: What counts as a workspace on the command line?

- **Decided:** Only an absolute path that exists and is a directory; an explicit `--workspace <dir>`
  wins, and a bad one is refused rather than skipped.
- **Because:** Electron's own argv carries its app path, which is `.` under `npm start`; taking the
  first argument that names an existing directory made the shell adopt its own directory as the
  workspace. Refusing rather than falling through matters too — after a mistyped `--workspace`, any
  other absolute path in argv is a directory the user never named. Measured: a second launch naming
  `D:\dsh-desktop` switched the workspace, spawned a child with `cwd=D:\dsh-desktop` on a new port,
  and left exactly one window and one child.
- **Rejected:** resolving relative paths against `process.cwd()`; in a dev launch the app path *is* `.`,
  so that reading picks the application directory every time.
- **Reversed by:** nothing — the rule only ever narrows what is accepted.

## D-13: What must a test never do?

- **Decided:** Never call the real process inspector or the real killer. `reapStaleChild` takes
  `{ probe, kill }` so every test passes stubs, and the suite must run in well under a second.
- **Because:** the suite previously called `reapStaleChild` with no probe against a hard-coded pid,
  so `npm test` ran a real PowerShell query and would have run a real `taskkill /Tree /Force` had that
  pid been live. It passed only because the pid was gone on this machine — and it cost 534 ms, which
  is what a real subprocess spawn looks like. The suite now runs in ~0.3 s, and the disappearance of
  that 534 ms is the observable proof.
- **Rejected:** "it passed" as evidence. A test whose assertion is satisfied by machine state rather
  than by the code under test is not a test.
- **Reversed by:** nothing; this constrains the tests, not the code they cover.

## D-16: How is the executable given its own icon and version?

- **Decided:** By calling the **`rcedit` binary directly** with the flags it prints for
  itself — `--set-icon`, `--set-file-version`, `--set-product-version`,
  `--set-version-string <key> <value>` — and reading the result back with
  `--get-version-string ProductName`.
- **Because:** the published `rcedit@5.0.0` declares `files: ["bin", "lib/index.d.ts"]`.
  The vendored binary is there and the **JavaScript wrapper is not published at all**, so
  `import { rcedit } from 'rcedit'` fails with `Cannot find module .../rcedit.js` — and
  because `bin/pack.mjs` treats metadata as optional, the failure was a warning and a
  successful build, not an error. Verification is the binary's own getter rather than a
  PowerShell property read, because "rcedit exited 0" and "the exe now carries our
  version" are different claims. Measured after the change:
  `exe ProductName reads back as "DSH Desktop"`.
- **Rejected:** importing the wrapper (it does not exist), and going without metadata —
  the packaged app then wears Electron's icon and reports Electron's version in Explorer.
- **Reversed by:** rcedit publishing its wrapper again, at which point the import works and
  the binary call becomes an unnecessary detail rather than a necessity.

## D-17: Was the earlier evidence for "rcedit ships its own exe" sound?

- **Decided:** No — the conclusion was right and the **check was shaped by the hypothesis**.
- **Because:** the check listed the package's files with a filter of `\.exe$|package\.json$`,
  which matched exactly the two things being looked for and therefore could not reveal that
  no `.js` file is published. A filter that only looks for what you expect to see cannot
  falsify your expectation. The fact it *did* establish — the binary is vendored, so no
  GitHub download is needed — remains true and is what made the fix cheap.
- **Rejected:** treating "the file list contains an .exe" as "the package is usable".
- **Reversed by:** nothing. The lesson generalizes: when checking a package is usable,
  list what is **absent** as well as what is present.

## D-18: What identifies the harness child in the smoke test?

- **Decided:** Its **parent process** — the app process the smoke test itself spawned.
- **Because:** the previous check matched a global pattern across every `node.exe` on the
  machine, so an unrelated child — a leftover from an earlier run, or one belonging to a
  packaged instance sharing the same `userData` — made "exactly one harness child" pass or
  fail for a reason with nothing to do with the app under test. This was not hypothetical:
  it happened twice in one session, once as a phantom pass and once as a stray that had to
  be hunted down.
- **Rejected:** loosening the assertion to "at least one", which would make it always true.
  The parentage claim keeps the assertion exact.
- **Reversed by:** nothing; parentage is strictly more precise than a pattern match.

## D-14: How is the settings window built, and how does its page talk to the shell?

- **Decided:** Its own `BrowserWindow` loading a hand-written `src/settings.html`, with a
  **CommonJS** preload (`src/settings-preload.cjs`) exposing six named calls through
  `contextBridge`, under `sandbox: true` + `contextIsolation: true`.
- **Because:** the harness GUI belongs to the harness, so the shell must not inject a form into it;
  and this project has no bundler, so a hand-written page is the same shape `loading.html` already
  uses. The preload is CommonJS rather than ESM because a sandboxed preload is loaded as a classic
  script — and that was an **assumption, so it was probed rather than trusted**: on load the shell
  evaluates `typeof window.dshSettings` and logs the answer. Measured: `settings bridge: object`.
  The IPC surface names *operations*, never paths or commands; the only path-like argument is one of
  two fixed directory keys, and the settings object is rebuilt through `normalizeConfig` on the main
  side, so a compromised page cannot write anything the schema would not accept.
- **Rejected:** (1) a settings form inside the GUI — it would mean injecting into a page the harness
  owns; (2) `sandbox: false` with an ESM preload — a weaker sandbox for no gain, when the plain CJS
  preload works; (3) a generic "send this to main" channel — it would move the validation boundary
  into the renderer.
- **Reversed by:** an Electron release making sandboxed CJS preloads unavailable, which would force
  the `sandbox: false` branch. The probe that logs `settings bridge: …` is what would catch it.

## D-15: What does saving an empty settings field mean?

- **Decided:** "Leave it alone." An `undefined` field is dropped from the patch before validation;
  clearing a box does not reset that setting, and **Restore defaults** is the explicit way to do that.
- **Because:** the form cannot distinguish a box the user cleared from one it never populated, and
  the destructive reading is the one that silently changes a setting the user did not touch. Measured
  round trip: `save({})` re-normalised the current settings, reported `problems: 0`, and left
  `config.json` semantically identical.
- **Rejected:** treating empty as "fall back to the default" — that turns a mis-click into a lost
  setting that is not visible in the form afterwards.
- **Reversed by:** a form that can tell "cleared" from "absent", e.g. by always populating every box.



