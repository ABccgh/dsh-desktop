# Runbook

Every command runs from `D:\dsh-desktop` unless stated otherwise.

## Setup

```powershell
npm install                                     # installs deps; does NOT fetch the Electron binary
node node_modules/electron/install.js           # fetches + extracts it (see the note below)
```

**Why the second step exists.** `electron@44.3.0`'s published `package.json` has **no `postinstall`
script** — it exposes `install.js` as a bin (`"install-electron": "install.js"`) instead, so `npm
install` legitimately adds the package and stops. `node_modules/electron/dist` stays empty and
`require('electron')` still resolves, which is why the failure looks like a broken app rather than a
missing download. This project's own `postinstall` runs that script, so a plain `npm install` here is
enough; if you ever install with `--ignore-scripts`, run it by hand.

Behind a slow or filtered GitHub route, point the downloader at a mirror first (the variable names
are read by the installed `@electron/get@5.1.0`, `dist/artifact-utils.js:20-33`):

```powershell
$env:ELECTRON_MIRROR='https://registry.npmmirror.com/-/binary/electron/'; node node_modules/electron/install.js
```

## Test

```powershell
npm test                        # node --test test/  — whole suite
node --test test/args.test.mjs  # one file
node --test --test-name-pattern 'reaped' test/   # one test by name
```

## Run locally

```powershell
npm start                       # electron .
npm start -- "D:\some\project"  # start with that directory as the workspace
npm start -- --settings         # open with the settings window (no mouse needed)
```

Logs: `%APPDATA%\DSH Desktop\logs\app-<timestamp>.log` (child stdout/stderr included, prefixed
`[child]`). Settings: `%APPDATA%\DSH Desktop\config.json`. State: `state.json` in the same directory.
Timestamps are local with a UTC offset, so the file name agrees with the file's own modification time.

## Verify end to end

```powershell
npm run smoke         # the packaged build: 20 checks, exit code 0 when all pass
npm run smoke:dev     # the same ladder against `electron .`
```

The ladder is: readiness captured → the port is real and not 3080 → the interface mounted → no token
in the log → **the shell resolved a language and said which, and it is the system's or the one asked
for** → exactly one harness child on the right argv and port → **that child is the DSH version
installed right now** → an unauthenticated root request is refused → the user's own GUI is untouched →
quitting reaps the child and clears its record → **then a second launch with `--language en`**, which
must start its own harness, resolve to English on a Chinese system, and reap its child in turn.
It leaves the app running if it fails, deliberately, so the state can be inspected.

**The version check is what ties a green ladder to a DSH.** Without it, "the ladder passed" and "the
ladder ran the build that is installed now" are two different claims and only the first is machine
checked. The ladder reads the shell's own `dsh: <version> at <dir>` line and compares it with the
anchor's manifest, so a stale anchor or a child started from somewhere else fails instead of passing.

## Drive the composer (the ladder never touches it)

The acceptance ladder mounts the interface and quits, so it cannot see the editor at all — a composer that
threw 75 errors in three minutes once passed it. This drives the real editor in a real launch:

```powershell
npm run probe                     # type, open the @ menu, pick a candidate (inserts a chip); no submit
npm run probe -- --submit         # also press Enter: ONE REAL MODEL CALL, in a scratch workspace
npm run probe -- --inject-error   # self-test: throw 25 errors into the page and require the shell to react
npm run probe -- --keep           # leave the window open for inspection (then close it by hand)
```

What it prints, and how to read it: `selector` (which element it found), `typed via` (real input events or
the `insertText` fallback), `editor text` (proof the text landed), `chips` (a chip inserted by the menu
pick), `@ menu` (whether the menu opened and how many rows it offered), `page errors` (by code), and
`burst offer` (whether the shell decided this was a cascade).

**Exit codes are the point:** `0` the composer was driven; `2` **UNREADABLE** — nothing was compared (no
report line, the text never landed, the app never mounted), which is not a pass; `1` unhealthy (a burst
arrived, or with `--inject-error` the instrument saw nothing / the shell did not react). With
`--inject-error` the verdict is about the instrument, never about the composer — those errors are the
probe's own.

It creates a scratch workspace under `%TEMP%`, and puts `lastWorkspace` back afterwards so the user's next
launch does not open there. It refuses to start when another instance is running (that would take the
single-instance lock and produce a report about the wrong window).

Two side effects worth knowing before running it: the workspace is removed when the probe finishes, but a
`--submit` run leaves **one session** in the GUI's own workspace list (the GUI remembers its workspace in
its persistent partition, so that is where its sessions go) — remove it in the GUI if it matters. And the
probe does not delete anything under `%USERPROFILE%\.dsh`: that is the user's tree, and the shell's rule is
to write nothing there.

## After a DSH upgrade

The shell pins no DSH version: it resolves
`$DSH_HOME/profiles/node_modules/@deepseek-ai/dsh` through `realpathSync` on every launch, so an
upgrade is picked up by the next start with nothing to change here. What an upgrade *can* move is the
ground under the shell's contracts, and that is what these commands are for, in this order:

```powershell
npm run surface       # 1. is the coupling surface still the bytes last read and measured?
node --test test/     # 2. the pure half, ~0.4 s
npm run smoke:dev     # 3. a real launch; then `npm run pack` and `npm run smoke` for the artifact
npm run probe         # 4. the editor, which the ladder never touches (see the section above)
```

Read `surface` as a **trigger, not a verdict**: `CHANGED`/`MOVED` names files whose change means "go
and read them" — the `why` field in `docs/agent-notes/dsh-surface.json` says which shell-side reader
depends on each one — and only after reading and re-running the ladder does

```powershell
npm run surface -- --record      # re-record: a statement that the new bytes were verified
```

`--record` without that is a rubber stamp, and a rubber stamp is the failure mode this command exists
to prevent. A `CANNOT CHECK` line (exit code 2) means nothing was compared — it is not a pass, and it
must not be read as one.

Then confirm what actually ran, which is the one thing the exit codes cannot tell you:

```powershell
$log = Get-ChildItem "$env:APPDATA\DSH Desktop\logs\*.log" | Sort-Object LastWriteTime | Select-Object -Last 1
Select-String -Path $log.FullName -Pattern 'dsh: |installed DSH changed|ready: port=|interface mounted'
```

The expected lines are `dsh: <new version> at <dir>`, and — on the **first** start after the upgrade
only — `the installed DSH changed: <old> -> <new>`. Whichever launch happens first consumes that
notice, so if the ladder ran before you did, the line is in the ladder's log and your own start will
not repeat it.

**The language checks can only prove the shell's half, and that is worth knowing before trusting
them.** They read the resolved language out of the log; whether the *GUI* inside the window followed is
a separate question with a separate answer (D-24: an explicit choice does steer the GUI too, `auto`
leaves it to the system).

**One command starts a launch that takes the single-instance lock**, so before running the ladder check
nothing else is running:

```powershell
Get-Process -Name 'DSH Desktop','electron' -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,StartTime
```

A stale instance does not fail the ladder loudly — the new launch logs
`another instance owns the lock; exiting` and the ladder then reports its first check against the
*other* instance's log. Kill only pids you started, with `taskkill /PID <pid> /T /F`; never by name.

## Check the interface language

```powershell
# What the shell decided, and what it told Chromium. `auto` on a zh-CN machine must say zh.
Get-Content (Get-ChildItem "$env:APPDATA\DSH Desktop\logs\*.log" | Sort-Object LastWriteTime | Select-Object -Last 1).FullName |
  Select-String -Pattern 'language:'

# Force one run's language from the command line; this reads no settings and writes none.
npm start -- --language en
npm start -- --language zh

# Terminal output only, no window and no lock:
& node_modules\electron\dist\electron.exe . --help
& node_modules\electron\dist\electron.exe . --help --language en
```

The expected lines are `language: auto — Chromium keeps the system locale, so the GUI follows the
system too` (for `auto`), then `language: <zh|en> (setting <choice>, system <detected>)`.

**`--lang` does reach the GUI, and an earlier version of this file said it did not.** The GUI is a
renderer of this same Electron instance, so an explicit `zh`/`en` moves `navigator.languages` for the
page it runs in, and the GUI's own resolver follows that list: choosing English gives an English shell
**and** an English GUI after a restart. Only `auto` leaves the GUI to the system. See D-24.

## Check the tray balloon

```powershell
# notifyOnFailure shows a balloon when the harness gives up. It only appears if a tray
# exists (so build/icon.png must be present) and Windows notifications are not suppressed.
Get-Content (Get-ChildItem "$env:APPDATA\DSH Desktop\logs\*.log" | Sort-Object LastWriteTime | Select-Object -Last 1).FullName |
  Select-String -Pattern 'tray balloon|failure surfaced'
```

## Build and install

```powershell
npm run icon        # build/icon.png + build/icon.ico, from the installed DSH favicon
npm run pack        # dist\DSH Desktop\DSH Desktop.exe — portable, needs no extra toolchain
npm run shortcut    # Start Menu + Desktop .lnk for the packed app
```

### The installer target

```powershell
# electron-builder's own toolchain (NSIS) is fetched at build time, and the GitHub
# route is unreliable on this machine, so the mirror is required.
$env:ELECTRON_BUILDER_BINARIES_MIRROR='https://registry.npmmirror.com/-/binary/electron-builder-binaries/'
npm run installer   # dist-installer\DSH-Desktop-Setup-<version>.exe
```

`bin/pack.mjs` stays the primary path: zero dependencies, no network, and it is what
`npm run pack` produces. The installer exists because NSIS cannot be hand-rolled.

**The exe icon and version come from `rcedit`'s binary, called directly** — not its
JavaScript API. The published package ships `files: ["bin", "lib/index.d.ts"]`: the
binary is there and the wrapper is **not**, so `import { rcedit } from 'rcedit'` fails
with `Cannot find module .../rcedit.js`. The flags in `bin/pack.mjs` are the ones the
binary prints for itself (`--set-icon`, `--set-file-version`, `--set-version-string`),
and the build reads the result back with `--get-version-string ProductName`.

## Debug

```powershell
# Which harness child is OURS? Filter on node.exe, and on the spelled-out form.
# Two traps, both measured the hard way:
#  1. `Get-CimInstance Win32_Process | Where CommandLine -like '*…*'` matches the
#     pwsh process running the query itself, because its command line contains
#     the pattern text. Filtering by Name='node.exe' removes that.
#  2. The user's own `dsh web` runs the alias (`…\bin.js" web`) while this shell
#     launches the spelled-out flag (`…\bin.js" --profile web`), which is what
#     keeps the two apart.
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'bin\.js"?\s+--profile web' } |
  Select-Object ProcessId, CreationDate, CommandLine

# Confirm the user's own GUI is untouched (expect the same PID before and after)
(Get-NetTCPConnection -LocalPort 3080 -State Listen).OwningProcess

# A port's connections: filter by -RemotePort, NOT -LocalPort. The client's local
# port is ephemeral, so -LocalPort <harnessPort> shows only the listener and looks
# like "the request never went out" when it did.
Get-NetTCPConnection -RemotePort <harnessPort> | Select-Object LocalPort,RemotePort,State,OwningProcess

# What the shell did, and what the child said (token values are redacted)
Get-Content (Get-ChildItem "$env:APPDATA\DSH Desktop\logs\*.log" | Sort-Object LastWriteTime | Select-Object -Last 1).FullName -Tail 30
```

## Diagnose a window that will not load

```powershell
# Which network layer can reach the harness: Node's own fetch, Chromium's session
# stack, and the renderer. A renderer 200 means the cookie exchange completed;
# the other two are unauthenticated and correctly answer 401.
$env:DSH_DESKTOP_DIAG='1'; & 'dist\DSH Desktop\DSH Desktop.exe'
```

Read the result as `DIAG connectivity: nodeFetch=… | chromiumNet=… | renderer=…` in the log. If
**nothing at all** appears after `loading …`, do not look at the network: the main process is no
longer running JavaScript, which is the failure mode `DECISIONS.md` D-7 describes.

## Verify the whole thing in one pass

```powershell
# 1. baseline, then 2. launch, then 3. compare — the three commands in Debug above.
# 4. the fence: no cookie must be 401, and the token URL must answer 303.
$port = <from the log's "ready: port=">
Invoke-WebRequest "http://127.0.0.1:$port/" -SkipHttpErrorCheck | Select-Object StatusCode
```
