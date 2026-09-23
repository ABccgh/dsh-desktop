# Upstream report: the composer's Lexical errors (DSH Desktop, 2026-09-23)

**Status of this document:** written to be forwarded. It describes a defect in DSH's
own client code, not in DSH Desktop, and nothing here has been applied to the installed
harness — see "Why this is a report and not a fix".

Everything below is either a measurement (with the file or command that produced it) or
is explicitly labelled as read-but-not-reproduced.

## Where it was observed

| | |
| --- | --- |
| Host | DSH Desktop 0.1.1, Electron 44.3.0 (Chromium 152), Windows 11 |
| Harness | `@deepseek-ai/dsh` **0.1.5-rc.1**, booted by the desktop shell as a child process (`--profile web --port 0 --no-open`) |
| Instrument | the shell logs the GUI's console errors (`[page:error]`) into its own log |
| Log | `%APPDATA%\DSH Desktop\logs\app-2026-09-23T19-30-37-439+08-00.log` |

## What happened

75 uncaught page errors in the last three minutes of that session, all from the same
editor, in two clearly different phases — the timestamps are from the log:

| Time | Count | Codes | Gaps between them |
| --- | --- | --- | --- |
| 22:49:12–22:50:04 | 8 | `#14` | 1.93 / 31.79 / 3.88 / 4.63 / 7.25 / 2.81 s — **irregular, i.e. one per edit** |
| 22:50:04 → 22:51:55 | 0 | — | 110 s of silence (no input) |
| 22:51:55–22:51:58 | 61 | `#66` → `#19` → 59 × `#20` | 21 / 19 / 17 / 4 in consecutive seconds — **one cascade** |
| 22:52:06 | 6 | `#20` | a second, smaller wave |
| 22:52:09 | — | — | the user closed the application |

Codes, from Lexical 0.49.0's own `scripts/error-codes/codes.json` (the version bundled in
`dsh-client-ui-conversation`):

- `#14` — "One or more transforms are endlessly triggering additional transforms."
- `#66` — "Expected node %s to have a parent."
- `#19` — "updateEditor: selection has been lost because the previously selected nodes have been removed…"
- `#20` — "Point.getNode: node not found" (63 of the 75).

Reading the two phases together: the editor was already in a state where **every edit
looped the transform graph** (`#14`), and roughly a minute later a single event removed
nodes that a selection point still referenced, which then cascaded (`#66`/`#19`/`#20`).

## Where they are thrown

The log line's `(…:63857)` is a line number in the *concatenated* plugin bundle the
server serves for `/plugins/??…`. Rebuilding that concatenation from the 55 packages in
the URL — the rule is `buildCombo` in `dsh-client-modules/lib/index.js:278-314`: strip the
`sourceURL`/`sourceMappingURL` trailers, ensure a trailing newline, append `;\n` — puts
line 63857 at offset 12678 of `dsh-client-ui-conversation/lib/client.js`, which is:

```js
this.editor = ys({                        // 63853  (createEditor)
    namespace: "dsh-composer",
    nodes: [ReferenceChipNode, TextRefNode],
    onError: (error) => { throw error; }, // 63856-63858  ← line 63857
});
```

So the errors come from the **composer's** editor, and the reason they appear as uncaught
errors rather than being contained is that this `onError` rethrows what Lexical's error
boundary hands it. That is the reporting site, not the cause.

## The mechanism (read from the code — **not** reproduced)

The composer registers three things on that editor that can disagree with one another
(all line numbers are in `dsh-client-ui-conversation/lib/client.js`, DSH 0.1.5-rc.3):

1. **A text-entity transform pair** (`:12102-12154`, DSH's adaptation of Lexical's
   `registerLexicalTextEntity`). The `TextNode` transform replaces a matched span with a
   `TextRefNode`; the `TextRefNode` transform **reverts the node to plain text** unless
   its own acceptance test passes (`:12146-12149`): `getMatch(text) !== null &&
   r.start === 0 && text.length === r.end`. The revert is `f(t)` at `:12100-12101`
   (`t.replace(...)`).
2. **`getMatch`** (`:12294-12307`), which is where the acceptance test comes from. It
   skips a scan range **only** when the active claim token sits at offset 0 and equals the
   text (`:12298`) — a condition that changes with the *claim*, not with the text.
3. **The claim decoration** (`:12051-12069`) and `refreshClaimDecoration`
   (`:12077-12081`), which marks the first text leaf dirty precisely because "claims change
   phase without a text edit".

When those two predicates disagree about the same span — the live lexicon snapshot moves,
the claim token appears or clears, or the chip's text is a strict prefix of a longer match
— the span alternates chip → text → chip. Every swap replaces nodes, so any selection
point into that span refers to a key that no longer exists: `#20` for each subsequent
access, preceded by `#66`/`#19` at the moment of removal. That is a hypothesis that fits
the shape above; it is **not** a reproduction.

## Not fixed in 0.1.5-rc.3 (measured)

Comparing the rc.1 and rc.3 client bundles byte for byte (rc.1 pulled from the npm
registry and unpacked in memory, rc.3 read from the installation):

`dsh-client-ui-conversation`, `dsh-client-ui-input-trigger`, `dsh-client-ui-attachment`,
`dsh-client-ui-reference`, `dsh-client-ui-commands`, `dsh-client-ui-renderer`,
`dsh-client-ui-tool`, `dsh-client-ui-session`, `dsh-client-hmr`, `dsh-file-reference`,
`dsh-client-file-upload`, `dsh-skill`, `dsh-client-ui-skill`, `dsh-client-ui-sidebar-files`
— **all byte-identical**. The only difference anywhere in that stack is one CSS declaration
in `dsh-client-ui-chat/lib/client.js` (`.TS9iAW_actions` gained `margin-top:4px`).

So upgrading does not carry a fix for this, and any claim that the errors are gone needs
its own evidence.

## What has been tried here (so it need not be repeated)

`npm run probe` in `D:\dsh-desktop` drives the real composer in a real launch
(`--probe-composer` is a development-only switch in the shell) and reports page errors by
code. Against **0.1.5-rc.3**, in a scratch workspace:

- typing 20 characters with real input events (`sendInputEvent`) — lands, verified by
  reading the editor's text back;
- typing `@probe-target/` (folder grammar) and `@p`, which **opened the `@` menu with 70
  candidates**, then pressing the first option with a real mouse press at its coordinates
  — a reference chip was inserted (`chips: 1`);
- pressing Enter to submit — the composer cleared (`submitted: true`).

Result: **0 page errors** for the whole sequence, twice. The instrument itself is
falsified in the same script: `npm run probe -- --inject-error` throws 25 errors into the
page and requires the detector to see them (it does) and the shell to offer its reload
(it does).

What that means: ordinary typing, a chip insertion and a submit do **not** reproduce it.
The untested path is the one the timing implicates — the **claim/queue phase flip**: a
draft that contains a reference token while a message is queued, so the claim appears,
the decoration re-runs, and the claim clears without the text changing. A reproduction
probably needs a second submit while a turn is still running.

## Why this is a report and not a fix

The defective code is inside a published package in this machine's npx cache
(`…\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-client-ui-conversation`). Editing
it there would (a) be overwritten by the next DSH update, (b) leave the user's harness
byte-different from the published package with no record of how, and (c) violate the
desktop shell's own rule of never writing under `%USERPROFILE%\.dsh`. A client plugin
cannot patch it either: `dsh-client-ui-conversation` exports only `apply`/`inject`, so
there is no composer surface to reach from outside.

The shell side is covered as far as the shell can cover it: when a burst of one kind of
error arrives, the window now says so and offers to reload itself (which rebuilds the
editor; the conversation lives on the harness side and is not lost, an unsent draft is).

## The shape of a fix, for whoever owns this code

Not a patch — the reproduction is missing — but the contradiction is narrow and local:
the `TextRefNode` transform's acceptance test and `getMatch`'s claim skip must agree, or
the revert at `:12148` must not run while the text-ref transform would immediately
re-match the same span. Registering the pair with a guard that makes the revert
idempotent (or comparing the span against the same claim-aware predicate the creator
uses) is where the fix belongs.

What would settle it: a reproduction of the `#14` loop while typing (not at submit), or of
the `#20` cascade, with the editor's serialized state captured immediately before it.
