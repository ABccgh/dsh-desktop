# DSH Desktop

A Windows desktop application for **[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)**:
one window with your own DSH interface in it — no browser chrome, no terminal, no server to start by
hand.

It is a **shell, not a second harness**. The harness runs as a child process on your own Node, booted
from your own `web` profile, which means your account balance badge, your tools, your settings and
your sessions are exactly the ones you already have. Nothing is copied, and nothing under
`%USERPROFILE%\.dsh` is rewritten by this app.

## What it does

**The harness**

- Launches it with `--profile web --port 0 --no-open`, waits for its readiness line, and loads the
  resulting loopback URL into a native window.
- **Never touches your own running `dsh web`.** The port is chosen by the operating system, so a
  collision is impossible; and the only process it ever terminates is its own child — identified by
  its full recorded description (executable, parent, argv, start time), not by a name.
- Owns that child's whole life: starts it, restarts it if it crashes (three times in a minute, then
  it stops and says so), and tears down its entire process tree on quit.
- Remembers the window's size, position and maximised state, and repairs a remembered position that
  no longer lands on a connected monitor.

**Around it**

- Tray icon and application menu; external links open in your real browser; a folder picker for the
  workspace; optional close-to-tray.
- A **settings window** (`File → Settings…`) with a live view of the resolved Node, harness and log
  paths, and per-field validation — an empty field means "use the default" rather than zero.
- A **global hotkey** (default `Control+Alt+D`) and a **taskbar jump list** listing the workspaces you
  have opened, so a project is one right-click away.
- A **diagnostics bundle** (`Help → Export Diagnostics…`) — versions, resolved paths, window and
  config state, and the tail of the log, with tokens stripped.
- Command line: `--version`, `--help`, `--settings`, and a folder to use as the workspace.

**Privacy**

- Keeps its logs and settings in `%APPDATA%\DSH Desktop`. The launch token that authenticates the
  window is used once and is redacted out of every log and state file — including the wide spellings
  a diagnostic bundle would otherwise carry.
- Talks to nothing but the loopback URL it started.

## Install (portable)

```powershell
git clone https://github.com/ABccgh/dsh-desktop D:\dsh-desktop
cd D:\dsh-desktop
npm install          # installs Electron and fetches its binary
npm run icon         # build/icon.png + build/icon.ico, from the installed DSH favicon
npm run pack         # dist\DSH Desktop\DSH Desktop.exe
npm run shortcut     # Start Menu + Desktop shortcuts
```

Then double-click **DSH Desktop**. The result is a folder you can move anywhere; the shortcuts are
the only thing written outside it, and re-running `npm run shortcut` after a move repairs them.

To pin a shortcut to one project:

```powershell
pwsh -NoProfile -File bin/shortcut.ps1 -Name 'DSH Desktop - Atlas' -Workspace D:\atlas
```

Requirements: Windows 10/11 and **Node.js 22 or later on `PATH`** — the harness runs on your Node,
not on Electron's bundled one, by design (see `docs/agent-notes/DECISIONS.md` D-1).

## Development

```powershell
npm start                        # run from source
npm test                         # 79 assertions over the pure modules, ~0.3 s
npm run smoke                    # the acceptance ladder against the packaged build
npm start -- "D:\some\project"   # start with that folder as the workspace
npm start -- --settings          # open with the settings window showing
```

`npm run smoke` drives the packaged build and needs `npm run pack` first; `npm run smoke:dev` runs the
same ladder against `electron .`. Either way it is a real launch of the real thing, and takes about
half a minute.

Set `DSH_DESKTOP_DIAG=1` to have startup probe, and log, whether each network layer can reach the
harness. It is the first thing to reach for when the window does not load.

## Layout

| Path | What lives there |
| --- | --- |
| `src/` | The shell: Electron main, the child supervisor, the pure modules, the two pages |
| `bin/` | `pack.mjs` (portable build), `smoke.mjs` (acceptance), `shortcut.ps1` (integration) |
| `tools/make-icon.mjs` | SVG → PNG → ICO, with the payload size checked against the declared one |
| `test/` | `node --test`; every module that can be pure is pure so it can be tested without a disk |
| `docs/agent-notes/` | The measurements behind the design: runbook, chronicle, decisions, board |

## Design, in one paragraph

Electron is only the shell. The harness is a child process on the **system Node**, because the
harness installs a process-level kill switch — `installFailLoud` turns any unhandled rejection into
`process.exit(1)` — which would take the whole application down if it shared Electron's process. The
window loads the URL the child prints, over loopback, with the process's own launch token; that token
is a credential for one session, so the app hands it to the window and never logs it. Termination is
`taskkill /T /F`, because measurement shows Windows never delivers the child a signal. See
`docs/agent-notes/` for the measurements behind each of those, including the four explanations that
turned out to be wrong.

## Status

Working and verified on Windows 10/11 with DSH 0.1.5-rc.1, Node 26.8.1 and Electron 44.3.0. Two
things are deliberately unfinished and are recorded rather than hidden: there is **one window and one
workspace at a time** (multiple windows are designed but not built), and the `electron-builder` NSIS
installer target is **configured but never built** — `bin/pack.mjs` is the supported path.

## License

MIT — see `LICENSE`.
