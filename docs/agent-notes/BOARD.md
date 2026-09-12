# Board

## Objective

**DSH Desktop** at `D:\dsh-desktop` — a Windows desktop shell for DeepSeek Harness: one window
showing the user's own GUI, no browser chrome, no terminal, no server to start by hand.

The current work is the approved six-milestone improvement plan. **M1, M2, M4 and M5 are complete and
verified; M3 is not started and the NSIS installer half of M5 has never been run.**

| Milestone | State |
| --- | --- |
| **M1** defects A1–A14, test hardening, `geometry`/`state` extracted | **done, verified** |
| **M2** settings window (F1) | **done, verified** |
| **M6 (part)** `bin/smoke.mjs` | **done, 12/12 checks pass** |
| **M4** CLI, hotkey, jump list, DSH version change, diagnostics export | **done, verified** |
| **M5** exe icon + version | **done, verified** (`exe ProductName reads back as "DSH Desktop"`) |
| **M5** NSIS installer | **config written, NEVER RUN** — `npm run installer` exists but has not been executed, so the NSIS toolchain and the produced installer are both unproven |
| **M3** multi-window | **NOT STARTED** — the largest item (973 lines, 113 references to one `win`); see below |
| **M6 (rest)** docs for M3/M5 | not started |

## M4 and M5, as verified

| Item | Evidence |
| --- | --- |
| `--version` / `--help` | Printed and exited with **0 Electron processes** afterwards; they run before the single-instance lock, so they answer while another copy is running |
| Global hotkey | `global hotkey registered: Control+Alt+D`; an accelerator someone else owns logs a refusal instead of failing startup |
| Jump list | `jump list: ok (1 tasks)` — `setJumpList` **returns** its result, so the return value is logged rather than assumed |
| DSH version change | Logged when `lastDshVersion` differs; recorded in `state.json` |
| Diagnostics export | 7785 bytes, all six sections, **0 token leaks**; written by the same function the Help menu calls |
| Exe icon and version | `exe ProductName reads back as "DSH Desktop"`, read back with rcedit's own getter |
| Smoke child claiming | Now by **parentage**; a stray child can no longer make the assertion pass or fail for the wrong reason |

**Two lessons from this milestone are recorded as decisions.** D-16: `rcedit@5.0.0`
publishes `files: ["bin", "lib/index.d.ts"]` — the binary ships and the JS wrapper does
**not**, so the binary is called directly. D-17: the earlier check that "proved" rcedit was
usable listed files with a filter matching only what I expected to find, so it could not
have revealed the missing wrapper — a filter that cannot falsify is not a check.

**A related trap, measured the hard way:** the dev build (`electron.exe`) and the packaged
build (`DSH Desktop.exe`) share one `userData`, and therefore one single-instance lock. A
packaged instance left running at 15:15 silently rejected two later dev launches with
`another instance owns the lock; exiting`, and the child I killed as "a stray" was *its*
child, which its supervisor then correctly restarted. When a launch does nothing, check for
**both** process names before concluding anything.

## What M1 changed, and how each was proved

| # | Defect | Proof |
| --- | --- | --- |
| A1 | `state.json` holding `null` killed the app before any window existed | Poisoned the file; the app logged `state is not a JSON object (null); ignoring it` and mounted — **in the packaged build too** |
| A2 | The reaper identified a process by two substrings and a time window | The record now carries `nodeExe`, `parentPid` and `args`; `verifyStaleChild` matches the whole description, so the user's own GUI is refused by an intended check rather than by argv spelling |
| A3 | `npm test` could **tree-kill a real process** | The suite injects stubs; 72 assertions now run in **0.3 s**, and the disappearance of the old 534 ms PowerShell spawn is the proof |
| A4 | Quit cleared the child record before the child was known dead | `stop()` returns `{gone}`; the record is cleared only when the child is confirmed gone |
| A5 | A reopened window would sit on the loading page for ever | `createWindow()` navigates to a known `currentUrl`. **Latent**: unreachable in the single-window build; M3 makes it reachable |
| A6 | Every failure after the interface loaded was invisible | The crash loop now logs `giving up:` once **and** `failure surfaced to the user:` once |
| A7 | The GUI's console was logged whole | Three messages had been 29% of all log bytes; the run now logs **0** `[page:` lines by default |
| A8 | `shell.openExternal` accepted any scheme | `isWebUrl()` allowlist, unit-tested against ten refusals including `file:` and `javascript:` |
| A9 | A second launch's folder argument was ignored | A second launch naming `D:\dsh-desktop` switched the workspace, spawned a child with that `cwd`, and left one window and one child |
| A10 | Log timestamps were UTC, eight hours from the file's own mtime | The log name now matches its mtime to **0.2 min** |
| A11 | `bootTimeoutMs`'s floor sat below the measured boot time | Floor 5 s → 30 s; boot measured at 8.67–10.20 s over nine runs |
| A12 | Quit could stall for up to `graceMs` with no second attempt possible | An `abandon` race guarantees a path to `app.exit(0)` |
| A13 | `whenReady()`'s callback had no rejection path | `.catch()` logs and surfaces it |
| A14 | `restartWith` was re-entrant | An explicit guard; the old defence was incidental |

**Found while testing rather than in the plan:** with `closeToTray` on, a second launch *focused* a
hidden window without *showing* it, so a hidden window could not be reached at all. Fixed and
re-measured.

## Open questions

1. **A5 is fixed but not reachable in this build.** With `closeToTray` the window is hidden rather
   than destroyed, so `createWindow()` is on no live path. M3 makes it reachable; verify it there.
2. **Does `did-finish-load` fire for Chromium's error page?** If it does, `reportPageState` calls a
   failed navigation "the interface did not render" and `harnessPageLoaded` disarms the watchdog.
   One launch with the harness killed mid-load answers it.
3. **Is writing `state.json` on every window move a problem?** It is debounced 400 ms and unmeasured
   on a slow disk; the settings window (M2) makes the write frequency worth revisiting.
4. **Two windows on one profile (M3) is only partly protected.** The session write lease is a kernel
   lock (read in `dsh-session-persistence-jsonl`) and the credential file uses atomic replace, but
   shared `storage` JSON is last-writer-wins with no cross-process check — unmeasured.

## Next

1. M2: the settings window (`src/settings.html` + CJS preload + `contextBridge`). Its first step is
   the one-line probe the plan records as an assumption: log `typeof window.dshSettings` from the
   page, because a CJS preload under `sandbox: true` has not been verified on this build.
2. Then M3, which extends `state.json` from one child record to many — the shape M1 just defined.
3. `git push` does not work on this machine's network; the two-step route in
   `D:\DeepSeek Harness\AGENTS.md` applies. This repository has local commits only.
