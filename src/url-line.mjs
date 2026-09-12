/**
 * The readiness contract with the harness child, and the only place that
 * understands its text form.
 *
 * The child is `dsh --profile web`, whose glue plugin prints exactly one URL
 * line after the Loader tree settles and the server has bound:
 *
 *   `dsh web: http://127.0.0.1:54321/?token=<hex>[ (LAN: http://…)]`
 *
 * Source of the format: `@deepseek-ai/dsh-web-app/lib/index.js:200-203`
 * (`console.log("dsh web: " + authenticatedUrl)`, the LAN suffix appended only
 * when the bind sampled a LAN address, which never happens for the loopback
 * bind this app uses). The URL carries the process launch token, which
 * `dsh-web-app/README.md:80` names as the supervisor signal: "supervisors RPC
 * as soon as they observe the line".
 *
 * This parser is deliberately strict: a line that does not look exactly like a
 * loopback root URL with one token is not a readiness signal, and treating one
 * as such would navigate the window at the wrong thing.
 *
 * @module dsh-desktop/url-line
 */

/** The stdout prefix emitted by the web app's glue plugin. */
export const URL_LINE_PREFIX = 'dsh web:';

/**
 * Parse one line of child stdout as the web app's readiness line.
 * @param line - a single line, without its trailing newline.
 * @returns the token-bearing loopback URL, or null when this is not that line.
 */
export function parseUrlLine(line) {
  if (typeof line !== 'string') return null;
  const trimmed = line.trim();
  if (!trimmed.startsWith(URL_LINE_PREFIX)) return null;

  // The LAN suffix, when present, is space-separated after the root URL, so the
  // URL itself is the first whitespace-delimited token.
  const rest = trimmed.slice(URL_LINE_PREFIX.length).trim();
  if (rest === '') return null;
  const token = rest.split(/\s+/)[0];

  let url;
  try {
    url = new URL(token);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:') return null;
  if (url.hostname !== '127.0.0.1') return null;
  // `--port 0` always yields a real port; an absent one means this is not a
  // bound server's URL.
  if (!/^\d+$/.test(url.port)) return null;
  const port = Number(url.port);
  if (port < 1 || port > 65535) return null;
  if (url.pathname !== '/' || url.search === '' || url.hash !== '') return null;
  const tokens = url.searchParams.getAll('token');
  if (tokens.length !== 1 || tokens[0] === '') return null;
  return url;
}

/**
 * Strip any launch-token value out of text bound for a log or a state file.
 *
 * The readiness line is logged so a failed boot can be read out of the log, but
 * the token in it is a live credential for this process's GUI session, and the
 * log is written to disk. So the line is logged, the token is not.
 *
 * The key is matched case-insensitively and the value runs to the next `&`,
 * whitespace, `)`, or the end of the string. The `)` is excluded because the
 * readiness line appends ` (LAN: <url>)` for a LAN bind, and a greedy value
 * class swallowed that closing parenthesis — caught by this module's own test
 * suite — making the logged line misreport which URL it held. Under-redacting
 * would be the worse error of the two, and the delimiter rule rules it out:
 * a launch token is `randomBytes(32).toString('base64url')`, i.e. `[A-Za-z0-9_-]`,
 * as the observed 43-character token confirms, so no `)` occurs inside one.
 *
 * @param text - any text that might carry a token.
 * @returns the text with every token value replaced by `***`.
 */
export function redactToken(text) {
  if (typeof text !== 'string') return text;
  return text.replace(/([?&]token=)[^&\s)]*/gi, '$1***');
}

/**
 * Strip anything that could be a launch token, with a deliberately wider net
 * than {@link redactToken}.
 *
 * Two rules, because a bundle that leaves the machine has a different budget for
 * false positives than a log that stays on it:
 *
 * 1. **Keyed**, in every spelling a URL, an argv, or a sentence can produce:
 *    `?token=`, `&token=`, `token:`, `TOKEN=`, `--token=`. `redactToken` only
 *    covers the `?`/`&` form, which is why this exists — a value carried by
 *    `--token <value>` walked straight through it.
 * 2. **By shape**: any run of exactly 43 base64url characters. A launch token is
 *    `randomBytes(32).toString('base64url')`, which is always 43 characters, so
 *    this catches a token that reached the bundle by a route no key named.
 *
 * The cost is stated: rule 2 will also redact an unrelated 43-character
 * identifier. That is the right trade for a file the user is about to paste
 * somewhere, and it is the opposite trade from the live log, which keeps
 * {@link redactToken} so its lines stay readable.
 *
 * @param text - any text that might carry a token.
 * @returns the text with token-shaped runs replaced by `***`.
 */
export function redactTokenLike(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/\btoken\s*[=:]\s*[^\s&,)"']*/gi, 'token=***')
    .replace(/[A-Za-z0-9_-]{43}/g, '***');
}

/**
 * Shorten text bound for the log.
 *
 * The harness GUI's own console output is diagnostic gold and log poison: one
 * measured message was 2654 characters, and three of them accounted for 29% of
 * every byte the shell had ever logged. The head is the part that identifies the
 * message, so the tail is truncated and the loss is stated rather than hidden.
 *
 * @param text - the text to shorten.
 * @param limit - the maximum length to keep, including the marker.
 * @returns the text, shortened if it was longer than the limit.
 */
export function truncateForLog(text, limit = 300) {
  const value = typeof text === 'string' ? text : String(text ?? '');
  if (value.length <= limit) return value;
  const marker = `…(+${value.length - limit} chars)`;
  // A limit smaller than the marker itself would otherwise return something
  // *longer* than asked for. Asserted by this module's own suite.
  if (marker.length >= limit) return value.slice(0, Math.max(0, limit));
  return value.slice(0, limit - marker.length) + marker;
}

/**
 * Whether a URL is one an external browser should be asked to open.
 *
 * Both places that hand a URL to the operating system take that URL from the
 * loaded page. Restricting the scheme is the whole policy: `file:` and custom
 * protocol handlers are what turn "the page opened a link" into "the page ran
 * something".
 *
 * @param url - the candidate.
 * @returns true only for http and https.
 */
export function isWebUrl(url) {
  if (typeof url !== 'string' || url === '') return false;
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Feed stdout chunks and report the first readiness line.
 *
 * Lines are reassembled across chunk boundaries because a pipe split can land
 * anywhere, including inside the URL.
 *
 * @param onUrl - called once, with the parsed URL.
 * @param onLine - called for every complete line, ready or not (for the log).
 * @returns an object taking chunks and reporting whether readiness already fired.
 */
export function createReadyScanner({ onUrl, onLine } = {}) {
  let buffered = '';
  let ready = false;

  return {
    /** True once a readiness line has been observed. */
    get isReady() {
      return ready;
    },
    /**
     * Consume one stdout chunk.
     * @param chunk - raw bytes or text from the child's stdout.
     * @returns nothing.
     */
    push(chunk) {
      buffered += chunk.toString();
      let index = buffered.indexOf('\n');
      while (index !== -1) {
        const line = buffered.slice(0, index).replace(/\r$/, '');
        buffered = buffered.slice(index + 1);
        onLine?.(line);
        if (!ready) {
          const url = parseUrlLine(line);
          if (url !== null) {
            ready = true;
            onUrl?.(url);
          }
        }
        index = buffered.indexOf('\n');
      }
    },
    /** Consume whatever is left after the stream ends (a final unterminated line). */
    flush() {
      if (buffered === '') return;
      const line = buffered.replace(/\r$/, '');
      buffered = '';
      onLine?.(line);
      if (!ready) {
        const url = parseUrlLine(line);
        if (url !== null) {
          ready = true;
          onUrl?.(url);
        }
      }
    },
  };
}
