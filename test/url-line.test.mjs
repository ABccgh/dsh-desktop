import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createReadyScanner, isWebUrl, parseUrlLine, redactToken, truncateForLog } from '../src/url-line.mjs';

const GOOD = 'dsh web: http://127.0.0.1:54321/?token=9f2c1ab4d5e6';

test('parses the canonical readiness line', () => {
  const url = parseUrlLine(GOOD);
  assert.ok(url instanceof URL);
  assert.equal(url.origin, 'http://127.0.0.1:54321');
  assert.equal(url.port, '54321', 'the port is asserted here, not only in a later test');
  assert.equal(url.pathname, '/');
  assert.equal(url.searchParams.get('token'), '9f2c1ab4d5e6');
});

test('tolerates the trailing LAN suffix the web app appends for a LAN bind', () => {
  // dsh-web-app/lib/index.js:203 appends " (LAN: <url>)" when the bind sampled
  // a LAN address. The loopback bind never does, but the parser must not
  // mistake the shape for a malformed line.
  const url = parseUrlLine(`${GOOD} (LAN: http://192.168.1.9:54321/?token=9f2c1ab4d5e6)`);
  assert.ok(url instanceof URL);
  assert.equal(url.port, '54321');
});

test('tolerates leading whitespace and a trailing carriage return', () => {
  assert.ok(parseUrlLine(`  ${GOOD}\r`) instanceof URL);
});

test('rejects every line that is not a readiness signal', () => {
  const rejected = {
    'empty string': '',
    'whitespace only': '   ',
    'no prefix': 'http://127.0.0.1:54321/?token=abc',
    'prefix but nothing after it': 'dsh web:',
    'prefix but only spaces': 'dsh web:    ',
    'not a URL at all': 'dsh web: not-a-url',
    'not http': 'dsh web: https://127.0.0.1:54321/?token=abc',
    'not loopback': 'dsh web: http://192.168.1.9:54321/?token=abc',
    'loopback by name is not the literal host': 'dsh web: http://localhost:54321/?token=abc',
    'no port': 'dsh web: http://127.0.0.1/?token=abc',
    'port out of range': 'dsh web: http://127.0.0.1:70000/?token=abc',
    'a path other than root': 'dsh web: http://127.0.0.1:54321/index.html?token=abc',
    'no token at all': 'dsh web: http://127.0.0.1:54321/',
    'an empty token': 'dsh web: http://127.0.0.1:54321/?token=',
    'two tokens': 'dsh web: http://127.0.0.1:54321/?token=a&token=b',
    'a fragment': 'dsh web: http://127.0.0.1:54321/?token=abc#x',
    'non-string input': 42,
  };
  for (const [why, line] of Object.entries(rejected)) {
    assert.equal(parseUrlLine(line), null, `should have rejected: ${why}`);
  }
});

test('finds the URL when a pipe splits it across chunks', async () => {
  // A pipe split can land anywhere, including inside the URL; the scanner has
  // to reassemble across chunk boundaries or readiness is missed entirely.
  const found = [];
  const lines = [];
  const scanner = createReadyScanner({ onUrl: (url) => found.push(url), onLine: (line) => lines.push(line) });

  scanner.push('dsh web: http://127.0.0.1:543');
  assert.equal(scanner.isReady, false);
  scanner.push('21/?token=9f2c1a');
  assert.equal(scanner.isReady, false);
  scanner.push('b4d5e6\n');
  assert.equal(scanner.isReady, true);
  assert.equal(found.length, 1);
  assert.equal(found[0].port, '54321');
  assert.equal(lines.length, 1);
  assert.equal(lines[0], GOOD);
});

test('fires once even when the line is printed twice', () => {
  const found = [];
  const scanner = createReadyScanner({ onUrl: (url) => found.push(url) });
  scanner.push(`${GOOD}\n${GOOD}\n`);
  assert.equal(found.length, 1);
});

test('ignores ordinary output before the readiness line', () => {
  const found = [];
  const lines = [];
  const scanner = createReadyScanner({ onUrl: (url) => found.push(url), onLine: (line) => lines.push(line) });
  scanner.push('some loader chatter\ndsh web: opening the default browser\n');
  assert.equal(found.length, 0);
  assert.equal(lines.length, 2);
  assert.equal(scanner.isReady, false);
});

test('flush() consumes a final line with no trailing newline', () => {
  const found = [];
  const scanner = createReadyScanner({ onUrl: (url) => found.push(url) });
  scanner.push(GOOD);
  assert.equal(found.length, 0, 'nothing should fire before the line is terminated');
  scanner.flush();
  assert.equal(found.length, 1);
});

test('the log form of the readiness line carries no token', () => {
  // This is a credential, not diagnostic text: the log is written to disk and
  // survives the process. The token must not appear in it in any form.
  const redacted = redactToken(GOOD);
  assert.equal(redacted, 'dsh web: http://127.0.0.1:54321/?token=***');
  assert.equal(redacted.includes('9f2c1ab4d5e6'), false);
  // The rest of the line survives, so a failed boot is still diagnosable.
  assert.ok(redacted.includes('127.0.0.1:54321'));
});

test('redaction handles the LAN suffix, extra parameters, and case', () => {
  assert.equal(
    redactToken(`${GOOD} (LAN: http://192.168.1.9:54321/?token=deadbeef)`),
    'dsh web: http://127.0.0.1:54321/?token=*** (LAN: http://192.168.1.9:54321/?token=***)',
  );
  assert.equal(redactToken('http://127.0.0.1:1/?a=1&token=secret&b=2'), 'http://127.0.0.1:1/?a=1&token=***&b=2');
  assert.equal(redactToken('http://127.0.0.1:1/?TOKEN=secret'), 'http://127.0.0.1:1/?TOKEN=***');
});

test('redaction stops at the closing parenthesis of the LAN suffix', () => {
  // Caught by this suite: a greedy value class swallowed the ")" and produced a
  // line that misreported which URL the token belonged to.
  assert.equal(redactToken('(LAN: http://10.0.0.1:1/?token=abc)'), '(LAN: http://10.0.0.1:1/?token=***)');
  // Asserted as a whole string, not with endsWith: an assertion that only checks
  // the tail would still hold for a regex that dropped part of the value.
  assert.equal(redactToken('?token=a.b+c/d=e'), '?token=***');
  // A fragment has no `&`, whitespace, or `)` before it, so it is swallowed with
  // the value. Over-redacting is the safe direction; under-redacting is not.
  assert.equal(redactToken('?token=abc#frag'), '?token=***');
});

test('only the web may be handed to the operating system', () => {
  // The URL comes from the loaded page in both call sites, so the scheme is the
  // entire policy.
  for (const allowed of ['http://127.0.0.1:1/x', 'https://example.com/a?b=c']) {
    assert.equal(isWebUrl(allowed), true, `${allowed} should be allowed`);
  }
  for (const refused of [
    'file:///C:/Windows/System32/calc.exe',
    'javascript:alert(1)',
    'data:text/html,<script>x</script>',
    'ms-settings:',
    'vscode://file/C:/x',
    'ftp://example.com/f',
    'not a url',
    '',
    undefined,
    null,
    42,
  ]) {
    assert.equal(isWebUrl(refused), false, `${String(refused)} should be refused`);
  }
});

test('log truncation keeps the head and says what it dropped', () => {
  assert.equal(truncateForLog('short'), 'short');
  assert.equal(truncateForLog(''), '');
  assert.equal(truncateForLog(undefined), '');
  assert.equal(truncateForLog(42), '42');

  const long = 'x'.repeat(2654); // the longest line this project actually logged
  const shortened = truncateForLog(long);
  assert.equal(shortened.length, 300);
  assert.ok(shortened.startsWith('xxx'));
  assert.ok(shortened.endsWith('…(+2354 chars)'), shortened.slice(-20));

  // A limit smaller than the marker must not produce a longer string.
  assert.ok(truncateForLog(long, 10).length <= 10);
  assert.equal(truncateForLog(long, long.length), long, 'the boundary is inclusive');
  assert.equal(truncateForLog(long, 2653).length, 2653);
});

test('redaction leaves text without a token alone, including non-strings', () => {
  assert.equal(redactToken('some ordinary loader output'), 'some ordinary loader output');
  assert.equal(redactToken('token without a query marker: token=abc'), 'token without a query marker: token=abc');
  assert.equal(redactToken(undefined), undefined);
  assert.equal(redactToken(42), 42);
});
