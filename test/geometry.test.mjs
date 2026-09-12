import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FALLBACK_SIZE, chooseGeometry } from '../src/geometry.mjs';

/** A 1920×1040 primary display, and a second one to its right. */
const PRIMARY = { workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
const SECOND = { workArea: { x: 1920, y: 0, width: 1920, height: 1040 } };

test('nothing usable yields the fallback size and no position', () => {
  for (const saved of [null, undefined, [], 'nope', 42, true]) {
    assert.deepEqual(chooseGeometry(saved, [PRIMARY]), { bounds: { ...FALLBACK_SIZE }, maximized: false });
  }
});

test('a size without a position is restored without one, so the OS places it', () => {
  assert.deepEqual(chooseGeometry({ width: 1000, height: 700 }, [PRIMARY]), {
    bounds: { width: 1000, height: 700 },
    maximized: false,
  });
});

test('a size with a reachable position keeps the position', () => {
  assert.deepEqual(chooseGeometry({ x: 100, y: 50, width: 1000, height: 700 }, [PRIMARY]), {
    bounds: { x: 100, y: 50, width: 1000, height: 700 },
    maximized: false,
  });
});

test('the branch this project could never exercise: a display that is gone', () => {
  // Saved on the second monitor while it was attached.
  const saved = { x: 2000, y: 100, width: 1000, height: 700 };
  assert.deepEqual(chooseGeometry(saved, [PRIMARY, SECOND]).bounds, { x: 2000, y: 100, width: 1000, height: 700 });
  // Same file, monitor unplugged: the position must be dropped, not restored
  // somewhere the user cannot reach.
  assert.deepEqual(chooseGeometry(saved, [PRIMARY]), { bounds: { width: 1000, height: 700 }, maximized: false });
  // And with no displays reported at all.
  assert.deepEqual(chooseGeometry(saved, []).bounds, { width: 1000, height: 700 });
});

test('visibility is decided by the pixels that would actually be on screen', () => {
  const saved = (x, y) => ({ x, y, width: 1000, height: 700 });
  // 80 px must remain visible horizontally, 40 px vertically.
  assert.equal(chooseGeometry(saved(-79, 0), [PRIMARY]).bounds.x, -79, '79px of the left edge is enough');
  assert.equal(chooseGeometry(saved(-80, 0), [PRIMARY]).bounds.x, undefined, 'exactly 80px off is not');
  assert.equal(chooseGeometry(saved(0, -39), [PRIMARY]).bounds.y, -39, '39px of the top edge is enough');
  assert.equal(chooseGeometry(saved(0, -40), [PRIMARY]).bounds.y, undefined, 'exactly 40px off is not');
  // Entirely beyond the right and bottom edges.
  assert.equal(chooseGeometry(saved(1920, 0), [PRIMARY]).bounds.x, undefined, 'starting exactly at the right edge');
  assert.equal(chooseGeometry(saved(1919, 0), [PRIMARY]).bounds.x, 1919, 'one pixel of overlap counts');
  assert.equal(chooseGeometry(saved(0, 1040), [PRIMARY]).bounds.y, undefined, 'starting exactly at the bottom edge');
});

test('a display without a workArea is skipped rather than trusted', () => {
  assert.equal(chooseGeometry({ x: 10, y: 10, width: 800, height: 600 }, [{}, null, PRIMARY]).bounds.x, 10);
  assert.equal(chooseGeometry({ x: 10, y: 10, width: 800, height: 600 }, [{}, null]).bounds.x, undefined);
});

test('a size below the minimum is replaced, not restored', () => {
  for (const size of [{ width: 639, height: 700 }, { width: 1000, height: 479 }, { width: 0, height: 0 }]) {
    assert.deepEqual(chooseGeometry(size, [PRIMARY]).bounds, { ...FALLBACK_SIZE });
  }
  assert.equal(chooseGeometry({ width: 640, height: 480 }, [PRIMARY]).bounds.width, 640);
});

test('non-integer sizes and positions are refused', () => {
  assert.deepEqual(chooseGeometry({ width: 1000.5, height: 700 }, [PRIMARY]).bounds, { ...FALLBACK_SIZE });
  assert.deepEqual(chooseGeometry({ width: '1000', height: 700 }, [PRIMARY]).bounds, { ...FALLBACK_SIZE });
  // A bad position falls back to size-only rather than to the default size.
  assert.deepEqual(chooseGeometry({ x: 1.5, y: 2, width: 1000, height: 700 }, [PRIMARY]).bounds, {
    width: 1000,
    height: 700,
  });
});

test('the maximized flag survives every outcome, and only a real boolean counts', () => {
  assert.equal(chooseGeometry({ maximized: true, width: 1000, height: 700 }, [PRIMARY]).maximized, true);
  assert.equal(chooseGeometry({ maximized: true }, [PRIMARY]).maximized, true, 'maximized with no usable size');
  assert.equal(chooseGeometry({ maximized: true, x: 9000, y: 9000, width: 1000, height: 700 }, [PRIMARY]).maximized, true);
  assert.equal(chooseGeometry({ maximized: 'yes', width: 1000, height: 700 }, [PRIMARY]).maximized, false);
  assert.equal(chooseGeometry({ maximized: 1, width: 1000, height: 700 }, [PRIMARY]).maximized, false);
});

test('the returned bounds are a fresh object each call', () => {
  const first = chooseGeometry(null, [PRIMARY]);
  first.bounds.width = 1;
  assert.equal(chooseGeometry(null, [PRIMARY]).bounds.width, FALLBACK_SIZE.width);
});
