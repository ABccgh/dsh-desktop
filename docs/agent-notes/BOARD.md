# Board

## Objective

**DSH Desktop** at `D:\dsh-desktop` — a Windows desktop shell for DeepSeek Harness: one window
showing the user's own GUI, no browser chrome, no terminal, no server to start by hand.

Done and measured: the shell, the child supervisor, the tray/menu/loading surface, the icon, the
portable package, and the shortcuts. Every acceptance item below was run against the **packaged**
build, not just `npm start`.

## In progress

| Role | What | State |
| --- | --- | --- |
| — | Nothing in flight. This board is a snapshot of 2026-09-12. | — |

## Verified this milestone

| # | Item | How it was established |
| --- | --- | --- |
| 1 | Child spawned with the intended argv | Process table: `node.exe …\dsh\lib\bin.js --profile web --port 0 --no-open` |
| 2 | OS-assigned port, no collision logic | Ports seen across runs: 51906, 53868, 65467, 64640, 56461, 56154, 63036, 65120, 57510, 54886, 59980, 63692 — all different, never 3080 |
| 3 | Readiness captured from stdout | `[child] dsh web: http://127.0.0.1:<port>/?token=***` — token redacted |
| 4 | Auth fence intact | `GET /` with no cookie → **401** `dsh web authentication required…`; `GET /?token=…` → **303** + `Set-Cookie` |
| 5 | Token absent from log and state | Re-checked after a defect was found: no unredacted `token=` in either |
| 6 | User's 3080 instance untouched | PID **9420** identical before and after every launch and quit |
| 7 | Quit reaps the tree | `taskkill status=0` killed the child *and* grandchild `17928`; 0 Electron processes after |
| 8 | The window really renders | `loaded: http://127.0.0.1:<port> — interface mounted: true` |
| 9 | Packaged build works | Launched from the Desktop shortcut: navigated `HTTP 200`, mounted, window titled `DSH Desktop` |
| 10 | Second instance | Same single child pid, one main process, `second instance requested; focusing` |
| 11 | Crash restart | `child exited` → `restarting in 1000 ms (1/3 recent exits)` → new pid/port → mounted again |
| 12 | Workspace argument | `workspace: D:\dsh-desktop (from the command line)`, `spawn: cwd=D:\dsh-desktop`, remembered in `state.json` |
| 13 | Stale record is not a live process | `not reaping pid <n>: process is gone` — refused to touch a dead pid |
| 14 | Unit suite | `npm test` → 42 pass, 0 fail, 0 skipped |

## Open questions

1. **Does the shell work on a machine with no Node on PATH?** The child needs the system Node by
   design. The failure is diagnosed (`Node.js was not found on PATH…` with the directories searched)
   but has never been *seen*. The check: rename `node.exe` out of the way, or run on a clean VM, and
   read the window's error text.
2. **Does the crash loop actually stop?** The policy is 3 exits inside 60 s (`restartLimit`,
   `restartWindowMs`) and one restart was observed. The give-up branch is unit-tested, but the
   end-to-end stop has not been run. The check: kill the child four times in a row and confirm the
   window settles on the failure text with `It exited N times in a row`.
3. **Does window geometry restore on a second monitor that has since been unplugged?** The code
   rejects off-screen positions against `screen.getAllDisplays()`, and that branch has never been
   taken. The check: save geometry on a second display, unplug it, relaunch.
4. **Is `closeToTray` correct?** The option exists and defaults to `false` (close means quit). It has
   never been exercised with the value `true`. The check: set it, close the window, confirm the tray
   keeps the app and the child alive.
5. **Does `NODE_OPTIONS` in the environment deserve handling?** A packaged shell warns about it and
   passes it to the child, which benefits from `--use-system-ca`. Left as-is deliberately; revisit if
   the warning bothers anyone.

## Next

1. Run open questions 1–3; each is one launch plus one reading.
2. Push `D:\dsh-desktop` to its own repository when the user wants it published. `git push` does not
   work on this machine's network — the two-step route in `D:\DeepSeek Harness\AGENTS.md` applies,
   and this repository has no commits yet.
3. Only then consider an installer (NSIS via electron-builder) and a real exe icon; both need
   GitHub-hosted toolchain binaries, which is why the portable folder came first.
