/**
 * Where the window goes on the next launch.
 *
 * Extracted from `main.js` so the off-screen branch can be tested without
 * unplugging a monitor. That branch was the project's own open question — the
 * code rejects a saved position that no longer lands on an attached display,
 * and nothing had ever exercised it, because exercising it needed hardware that
 * the test machine cannot reconfigure mid-session.
 *
 * @module dsh-desktop/geometry
 */

/** The size used when nothing usable was saved. */
export const FALLBACK_SIZE = Object.freeze({ width: 1280, height: 860 });

/** The smallest window the app will restore; below this the saved size is ignored. */
const MIN_WIDTH = 640;
const MIN_HEIGHT = 480;

/** How much of the window must land on a display for it to count as reachable. */
const MIN_VISIBLE_X = 80;
const MIN_VISIBLE_Y = 40;

/**
 * Decide the geometry for a new window.
 *
 * Three outcomes, and the middle one is the interesting case: a saved size with
 * a position that no longer exists on any attached display is restored as a
 * size only, so the window manager places it on the primary display instead of
 * somewhere the user cannot reach.
 *
 * @param saved - the `window` object from the state file, or anything at all.
 * @param displays - display descriptors carrying a `workArea`; injected so a
 *   test can describe a monitor layout that this machine does not have.
 * @param fallback - the size to use when nothing usable was saved.
 * @returns the bounds to construct with, and whether to maximize instead.
 */
export function chooseGeometry(saved, displays = [], fallback = FALLBACK_SIZE) {
  const sizeFallback = { width: fallback.width, height: fallback.height };
  if (saved === null || saved === undefined || typeof saved !== 'object' || Array.isArray(saved)) {
    return { bounds: sizeFallback, maximized: false };
  }

  const maximized = saved.maximized === true;
  const { width, height, x, y } = saved;
  const hasUsableSize =
    Number.isInteger(width) && Number.isInteger(height) && width >= MIN_WIDTH && height >= MIN_HEIGHT;
  if (!hasUsableSize) return { bounds: sizeFallback, maximized };

  if (!Number.isInteger(x) || !Number.isInteger(y)) {
    // No position was ever recorded: let the window manager choose one.
    return { bounds: { width, height }, maximized };
  }

  const reachable = displays.some((display) => {
    const area = display?.workArea;
    if (area === undefined || area === null) return false;
    return (
      x + MIN_VISIBLE_X > area.x &&
      y + MIN_VISIBLE_Y > area.y &&
      x < area.x + area.width &&
      y < area.y + area.height
    );
  });

  return reachable ? { bounds: { width, height, x, y }, maximized } : { bounds: { width, height }, maximized };
}
