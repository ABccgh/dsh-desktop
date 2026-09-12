/**
 * When to restart a crashed harness child, and when to stop trying.
 *
 * A pure function of the exit timestamps, so the boundary behaviour is testable
 * without waiting on a real process.
 *
 * @module dsh-desktop/restart-policy
 */

/**
 * Decide whether another restart is allowed.
 *
 * @param options - recent exit timestamps (ms since epoch, oldest first), the
 *   current time, the limit, and the window those exits are counted over.
 * @returns the decision and the exits still inside the window.
 */
export function shouldRestart({ attempts = [], now = Date.now(), limit = 3, windowMs = 60_000 } = {}) {
  const recent = attempts.filter((at) => now - at < windowMs);
  return { restart: recent.length < limit, recent };
}
