import assert from 'node:assert/strict';
import { test } from 'node:test';

import { shouldRestart } from '../src/restart-policy.mjs';

const WINDOW = 60_000;
const NOW = 1_000_000;

test('the first crash restarts', () => {
  assert.deepEqual(shouldRestart({ attempts: [], now: NOW, limit: 3, windowMs: WINDOW }), {
    restart: true,
    recent: [],
  });
});

test('restarts continue while the window holds fewer than the limit', () => {
  const attempts = [NOW - 1000, NOW - 2000];
  assert.deepEqual(shouldRestart({ attempts, now: NOW, limit: 3, windowMs: WINDOW }), {
    restart: true,
    recent: attempts,
  });
});

test('the third crash inside the window stops the loop', () => {
  const attempts = [NOW - 1000, NOW - 2000, NOW - 3000];
  const decision = shouldRestart({ attempts, now: NOW, limit: 3, windowMs: WINDOW });
  assert.equal(decision.restart, false);
  assert.equal(decision.recent.length, 3);
});

test('an exit just inside the window still counts, and just outside does not', () => {
  assert.equal(shouldRestart({ attempts: [NOW - WINDOW + 1, NOW - 1, NOW - 2], now: NOW, limit: 3, windowMs: WINDOW }).restart, false);
  // One millisecond older than the window: the count drops back below the limit.
  assert.equal(shouldRestart({ attempts: [NOW - WINDOW, NOW - 1, NOW - 2], now: NOW, limit: 3, windowMs: WINDOW }).restart, true);
});

test('pruning drops only the exits outside the window', () => {
  const decision = shouldRestart({
    attempts: [NOW - 10 * WINDOW, NOW - 5 * WINDOW, NOW - 100],
    now: NOW,
    limit: 3,
    windowMs: WINDOW,
  });
  assert.equal(decision.restart, true);
  assert.deepEqual(decision.recent, [NOW - 100]);
});

test('a limit of 0 refuses even the first restart', () => {
  assert.equal(shouldRestart({ attempts: [], now: NOW, limit: 0, windowMs: WINDOW }).restart, false);
});

test('the defaults match the config module', () => {
  const decision = shouldRestart();
  assert.equal(decision.restart, true);
  assert.deepEqual(decision.recent, []);
});
