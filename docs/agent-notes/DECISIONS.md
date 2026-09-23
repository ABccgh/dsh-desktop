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

## D-19: How is this repository published, when `git` cannot reach GitHub from this machine?

- **Decided:** create `ABccgh/dsh-desktop` **public** with `auto_init: true` via `POST /user/repos`,
  then push with `D:\DeepSeek Harness\bin\push-api-ref.ps1 -RemoteRepo dsh-desktop -Force` — using a
  **temporary copy** of that script with exactly one line corrected. `docs/agent-notes/` ships; it
  contains machine paths and candid commentary, and the user was told so before the push.
- **Because:** `git push` and `git clone` both fail at the TLS layer here
  (`CRYPT_E_NO_REVOCATION_CHECK`), while the HTTPS API works. The script reproduces a push over REST
  and verifies every object id it sends against `git`'s own value, ending with
  `remote tree == git rev-parse HEAD^{tree}` — which is the check that matters, because four earlier
  versions of that script wrote a *plausible-looking* body that was wrong.
- **The one-line correction, and why it is a defect in the source repo and not a preference:**
  `bf4c2ad` ("stop treating a first-parent miss as proof of divergence") rewrote
  `if (-not $remoteContainsLocalTip) { if (-not $Force) { throw … } }` into
  `if ($chain.Contains($localTip)) { … } else { if (-not $AllowUnrelated) { throw … } }`. The throw
  moved out of its `-Force` guard and `-Force` was not added to the condition, so **the flag the
  message tells you to pass no longer gets you past the message**. Measured, not inferred: `-Force`
  alone threw at `push-api-ref.ps1:258`, `-Force -AllowUnrelated` threw at `:275`
  (`remote history does not contain -RemoteBase `, empty) because `-AllowUnrelated` also disables the
  force branch at `:264`, and `-RemoteOnlyParent` needs a `-Base` it cannot use here. The correction
  restores the pre-`bf4c2ad` behaviour: `if (-not $AllowUnrelated -and -not $Force) {`.
  `D:\DeepSeek Harness` was **not** modified; the copy lives in `%TEMP%` and its diff against the
  original is that single line.
- **Rejected:** (1) editing the borrowed script in place — it is tracked content of another project
  with its own pack check; (2) a Contents-API bootstrap pushed with `-Force`, which leaves the
  bootstrap commit as the published history's ancestor; (3) `-RemoteOnlyParent`, which parents the
  first uploaded commit at the remote tip and therefore **drops this repository's root commit** —
  its range can never include a root by construction; (4) deleting `refs/heads/main` to re-enter
  `-Init`, which cannot work either: the script refuses that path outright at `:204`, and an
  unreferenced repository rejects `POST /git/blobs` with `409` (D-33).
- **Measured outcome:** all six commits round-tripped **SHA-identical** (`61ea7e4` … `42b8c99`);
  remote tree `5ed3d754bbc3d0856cbbc61bb1b237b591935a52` equals the local `HEAD^{tree}`; the pushed
  root has **0 parents**, so the `auto_init` commit is not in the ancestry. Local `git remote -v`
  stayed empty — the token was only ever `$env:GH_TOKEN` inside one process, never in a URL, a file,
  or a commit.
- **Reversed by:** fixing the guard in `D:\DeepSeek Harness\bin\push-api-ref.ps1`; after that the
  temporary copy should be deleted and the script used as it ships.

## D-20: Is D-14's "six named calls" still the count?

- **Decided:** no — **seven**. `src/settings-preload.cjs:18-33` exposes `read`, `save`,
  `chooseWorkspace`, `restartHarness`, `openPath`, `close` and `exportDiagnostics`; the seventh
  arrived with M4's diagnostics bundle. D-14 is append-only and was right on its date, so this entry
  supersedes the count rather than editing it.
- **Because:** a reader who trusts "six" looks for a missing call instead of a stale sentence.
- **Reversed by:** nothing; it is a count.

## D-21: How does the shell decide which language to show?

- **Decided:** `config.language` is one of `auto`, `zh`, `en`, and the default is **`auto`**. `auto`
  resolves through the same rule the web GUI's client uses: walk the system's ordered language list
  and take the first language whose **primary subtag** is one this shell ships
  (`@deepseek-ai/dsh-client-locale/lib/client.js:1344-1355` is the rule being matched). Measured on
  this machine: preferred `['zh-Hans-CN']` → `zh`, and the GUI's own renderer reports
  `["zh-CN","zh-Hans-CN"]`. An unknown id is refused in `config.mjs` rather than being coerced here,
  so a hand-edited file says so in the log instead of silently following the system.
- **Because:** the shell and the window it hosts must agree without coordination. `auto` is the only
  default that gives a Chinese user a Chinese application on first launch, and the primary-subtag rule
  is what makes `zh-CN`, `zh-TW` and `zh-Hans-CN` all work — the alternative (exact `zh` only) would
  have left the very machine this was built on in English.
- **Rejected:** (1) defaulting to `zh` — it would override an English user's own environment, and the
  GUI, being a separate program, would not follow; (2) shipping a `ja`-style language-pack plugin, which
  the GUI supports but which solves a problem nobody here has; (3) reading `app.getLocale()` instead of
  `getPreferredSystemLanguages()`, because the former is the locale *this app* resolved — after a
  `--lang` switch it reports the forced value, which is circular.
- **Reversed by:** measuring a case where the GUI and this resolver disagree on the same machine and
  the *GUI's* answer is the one users expect.

## D-22: When may the shell put `--lang` on Chromium's command line?

- **Decided:** **only for an explicit `zh` or `en`.** `auto` appends nothing at all, leaving Chromium
  to read the system locale itself.
- **Because:** `auto` means "follow the system", and a `--lang` switch is precisely the thing that
  stops it from doing so. Measured both directions: with `auto` on a `zh-CN` machine the log says
  `language: zh (setting auto, system zh)`; with `--language en` it says
  `language: en (setting en, system zh)`. *(The claim about the GUI that stood at the end of this
  sentence is false — see the correction below and D-24.)*
- **Rejected:** passing `--lang zh-CN` for `auto` as well — it looked harmless and is not: it would
  freeze the GUI's language at whatever the shell detected at first launch, so adding Chinese later in
  Windows would change the shell and not the window.
- **Correction (D-24):** the sentence that used to stand here — that the GUI "stays Chinese because
  Chromium's switch does not reach the harness, which runs as a separate process on the system Node" —
  is **false**. The harness being a separate process is irrelevant: the GUI is a renderer of *this*
  Electron instance, and the switch does reach it. See D-24.
- **Reversed by:** Chromium gaining a way to change its interface language at runtime, which would
  remove the restart requirement this decision is entangled with.

## D-23: Should the shell write the GUI's language preference into `$DSH_HOME/settings.yaml`?

- **Decided:** **no.** The shell never writes that file. Its own language lives in its own
  `config.json`, and the GUI's follows the system locale.
- **Because:** three reasons, each independently sufficient. (1) The shell's stated boundary is that it
  writes nothing under `$DSH_HOME` — it reads the profile and its own state lives under
  `%APPDATA%\DSH Desktop`. (2) That file is **shared** with the user's own long-running `dsh web` on
  3080 (measured: `/api/balance` and this very session read the same home), so writing a locale there
  would retitle a different application's interface, live. (3) It is the *harness's* preference
  mechanism, not the shell's; using it would make one settings window own two programs' language.
- **Rejected:** writing `locale.preference: zh` as a convenience, which is what the GUI's own README
  documents for a user — offered to the human, and refused by them in this session after the boundary
  was stated.
- **Reversed by:** the user asking for the GUI to be forced to Chinese *independently of their system
  locale*, which is the one behaviour this decision cannot produce; the change would then be a
  deliberate, permitted write, and would need to handle the concurrent `dsh web` on 3080.

## D-24: Does the shell's language choice reach the GUI?

- **Decided:** **yes, it does**, and the documents that said otherwise were wrong. The GUI is a
  renderer of *this* Electron instance — the harness child only serves its assets over loopback — so
  `app.commandLine.appendSwitch('lang', …)` moves `navigator.languages` for the page the GUI runs in.
  Measured in a real renderer of the same app: with `lang=en-US`, `NAVIGATOR=en-US | en-US,zh-Hans-CN`.
  The GUI's resolver walks exactly that ordered list
  (`@deepseek-ai/dsh-client-locale/lib/client.js:1344-1355`) and `~/.dsh/settings.yaml` holds no
  `locale` key to override it.
- **Consequence, stated plainly because it is what a user will see:** choosing `English` gives an
  English shell **and** an English GUI after a restart; choosing `中文` forces an English system's GUI
  to Chinese; only `auto` leaves the GUI alone. That is a coherent reading of "make the app English"
  and it is what the user asked for, which is why this is a documentation correction and not a code
  change.
- **Because the earlier claim was never checked.** It reasoned from "the harness is a separate
  process" — true, and irrelevant to the renderer's locale. It was written into D-22 and M6's notes as
  *measured*, and the smoke check that appeared to confirm it asserts only the shell's log line, so it
  could not fail. An adversarial review falsified it with a two-line probe; the lesson is recorded in
  `PROJECT.md`.
- **Rejected:** forcing `auto` to append `--lang` as a way to keep shell and GUI in lockstep — that is
  exactly what D-22 forbids, and it would break the one setting that means "follow the system".
- **Reversed by:** measuring that a Chromium renderer's `navigator.languages` no longer follows the
  app's `--lang` switch on this Electron line.

## D-25: Who owns the window title?

- **Decided:** **the shell does**, and it says so in the language it has chosen. `page-title-updated`
  is prevented, the pages' own `<title>` elements are never what the title bar shows, and the title is
  written by `win.setTitle(t('window.title'))` / `settingsWin.setTitle(t('window.settings'))`.
- **Because:** a page's `<title>` beats a BrowserWindow's `title:` option. Measured: a window created
  with `title: 'FROM-CONSTRUCTOR'` loaded the real `settings.html` and reported
  `win="DSH Desktop — Settings"` — the document's. So a static `<title>` would have left an English
  title bar on a Chinese window, and removing the guard (as this change first did, accidentally) would
  have handed the title to the hosted GUI — which declares itself `DeepSeek Harness` in
  `dsh-web-frontend/dist/index.html`.
- **Measured both halves, because they interact:** with the guard in place a page setting
  `document.title` does **not** change the title bar (`win` stayed `FROM-CONSTRUCTOR`, and stayed put
  after a later page-side change), while `win.setTitle()` from the main process does (`SET-FROM-MAIN`).
  Without the guard, the page wins. Both are asserted in `test/i18n.test.mjs`.
- **Rejected:** letting the page own its title and translating each `<title>` — it works, but it makes
  the hosted GUI the authority over the shell's window, and the GUI can rename it at any time.
- **Reversed by:** a reason for the GUI's own title to appear in the title bar, which would mean
  dropping the guard and translating the pages instead.

## D-26: What may a dictionary push overwrite?

- **Decided:** **not the status line, and not a live failure.** `loading.html`'s apply hook skips
  `#status` and then re-renders the status from a remembered `{ key, text, isError, params }`;
  `settings.html` re-renders its own line the same way. The main process pushes the dictionary to the
  **main window** on `did-finish-load`, before any status.
- **Because each half was measured as a defect, not imagined:**
  - Without the skip, opening the Settings window re-pushed the dictionary to the main window, and the
    apply hook wrote `page.starting` over `#status` — a boot-timeout message became "正在启动 DeepSeek
    Harness…" with the red error styling still applied and nothing left to restore it, because
    `surfaceFailure` shows no dialog in that state and the supervisor has already given up.
  - Without the push on the main window, `strings` stayed `{}` there, so the failure page's hint fell
    back to English — on a Chinese page, in the one screen a user sees when the harness will not start.
  - A status pushed *before* the dictionary rendered English for the same reason, which is why the
    push precedes the first status.
  - Passing the message **id** alongside the resolved text is what lets a live language switch
    re-render the sentence; without it the failure kept the language it was pushed under.
- **Rejected:** clearing `#status` on a push instead of skipping it — an empty status line is a silent
  failure, which is worse than a stale one.
- **Reversed by:** nothing; each clause is a measured regression.

## D-27: What happens to the launch-token cookies an earlier run left behind?

- **Decided:** the shell **sweeps them at startup**, before its own window exists: every cookie for
  `http://127.0.0.1/` whose name starts with `dsh-auth-` is removed. The persistent partition itself is
  kept — the GUI's localStorage (theme, layout) lives in it and is the reason the partition exists.
- **Because the jar grows without bound, and the failure is silent.** The GUI's server mints a cookie
  whose **name** carries the launch authority (`dsh-auth-<43 chars>`), and the authority changes every
  launch because the port does. So each run adds a cookie rather than replacing one, and nothing ever
  removed them. Measured: **70 rows** had accumulated, and at that size the token exchange answered
  **HTTP 431 (Request Header Fields Too Large)** — the window then mounted nothing and reported no
  error of its own, which is the least diagnosable failure this shell has. It surfaced as
  `FAIL the interface mounted` in the packaged ladder after repeated smoke runs had exhausted the jar.
- **Measured after the fix:** the sweep logs `cleared 1 stale launch-token cookie(s)`, the jar holds
  exactly **one** cookie — the current run's — and stays at one across three further launches, all
  19/19. The ladder now carries a check for `HTTP 431` so the symptom cannot come back unnoticed.
  *(Why "cleared 1" rather than 70: `session.cookies.get({url})` returns only what that URL would
  send, so the sweep removes what is actually stale for this origin; the jar's own count is what
  shows the growth has stopped, and that is what was measured.)*
- **Rejected:** clearing the whole partition on startup — it would work and would also throw away the
  GUI's theme and layout, which the partition exists to keep; and clearing by port, which changes every
  launch and so cannot name a stale entry.
- **Reversed by:** the harness minting a constant cookie name, which would make the sweep unnecessary
  rather than wrong.

## D-28: What happens to a config key that nothing reads?

- **Decided:** **`maxWindows` is deleted**, and **`notifyOnFailure` is wired up**. A key in
  `DEFAULT_CONFIG` must have a reader somewhere in `src/` or `bin/`, and a test now fails when one does
  not.
- **Because both had shipped as validated settings that nothing read**, and the difference between them
  is only which fix was right. `maxWindows` ("Workspace windows") was defaulted, validated over 1–8
  and rendered in the settings form while no code read it — the project's own notes called it "a
  control that silently does nothing is worse than an absent one" and then left it there for three
  milestones. `notifyOnFailure` promised a tray notification when the harness gives up, and that
  promise was implementable in about fifteen lines: `tray.displayBalloon` was probed on this machine
  and answered `DISPLAY_BALLOON ok`.
- **Where the balloon call goes is part of the decision.** At the **top** of `surfaceFailure`, before
  its two early returns: the case a tray balloon exists for is the window being gone, hidden, or never
  loaded, which is exactly where those returns bail out. It is wrapped in try/catch and does nothing
  without a tray, because a balloon is a Windows shell feature that can be suppressed by notification
  settings or quiet time — the dialog, or the loading page, stays the path allowed to matter.
- **Rejected:** (1) hiding `maxWindows` behind `hidden` in the schema — it would still be a promise in
  `config.json`; (2) leaving both and documenting them — a visible dead control is worse than an absent
  one, which is this project's own words; (3) deleting `notifyOnFailure` too, which was cheaper but
  threw away a real capability that the probe showed was available.
- **Reversed by:** M3 arriving and needing the key back. It should come back **with** its reader in the
  same change, or the test will refuse it.

## D-29: Which language does the published repository speak?

- **Decided:** **English for the code, comments, commit messages and `docs/agent-notes/`; both for the
  README.** `README.zh.md` was added and the two link to each other.
- **Because the product speaks Chinese and the repository spoke only English.** A user who reads the
  application has no reason to be unable to read how to install it, and a README is the cheapest thing
  in a repository to duplicate. The engineering record is different: it cites symbols, log lines and
  commands in English, and a translation would be a second copy to keep in step for no reader.
- **The notes ship, with their absolute paths.** `docs/agent-notes/` contains `D:\dsh-desktop` and
  `C:\Users\曦曦\...`, candid self-criticism, and the history of several wrong turns. That was put to the
  user in this session, twice — D-19's entry reports the first time — and the answer was to publish
  them. Recorded here so the next person does not have to guess whether it was an oversight.
- **Rejected:** (1) sanitising the paths out of the notes, which would mean rewriting the record and
  breaking the citations that make it useful; (2) moving the notes to a private repository, which would
  hide the measurements from the people most likely to need them.
- **Reversed by:** the user deciding the notes should not be public. The mechanical form of that is
  `git rm -r --cached docs/agent-notes`, an ignore rule, and a note in `PROJECT.md` pointing at wherever
  they live instead — not a rewrite of history.

## D-30: After a DSH upgrade, what does the shell have to change?

- **Decided:** **nothing in `src/` — by design** — and the update is a procedure rather than an edit:
  prove which DSH the app actually runs, re-run the ladder, then re-record the coupling surface. The
  one code addition is a *check*, not a fix: `bin/smoke.mjs` now asserts the child it started is the
  installed version. `bin/dsh-surface.mjs` (`npm run surface`) turns "the surface is unchanged" into a
  command with an exit code.
- **Because the shell pins no DSH version on purpose.** `resolveInstallAnchor` resolves
  `$DSH_HOME/profiles/node_modules/@deepseek-ai/dsh` through `realpathSync` on every launch, so the
  junction the harness maintains is the single source of truth and an upgrade arrives by itself.
  Pinning a version would let the shell disagree with the harness the user is actually running, which
  is the one failure that design exists to prevent.
- **The evidence for "nothing to change" is a byte comparison, not an opinion.** rc.1's tarballs were
  fetched from the npm registry and unpacked in memory, and every file the shell's contracts live in is
  byte-identical in rc.3 (table in `PROJECT.md`). An independent contract review read nine contracts
  against the installed rc.3 and returned **SOUND** for all nine. Then the ladder — the check that can
  actually refute the claim — passed **20/20 from source and 20/20 from the packaged build**, with the
  log naming `dsh: 0.1.5-rc.3` and `the installed DSH changed: 0.1.5-rc.1 -> 0.1.5-rc.3` firing once.
- **Why 0.1.1 instead of keeping 0.1.0.** The exe's FileVersion/ProductVersion come from
  `package.json`, and this milestone rebuilds the artifact. A rebuilt artifact that still calls itself
  0.1.0 is indistinguishable from the one it replaced, so the version is the only place the update can
  be seen. No behaviour changed, which is what a patch bump should mean.
- **The new ladder check was falsified before it was trusted.** With the expected version planted as
  `0.0.0` it reported `FAIL the harness child is the installed DSH version — log=0.1.5-rc.3
  installed=0.0.0` and exit 1; restored, 20/20 again. `npm run surface` was falsified the same way, on
  **copies** of the baseline: altered sha → `CHANGED` + exit 1, renamed hashed file → `MOVED` + exit 1,
  missing baseline → `CANNOT CHECK` + exit 2. A guard that has never been shown to fail is not a guard.
- **Rejected:** (1) pinning or vendoring `@deepseek-ai/dsh` — it contradicts the junction design above;
  (2) moving to `dist-tags.next` (0.1.7-rc.1) — the user said "latest", and `latest` is 0.1.5-rc.3;
  (3) regenerating the icon because an upgrade "probably" moved the mark — the favicon is
  byte-identical and two `npm run icon` runs reproduced the existing bytes, so the inference was
  replaced by a measurement whose answer was "nothing to do"; (4) re-running `bin/shortcut.ps1` — same
  target path, no workspace argument, and the script rewrites `Arguments` unconditionally; (5) letting
  the ladder or a test call `--record`, which would turn the baseline into a rubber stamp; (6) deleting
  the stale `maxWindows` key from the user's own `config.json` — unknown keys are dropped by design and
  the user's config is not ours to edit.
- **Reversed by:** the coupling surface genuinely moving. A `CHANGED` line from `npm run surface` is
  the signal, and each baseline entry's `why` names the shell-side reader to re-read first. If DSH ever
  ships a different ready-line format or renames the auth cookie, the reversal is a code change in the
  module that owns that contract (`src/url-line.mjs`, `src/main.js`) — never a relaxation of the check.
  The two couplings that remain unchecked are written down in `PROJECT.md`.

## D-31: What does this project do about a defect inside DSH's own client code?

- **Decided:** three things, and deliberately **not** a fourth. (1) Build the instrument the acceptance
  ladder lacks — `npm run probe` drives the real composer and reports page errors by code, with
  `--inject-error` falsifying the instrument itself. (2) Give the shell the one lever it actually owns:
  when a burst of one kind of page error arrives, **offer** to reload the interface (a question, never an
  automatic action). (3) Write `docs/agent-notes/UPSTREAM-dsh-composer-lexical.md` — evidence, mechanism,
  what was tried, what was not — to be forwarded. **Not:** edit the installed package.
- **Because the defect is in a published package, and every available local edit is worse than the bug.**
  `@deepseek-ai/dsh-client-ui-conversation/lib/client.js` lives in this machine's npx cache: editing it is
  reverted by the next DSH update, leaves the running harness byte-different from the published package
  with no record of how, and breaks the rule that this shell never writes under `%USERPROFILE%\.dsh`. A
  client plugin cannot reach the composer either — that package exports only `apply`/`inject`, so there is
  no surface to patch from outside. What *is* within reach is the shell's own window: it can say what is
  happening and rebuild the page.
- **Because "the ladder is green" was the actual failure here, and it was a missing instrument rather than
  a missing fix.** The ladder mounts the interface and quits without touching the editor, so a composer
  that threw 75 errors in three minutes passed it. The probe closes that gap with the steps that matter —
  focus, real input events, the `@` menu pick that creates a chip (measured: a real mouse press, because
  the row's handler is `onMouseDown` and `element.click()` never reaches it), and submit — and it reports
  what it could **not** drive as `UNREADABLE`, exit 2, never as 0.
- **The dialogue is a question because reloading costs something.** It rebuilds the editor (which is what
  clears the corrupt state) but discards an unsent draft. Both halves of that are in the message text, in
  both languages, and the log records the answer either way.
- **Measured, so the record does not have to be trusted:** rc.1 and rc.3 are byte-identical across all
  fourteen client bundles in the editor stack — the upgrade carried no fix — and the rc.3 probe run drove
  typing, a folder-form reference, a menu pick (chip inserted) and a submit with **0 page errors**. The
  burst was **not** reproduced; the claim/queue phase flip is the untested path.
- **Rejected:** (1) patching the cached package — see above; (2) a client plugin that monkey-patches
  another package's internals — no hook exists, and it would rot silently at the next upgrade; (3)
  auto-reload without asking — it loses a draft the user did not agree to lose; (4) making the composer
  part of the acceptance ladder — the ladder is the shell's contract with the harness, the composer is
  DSH's interface, and folding it in would add a slow check to the wrong gate; (5) waiting for upstream:
  the byte comparison proves an upgrade does not carry the fix, and an unreproduced bug is not a report
  anyone can act on.
- **Reversed by:** a reproduction, in which case the report becomes a patch proposal with the editor state
  that triggers it; or a DSH release that changes `dsh-client-ui-conversation`, which `npm run surface`
  now reports (the composer's bundle is in the baseline) and after which the probe should be re-run before
  its old reading is quoted.



