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

