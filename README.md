# DSH Desktop

A Windows desktop application for **[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)**:
one window with your own DSH interface in it — no browser chrome, no terminal, no server to start by
hand.

It is a **shell, not a second harness**. The harness runs as a child process on your own Node, booted
from your own `web` profile, which means your account balance badge, your tools, your settings and
your sessions are exactly the ones you already have. Nothing is copied, and nothing under
`%USERPROFILE%\.dsh` is rewritten by this app.

## What it does

- Launches the harness with `--profile web --port 0 --no-open`, waits for its readiness line, and
  loads the resulting loopback URL into a native window.
- **Never touches your own running `dsh web`.** The port is chosen by the operating system, so a
  collision is impossible; and the only process it ever terminates is its own child.
- Owns that child's whole life: starts it, restarts it if it crashes (three times in a minute, then
  it stops and says so), and tears down its entire process tree on quit.
- Tray icon, application menu, external links opened in your real browser, workspace folder picker,
  window position remembered.
- Keeps its logs and settings in `%APPDATA%\DSH Desktop`. The launch token that authenticates the
  window is used once and is redacted out of every log and state file.

## Install (portable)

```powershell
git clone <this repository> D:\dsh-desktop
cd D:\dsh-desktop
npm install          # installs Electron and fetches its binary (see RUNBOOK.md — one extra step)
npm run icon         # build/icon.png + build/icon.ico
npm run pack         # dist\DSH Desktop\DSH Desktop.exe
npm run shortcut     # Start Menu + Desktop shortcuts
```

Then double-click **DSH Desktop**.

Requirements: Windows 10/11 and **Node.js 22 or later on `PATH`** — the harness runs on your Node,
not on Electron's bundled one, by design (see `docs/agent-notes/DECISIONS.md` D-1).

## Development

```powershell
npm start                        # run from source
npm test                         # 42 assertions over the pure modules
npm start -- "D:\some\project"   # start with that folder as the workspace
```

Set `DSH_DESKTOP_DIAG=1` to have startup probe, and log, whether each network layer can reach the
harness. It is the first thing to reach for when the window does not load.

## Design, in one paragraph

Electron is only the shell. The harness is a child process on the **system Node**, because the
harness installs a process-level kill switch — `installFailLoud` turns any unhandled rejection into
`process.exit(1)` — which would take the whole application down if it shared Electron's process. The
window loads the URL the child prints, over loopback, with the process's own launch token; that token
is a credential for one session, so the app hands it to the window and never logs it. Termination is
`taskkill /T /F`, because measurement shows Windows never delivers the child a signal. See
`docs/agent-notes/` for the measurements behind each of those, including the four explanations that
turned out to be wrong.
