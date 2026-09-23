# Board

## Objective

**DSH Desktop** at `D:\dsh-desktop` — a Windows desktop shell for DeepSeek Harness: one window
showing the user's own GUI, no browser chrome, no terminal, no server to start by hand.

The work is the original five-milestone improvement plan, a sixth that split into the acceptance
ladder and the docs, and a seventh the user asked for afterwards. **M1, M2, M4, M5, M6 and M7 are
complete and verified; M3 is not started and the NSIS installer half of M5 has never been run.**

| Milestone | State |
| --- | --- |
| **M1** defects A1–A14, test hardening, `geometry`/`state` extracted | **done, verified** |
| **M2** settings window (F1) | **done, verified** |
| **M6 (part)** `bin/smoke.mjs` | **done, 19/19 checks pass** |
| **M4** CLI, hotkey, jump list, DSH version change, diagnostics export | **done, verified** |
| **M5** exe icon + version | **done, verified** (`exe ProductName reads back as "DSH Desktop"`) |
| **M5** NSIS installer | **config written, NEVER RUN** — `npm run installer` exists but has not been executed, so the NSIS toolchain and the produced installer are both unproven |
| **M3** multi-window | **NOT STARTED, NOT DESIGNED** — the largest item (973 lines, 113 references to one `win`); see below |
| **M7** the Chinese interface (`src/i18n.mjs`, a language switch, `--language`) | **done, verified end to end** — 101 tests, **19/19 on the packaged build** (`npm run smoke`) and 19/19 from source; reviewed adversarially, and the eight findings that survived re-checking are fixed — see D-21…D-27 |
| **Tidy-up** dead controls, stale docs, `README.zh.md`, publish | **done** — see D-28/D-29 and `PROJECT.md` |
| **DSH 0.1.5-rc.1 → rc.3** re-verify, rebuild the artifact, make the coupling surface checkable | **done, verified** — the coupling files are byte-identical, both ladders **20/20**, the icon measured (unchanged), the exe rebuilt at 0.1.1; `bin/smoke.mjs` gained a version check and `bin/dsh-surface.mjs` is new, both falsified. See D-30 and the section at the end of `PROJECT.md` |
| **The composer's 75 Lexical errors** | **diagnosed, instrumented, not fixed** — the throwing site (`dsh-composer`'s `onError` rethrow) and the mechanism are named in `PROJECT.md`; `npm run probe` now drives the real editor (typing, `@` menu pick → chip, submit) and produced **0 errors** on rc.3, so the burst was **not** reproduced; the shell offers a reload on a burst; the upstream report is `docs/agent-notes/UPSTREAM-dsh-composer-lexical.md`. See D-31 |

## M7, after the adversarial review

An independent reviewer was given the change and told not to trust the author's claims. It returned
**unsound**: three high findings, each with an executed counterexample. All three were reproduced here
before being fixed, and the fixes were re-measured on the real pages rather than argued.

| Finding | Verified how | Fixed |
| --- | --- | --- |
| The main window was never given a dictionary, so the failure prefix and `<html lang>` stayed English | `pushStrings()` called only from `applyLanguage` and the *settings* window's load | `pushStrings()` before `pushStatus()` in the main window's `did-finish-load` |
| A dictionary push replaced a live failure with "Starting…" | `#status` carried `data-i18n="page.starting"` and the apply hook wrote over it | the hook skips `#status` and re-renders it from remembered state |
| The settings window's title bar stayed English | a page `<title>` beats `BrowserWindow`'s `title:` (measured: `win="DSH Desktop — Settings"` from a window created with `FROM-CONSTRUCTOR`) | `page-title-updated` prevented, title written by the shell (D-25) |
| The jump list kept the old language | `applyLanguage` never called `refreshJumpList()` | added |
| Validator notes rendered English inside a Chinese sentence | `normalizeConfig` produced finished sentences | notes are structured; `problemMessage` renders them (in the language now in effect) |
| **`--lang` does affect the GUI** — the docs said it did not | a probe measured `NAVIGATOR=en-US \| en-US,zh-Hans-CN` in a real renderer | D-24 supersedes D-22; `PROJECT.md` corrected |
| `--version` printed two English lines | — | translated (`version.bundled`, `version.nodeNote`) |
| `DSH_NODE`, `'not found'`, and raw keys could reach the screen | — | all three translated or removed |

**What the review cost, and why it was worth it:** its central finding was a *documentation* error
that no test could have caught — a claim marked measured, resting on reasoning rather than a
measurement. It also showed the smoke ladder's language check can only ever prove the shell's half,
which is now written down next to the check itself.
| **M6 (rest)** docs for M3/M5 | not started |
| **Publish** this repository to GitHub | **done** — `github.com/ABccgh/dsh-desktop`, `main` at `42b8c99`, remote tree equal to the local `HEAD^{tree}`; see D-19 |

## M7, the Chinese interface, as verified

Asked for as "可以让《dsh desktop》实现全中文吗", and the screenshot that came with it decided the
scope: the `Help` menu was English while the GUI behind it showed `工作区`.

| Item | Evidence |
| --- | --- |
| The GUI was already Chinese | Its resolver matches `navigator.languages` by primary subtag, and this shell's renderer reports `["zh-CN","zh-Hans-CN"]` — probed in a real Electron window, not inferred |
| The shell was entirely English | Every string was inline in five files; `role:` menu items render English labels on Windows whatever the locale |
| A dictionary that cannot go stale quietly | A paired test greps `main.js`/`harness.mjs` for `t('…')` and fails when either language is missing a key; it also checks that no message needs a value its call site never passes |
| Both pages in both languages | Rendered in an Electron window and inspected: 37/37 `data-i18n` nodes resolved, `lang=zh-CN`, form fields filled, `--lang`-style injection applied |
| The language switch works both directions | `language: zh (setting auto, system zh)` and `language: en (setting en, system zh)` — the second is the falsification: a forced language really overrides the system's |
| The CLI follows the language | `--help` prints Chinese under `auto` on this machine and English under `--language en` |
| Nothing was touched under `$DSH_HOME` | The GUI's own preference file is deliberately **not** written; the user's `dsh web` on 3080 was the same pid before and after every launch (D-23) |

## Closed: the dead control found while publishing

`maxWindows` was visible in the settings form (**Workspace windows**) and read by nothing:
`config.mjs` defaulted and validated it and `settings.html` rendered it, and no other file mentioned
the key for three milestones. **Removed.** It was M3's placeholder leaking into the UI, and M3 will
now re-create the key when it actually has two windows to count.

`notifyOnFailure` was in the same state and has been **wired up** instead: `surfaceFailure` shows a
tray balloon when the setting is on and a tray exists. Both are now guarded by a test that fails when
any key in `DEFAULT_CONFIG` has no reader — which is what should have caught them the first time.

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

1. **M3, the only milestone left** — multiple windows. Its first step is a design, not code: nothing
   in this tree describes the shape. Then `state.json` moves from one child record to many, which is
   the shape M1 defined.
2. **The `maxWindows` control**, with M3 or before it — see the gap above.
3. **The NSIS installer**, if a real installer is wanted: `npm run installer` has still never been
   executed, so nothing about that toolchain is known.
4. **A design question M3 forces:** A5 is fixed but unreachable while one window exists, and
   `did-finish-load` on Chromium's own error page is still unanswered (open question 2 above). Both
   become live the moment a window can be reopened.
