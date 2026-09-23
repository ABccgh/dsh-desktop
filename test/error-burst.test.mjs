import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_BURST, classifyConsoleMessage, createErrorBurst, lexicalCodeOf } from '../src/error-burst.mjs';

/** A console message in the shape the GUI actually produced. */
const lexicalMessage = (code) =>
  `Uncaught Error: Minified Lexical error #${String(code)}; visit https://lexical.dev/docs/error?code=${String(code)} ` +
  `for the full message or use the non-minified dev environment for full errors and additional helpful warnings. ` +
  `(http://127.0.0.1:63408/plugins/??@deepseek-ai/dsh-client-ui-conversation/client.js&rev=b06fc3668b24:63857)`;

test('a Lexical message yields its code, and anything else yields null', () => {
  assert.equal(lexicalCodeOf(lexicalMessage(20)), 20);
  assert.equal(lexicalCodeOf('Uncaught TypeError: x is not a function'), null);
  assert.equal(lexicalCodeOf(undefined), null);
  assert.equal(lexicalCodeOf(42), null);
});

test('Lexical errors are bucketed per code, everything else shares one bucket', () => {
  assert.deepEqual(classifyConsoleMessage(lexicalMessage(14)), { kind: 'lexical', code: 14 });
  assert.deepEqual(classifyConsoleMessage(lexicalMessage(20)), { kind: 'lexical', code: 20 });
  assert.deepEqual(classifyConsoleMessage('Uncaught Error: boom'), { kind: 'other', code: null });
});

test('a handful of errors never interrupts, however they are spread', () => {
  const burst = createErrorBurst();
  for (let i = 0; i < 19; i += 1) burst.record(lexicalMessage(20), 1_000 + i * 10);
  assert.equal(burst.shouldOfferReload(1_000 + 190), false);
});

test('the threshold is reached only inside the window', () => {
  const inside = createErrorBurst();
  for (let i = 0; i < 20; i += 1) inside.record(lexicalMessage(20), 1_000 + i * 100);
  assert.equal(inside.shouldOfferReload(1_000 + 1_900), true);

  const spread = createErrorBurst();
  for (let i = 0; i < 20; i += 1) spread.record(lexicalMessage(20), 1_000 + i * 1_000);
  // 19 s apart: never 20 of a kind inside any 10 s window.
  assert.equal(spread.shouldOfferReload(1_000 + 19_000), false);
});

test('two different codes do not add up into one cascade', () => {
  const burst = createErrorBurst();
  for (let i = 0; i < 15; i += 1) burst.record(lexicalMessage(20), 1_000 + i);
  for (let i = 0; i < 15; i += 1) burst.record(lexicalMessage(63), 1_000 + i);
  assert.equal(burst.shouldOfferReload(1_020), false);
});

test('the latch makes it one interruption, not a stream of them', () => {
  const burst = createErrorBurst();
  for (let i = 0; i < 20; i += 1) burst.record(lexicalMessage(20), 1_000 + i);
  assert.equal(burst.shouldOfferReload(1_100), true);
  // Until the caller latches it keeps saying yes — it is the caller that acted.
  assert.equal(burst.shouldOfferReload(1_100), true);
  burst.markOffered();
  assert.equal(burst.shouldOfferReload(1_100), false);
  assert.equal(burst.offered, true);
});

test('the summary reports counts, the window and the threshold together', () => {
  const burst = createErrorBurst();
  for (let i = 0; i < 3; i += 1) burst.record(lexicalMessage(14), 5_000 + i);
  burst.record('Uncaught Error: boom', 5_010);
  const summary = burst.summary(5_100);
  assert.deepEqual(summary.byCode, { 14: 3, other: 1 });
  assert.equal(summary.total, 4);
  assert.equal(summary.windowMs, DEFAULT_BURST.windowMs);
  assert.equal(summary.threshold, DEFAULT_BURST.count);
  assert.equal(summary.worstKind, 'lexical:14');
  assert.equal(summary.inWindow, 3);
});

// ---------------------------------------------------------------------------
// The real thing: the 75 errors the desktop window logged on 2026-09-23, as
// (code, milliseconds since the first) — read back out of
// `%APPDATA%\DSH Desktop\logs\app-2026-09-23T19-30-37-439+08-00.log`.
//
// This is the regression that matters: the detector has to stay quiet through
// the eight input-driven transform loops and then speak up in the cascade,
// instead of the other way round.
// ---------------------------------------------------------------------------
const REAL_SEQUENCE = [
  [14, 0], [14, 1927], [14, 33714], [14, 37598], [14, 42224], [14, 49470], [14, 50000], [14, 52810],
  [66, 163670], [19, 163671],
  [20, 163672], [20, 163675], [20, 163676], [20, 163682], [20, 163683], [20, 163684], [20, 163725], [20, 163733],
  [20, 163733], [20, 163736], [20, 163764], [20, 163771], [20, 163772], [20, 163774], [20, 163833], [20, 163841],
  [20, 163842], [20, 163845], [20, 163884], [20, 163894], [20, 163895], [20, 163897], [20, 164093], [20, 164101],
  [20, 164102], [20, 164104], [20, 164173], [20, 164191], [20, 164193], [20, 164195], [20, 164422], [20, 164441],
  [20, 164442], [20, 164444], [20, 165022], [20, 165029], [20, 165030], [20, 165031], [20, 165033], [20, 165321],
  [20, 165322], [20, 165324], [20, 165325], [20, 165328], [20, 165498], [20, 165499], [20, 165500], [20, 165501],
  [20, 165507], [20, 165538], [20, 165586], [20, 165661], [20, 165662], [20, 165663], [20, 165664], [20, 165957],
  [20, 166078], [20, 166234], [20, 166249], [20, 174502], [20, 174504], [20, 174505], [20, 174508],
  [63, 174628], [63, 174780],
];

test('the real 2026-09-23 sequence: quiet through the transform loops, loud in the cascade', () => {
  const burst = createErrorBurst();
  let firstYes = null;

  for (const [code, at] of REAL_SEQUENCE) {
    burst.record(lexicalMessage(code), at);
    if (firstYes === null && burst.shouldOfferReload(at)) firstYes = { code, at };
  }

  const last = REAL_SEQUENCE[REAL_SEQUENCE.length - 1][1];
  const summary = burst.summary(last);
  assert.equal(summary.total, 75);
  assert.deepEqual(summary.byCode, { 14: 8, 19: 1, 20: 63, 63: 2, 66: 1 });

  // The eight #14s are 52.8 s apart end to end and never 20 of a kind inside a
  // window; a detector that spoke up here would have interrupted a user who was
  // merely typing.
  assert.equal(firstYes.code, 20);
  assert.ok(firstYes.at >= 163672 + 19, `it spoke up at ${String(firstYes.at)} ms, inside the #20 cascade`);
  assert.ok(firstYes.at <= 166249, 'and inside the cascade, not minutes later');
});
