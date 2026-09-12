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
npm run smoke         # the packaged build: 12 checks, exit code 0 when all pass
npm run smoke:dev     # the same ladder against `electron .`
```

The ladder is: readiness captured → the port is real and not 3080 → the interface mounted → no token
in the log → exactly one harness child on the right argv and port → an unauthenticated root request
is refused → the user's own GUI is untouched → quitting reaps the child and clears its record.
It leaves the app running if it fails, deliberately, so the state can be inspected.

## Build and install

```powershell
npm run icon        # build/icon.png + build/icon.ico, from src/icon.svg
npm run pack        # dist\DSH Desktop\DSH Desktop.exe
npm run shortcut    # Start Menu + Desktop .lnk for the packed app
```

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
