/**
 * Build `build/icon.png` and `build/icon.ico` for DSH Desktop.
 *
 * Run with Electron, because Electron is the only rasteriser this project
 * already has: an offscreen BrowserWindow renders the SVG and `capturePage()`
 * returns the pixels. No image library is added for a build-time asset.
 *
 *   npm run icon
 *
 * The mark is taken from the DSH frontend's own favicon in the installed
 * distribution, so the icon tracks the product rather than a vendored copy of a
 * file this project does not own. If that file cannot be found, a plain text
 * mark is used and the fallback is reported — the build never fails for an icon.
 *
 * @module dsh-desktop/tools/make-icon
 */

import { app, BrowserWindow, nativeImage } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveDshHome } from '../src/paths.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_DIR = join(ROOT, 'build');

/** Canvas size of the master render; smaller sizes are resampled from it. */
const MASTER = 256;
/** ICO entries, largest last; 256 is stored with a 0 length byte by convention. */
const SIZES = [16, 24, 32, 48, 64, 128, 256];
/** The favicon is drawn in a 50×50 viewBox with its own margin. */
const FAVICON_BOX = 50;
/** Padding inside the rounded square, in master pixels. */
const PADDING = 34;

// Keep this tool's Chromium profile out of the user's real one: sharing it made
// Chromium report "Unable to move the cache: access denied" on every run, since
// the app itself may be holding the same cache directory.
app.setPath('userData', join(BUILD_DIR, '.icon-work'));

/**
 * Locate the DSH frontend favicon in the installed distribution.
 * @returns the absolute path, or null when it is not installed.
 */
function findFavicon() {
  try {
    const home = resolveDshHome();
    const candidates = [
      join(home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'favicon.svg'),
    ];
    for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  } catch {
    // Fall through to the text mark.
  }
  return null;
}

/**
 * Extract the first path's `d` attribute from an SVG document.
 * @param svg - the SVG source.
 * @returns the path data, or null when the document has no path.
 */
function extractPathData(svg) {
  const match = /<path[^>]*\sd="([^"]+)"/s.exec(svg);
  return match === null ? null : match[1];
}

/**
 * Compose the icon SVG: a rounded square with the DSH mark centred on it.
 * @returns the SVG source.
 */
function composeSvg() {
  const favicon = findFavicon();
  let inner;
  if (favicon !== null) {
    const data = extractPathData(readFileSync(favicon, 'utf8'));
    if (data !== null) {
      const scale = (MASTER - PADDING * 2) / FAVICON_BOX;
      inner = `<g transform="translate(${PADDING},${PADDING}) scale(${scale.toFixed(4)})"><path d="${data}" fill="#ffffff"/></g>`;
      console.log(`dsh-desktop: icon mark from ${favicon}`);
    }
  }
  if (inner === undefined) {
    console.log('dsh-desktop: no DSH favicon found; using the text mark');
    inner =
      `<text x="${MASTER / 2}" y="${MASTER / 2 + 34}" text-anchor="middle" ` +
      `font-family="Segoe UI, sans-serif" font-size="104" font-weight="700" fill="#ffffff">DSH</text>`;
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${MASTER}" height="${MASTER}" viewBox="0 0 ${MASTER} ${MASTER}">` +
    `<rect width="${MASTER}" height="${MASTER}" rx="56" fill="#101418"/>${inner}</svg>`
  );
}

/**
 * Wrap PNG images into a single .ico container.
 *
 * An ICO is a directory followed by the image payloads. Windows (Vista and
 * later) accepts PNG payloads directly, so no BMP encoding is needed. A 256-pixel
 * entry stores 0 in its width and height bytes, which is the format's encoding
 * for 256 rather than a value.
 *
 * @param entries - `{ size, png }` pairs, smallest first.
 * @returns the .ico bytes.
 */
function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(entries.length, 4);

  const directory = Buffer.alloc(16 * entries.length);
  let offset = header.length + directory.length;
  const payloads = [];
  entries.forEach((entry, index) => {
    const at = index * 16;
    const dimension = entry.size >= 256 ? 0 : entry.size;
    directory.writeUInt8(dimension, at + 0); // width
    directory.writeUInt8(dimension, at + 1); // height
    directory.writeUInt8(0, at + 2); // palette size
    directory.writeUInt8(0, at + 3); // reserved
    directory.writeUInt16LE(1, at + 4); // colour planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(entry.png.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += entry.png.length;
    payloads.push(entry.png);
  });
  return Buffer.concat([header, directory, ...payloads]);
}

/**
 * Read an .ico back and report what it declares, cross-checking each entry's
 * declared size against the pixel size in the PNG payload it points at.
 *
 * The declared and actual sizes can disagree without the container being
 * malformed: a capture at a scaled display returns device pixels (this machine
 * yields 320×320 for a 256-pixel window), so an entry can advertise 256 and
 * carry 320. That is what this check exists to catch.
 *
 * @param ico - the icon bytes.
 * @returns an array of `{ size, actual }` entries, or null when malformed.
 */
function describeIco(ico) {
  if (ico.length < 6) return null;
  if (ico.readUInt16LE(0) !== 0 || ico.readUInt16LE(2) !== 1) return null;
  const count = ico.readUInt16LE(4);
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    const at = 6 + index * 16;
    const size = ico.readUInt8(at) === 0 ? 256 : ico.readUInt8(at);
    const bytes = ico.readUInt32LE(at + 8);
    const offset = ico.readUInt32LE(at + 12);
    if (offset + bytes > ico.length || bytes < 24) return null;
    const payload = ico.subarray(offset, offset + bytes);
    if (payload.readUInt32BE(0) !== 0x89504e47) return null; // PNG signature
    const actual = { width: payload.readUInt32BE(16), height: payload.readUInt32BE(20) };
    entries.push({ size, actual: actual.width === actual.height ? actual.width : `${actual.width}x${actual.height}` });
  }
  return entries;
}

/**
 * Bound a promise so a stuck Chromium call reports instead of hanging.
 *
 * `capturePage()` on a window that has never been shown does not resolve — it
 * rejects with `UnknownVizError` on this machine, or waits forever for a frame
 * the hidden compositor never produces. The window is therefore shown
 * (`showInactive`, so it does not steal focus) before any capture, and every
 * step is bounded so a future regression fails the build loudly rather than
 * leaving `npm run icon` apparently running.
 *
 * @param promise - the operation to bound.
 * @param ms - the budget in milliseconds.
 * @param label - what is being waited on, for the message.
 * @returns the operation's value, or a string describing the timeout.
 */
function withTimeout(promise, ms, label) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(`timeout: ${label}`), ms))]);
}

app.whenReady().then(async () => {
  mkdirSync(BUILD_DIR, { recursive: true });

  const svg = composeSvg();
  const page = new BrowserWindow({
    width: MASTER,
    height: MASTER,
    x: 0,
    y: 0,
    show: false,
    frame: false,
    transparent: true,
    useContentSize: true,
    skipTaskbar: true,
    webPreferences: { backgroundThrottling: false },
  });
  const loaded = await withTimeout(
    page.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<body style="margin:0;background:transparent">${svg}</body>`)),
    10_000,
    'loadURL',
  );
  if (typeof loaded === 'string') {
    console.error(`dsh-desktop: ${loaded}`);
    app.exit(1);
    return;
  }
  page.showInactive();

  let masterPng = null;
  for (let attempt = 1; attempt <= 5 && masterPng === null; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 350));
    try {
      const image = await withTimeout(page.webContents.capturePage(), 6000, 'capturePage');
      if (typeof image === 'string') {
        console.error(`dsh-desktop: attempt ${attempt}: ${image}`);
        continue;
      }
      const png = image.toPNG();
      if (png.length > 0) masterPng = png;
      else console.error(`dsh-desktop: attempt ${attempt}: captured no pixels`);
    } catch (error) {
      console.error(`dsh-desktop: attempt ${attempt}: ${error.message}`);
    }
  }
  page.destroy();

  if (masterPng === null) {
    console.error('dsh-desktop: could not capture the icon; no files were written');
    app.exit(1);
    return;
  }

  // Normalise to exactly MASTER pixels. A capture on a scaled display comes back
  // in device pixels, and writing that straight out is how an .ico entry ends up
  // declaring one size and carrying another.
  const square = nativeImage.createFromBuffer(masterPng).resize({ width: MASTER, height: MASTER, quality: 'best' });
  masterPng = square.toPNG();

  const pngPath = join(BUILD_DIR, 'icon.png');
  writeFileSync(pngPath, masterPng);

  const entries = SIZES.map((size) => ({
    size,
    png: size === MASTER ? masterPng : square.resize({ width: size, height: size, quality: 'best' }).toPNG(),
  }));
  const ico = buildIco(entries);
  const icoPath = join(BUILD_DIR, 'icon.ico');
  writeFileSync(icoPath, ico);

  const described = describeIco(ico);
  const mismatched = described === null ? [] : described.filter((entry) => entry.actual !== entry.size);
  console.log(`dsh-desktop: wrote ${pngPath} (${masterPng.length} bytes, ${MASTER}px)`);
  console.log(
    `dsh-desktop: wrote ${icoPath} (${ico.length} bytes, entries: ` +
      `${described === null ? 'MALFORMED' : described.map((entry) => `${entry.size}→${entry.actual}`).join(' ')} )`,
  );
  if (described === null || mismatched.length > 0) {
    console.error(`dsh-desktop: ICON REJECTED — ${mismatched.length} entry/ies disagree with their payload`);
    app.exit(1);
    return;
  }
  app.exit(0);
});
