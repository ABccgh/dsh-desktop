/**
 * Recognising the composer's failure shape in what the page reports.
 *
 * The GUI inside this window reports every uncaught error to the console, and
 * the shell already logs them. What it could not do until now is *notice a
 * shape*: on 2026-09-23 the composer's editor produced 75 errors in three
 * minutes — 8 input-driven `Lexical error #14` (a transform loop) and then 63
 * `#20` inside three seconds, each one a stale selection point — and the only
 * place that was visible was a log nobody was reading at the time.
 *
 * Pure by design: no Electron, no clock, no timers. `at` is a parameter, so
 * `test/error-burst.test.mjs` can replay the real 75-event sequence and assert
 * exactly when this would and would not have spoken up.
 *
 * What it is NOT: a diagnosis. It counts errors of one kind inside a window and
 * says "this looks like a cascade"; whether the editor is actually broken, and
 * why, is a question only reading the code and reproducing it can answer.
 *
 * @module dsh-desktop/error-burst
 */

/** When a burst is worth interrupting the user for, and how much history to keep. */
export const DEFAULT_BURST = Object.freeze({
  /** Errors of one kind inside the window that count as a cascade. */
  count: 20,
  /** The window, in milliseconds. */
  windowMs: 10_000,
  /** How many events to retain (a bound, so a long-running window cannot grow). */
  keep: 512,
});

/**
 * The Lexical error code inside a console message, if there is one.
 *
 * Lexical's production build replaces every message with a number, which is why
 * the log line names a code and nothing else — the meanings live in Lexical's
 * own `scripts/error-codes/codes.json` for the version in use.
 *
 * @param text - the console message.
 * @returns the code, or null when this is not a Lexical error.
 */
export function lexicalCodeOf(text) {
  const match = /Minified Lexical error #(\d+)/.exec(typeof text === 'string' ? text : '');
  return match === null ? null : Number(match[1]);
}

/**
 * Classify one console message into the kind a burst is counted by.
 *
 * Lexical errors are counted per code: a stream of `#14` and a stream of `#20`
 * are different failures, and merging them would let two unrelated problems add
 * up into one. Everything else shares one bucket, because the shell has no way
 * to tell which parts of the GUI an arbitrary error came from.
 *
 * @param text - the console message.
 * @returns `{ kind, code }`, where kind is `lexical` or `other`.
 */
export function classifyConsoleMessage(text) {
  const code = lexicalCodeOf(text);
  return code === null ? { kind: 'other', code: null } : { kind: 'lexical', code };
}

/**
 * Track recent page errors and decide when they look like a cascade.
 *
 * @param options - overrides for {@link DEFAULT_BURST}.
 * @returns the tracker: `record`, `shouldOfferReload`, `markOffered`, `summary`.
 */
export function createErrorBurst(options = {}) {
  const { count, windowMs, keep } = { ...DEFAULT_BURST, ...options };
  /** @type {{ kind: string, code: number|null, at: number }[]} */
  const events = [];
  let total = 0;
  let offered = false;

  /** The bucket an event is counted in. */
  const keyOf = (event) => (event.kind === 'lexical' ? `lexical:${String(event.code)}` : 'other');

  /**
   * Record one error-level console message.
   * @param text - the message.
   * @param at - when it arrived, in milliseconds.
   * @returns the classified event.
   */
  function record(text, at) {
    const event = { ...classifyConsoleMessage(text), at };
    events.push(event);
    total += 1;
    if (events.length > keep) events.splice(0, events.length - keep);
    return event;
  }

  /**
   * Counts by bucket, for the events inside the window ending at `at`.
   * @param at - the end of the window.
   * @returns the map of bucket to count.
   */
  function countsWithin(at) {
    const grouped = new Map();
    for (const event of events) {
      if (at - event.at > windowMs) continue;
      const key = keyOf(event);
      grouped.set(key, (grouped.get(key) ?? 0) + 1);
    }
    return grouped;
  }

  /**
   * Whether this is the moment to say something to the user.
   *
   * One-shot by construction: once `markOffered()` has been called this never
   * says yes again, so a window that keeps failing cannot keep interrupting.
   *
   * @param at - the end of the window.
   * @returns true when some one kind reached the threshold inside the window.
   */
  function shouldOfferReload(at) {
    if (offered) return false;
    for (const n of countsWithin(at).values()) if (n >= count) return true;
    return false;
  }

  /**
   * A printable account of what has been seen, for the log and the probe's
   * machine-readable report. Deliberately includes the window and the threshold
   * so a reader can tell "quiet" from "not measured the same way".
   *
   * @param at - the end of the window.
   * @returns the summary.
   */
  function summary(at) {
    const byCode = {};
    for (const event of events) {
      const key = event.kind === 'lexical' ? String(event.code) : 'other';
      byCode[key] = (byCode[key] ?? 0) + 1;
    }
    const counts = countsWithin(at);
    let worst = { key: null, n: 0 };
    for (const [key, n] of counts) if (n > worst.n) worst = { key, n };
    return {
      total,
      byCode,
      windowMs,
      threshold: count,
      inWindow: worst.n,
      worstKind: worst.key,
      offered,
    };
  }

  return {
    record,
    shouldOfferReload,
    summary,
    /** Latch: this window has had its one interruption. */
    markOffered() {
      offered = true;
    },
    get offered() {
      return offered;
    },
  };
}
