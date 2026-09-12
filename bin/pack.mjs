/**
 * Build the portable app into `dist\DSH Desktop\`.
 *
 * This is what `electron-packager` would do for a zero-dependency app: copy the
 * Electron runtime, rename its launcher, and drop this project's own files in
 * `resources/app` where Electron looks for them. Written by hand because the
 * alternative pulls another package (and, for a real installer, another
 * GitHub-hosted toolchain) into a build whose only job is copying files.
 *
 *   npm run pack
 *
 * @module dsh-desktop/bin/pack
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON_DIST = join(ROOT, 'node_modules', 'electron', 'dist');
const OUT_DIR = join(ROOT, 'dist', 'DSH Desktop');
const APP_DIR = join(OUT_DIR, 'resources', 'app');

/** Files of ours that belong inside `resources/app`; everything else is build-only. */
const APP_FILES = ['src', 'package.json'];
/** Extra assets the app reads at runtime. */
const APP_ASSETS = [['build/icon.png', 'build/icon.png']];
/** Assets that belong beside the executable, for the shortcut's icon. */
const SIDE_ASSETS = [['build/icon.ico', 'icon.ico']];

const EXE_SOURCE = 'electron.exe';
const EXE_TARGET = 'DSH Desktop.exe';

/**
 * Total size of a directory tree, for a build report.
 * @param dir - the directory to measure.
 * @returns the size in bytes.
 */
function treeSize(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const path = entry.parentPath === undefined ? join(dir, entry.name) : join(entry.parentPath, entry.name);
    try {
      total += statSync(path).size;
    } catch {
      // A file that vanished mid-walk is not worth failing the build over.
    }
  }
  return total;
}

/**
 * Stop before touching anything when the inputs are not there.
 * @returns nothing; exits the process on a missing prerequisite.
 */
function requirePrerequisites() {
  if (!existsSync(join(ELECTRON_DIST, EXE_SOURCE))) {
    console.error(
      `dsh-desktop: ${join(ELECTRON_DIST, EXE_SOURCE)} is missing.\n` +
        `Run \`npm install\` (and see RUNBOOK.md: this Electron major does not fetch its binary automatically).`,
    );
    process.exit(1);
  }
  for (const file of ['src/main.js', 'node_modules/electron/package.json']) {
    if (!existsSync(join(ROOT, file))) {
      console.error(`dsh-desktop: ${file} is missing; run this from a complete checkout`);
      process.exit(1);
    }
  }
}

/**
 * Read the version Electron actually installed, so the package reports it.
 * @returns the Electron version string.
 */
function electronVersion() {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'node_modules', 'electron', 'package.json'), 'utf8')).version;
  } catch {
    return 'unknown';
  }
}

requirePrerequisites();

console.log(`dsh-desktop: packaging with Electron ${electronVersion()}`);
try {
  rmSync(OUT_DIR, { recursive: true, force: true });
} catch (error) {
  // Windows refuses to delete a file that a running process has open, and the
  // packaged app is exactly such a process: `DSH Desktop.exe` locks itself.
  console.error(
    `dsh-desktop: could not clear ${relative(ROOT, OUT_DIR)} — ${error.code ?? error.message}\n` +
      `Close any running DSH Desktop window (the packaged app locks its own executable) and run this again.`,
  );
  process.exit(1);
}
mkdirSync(APP_DIR, { recursive: true });

// 1. The runtime. Copied wholesale: the DLLs, the ICU data, the locales and the
//    .pak resources are all load-bearing, and a hand-picked subset is how an
//    Electron app builds fine and fails on first run.
cpSync(ELECTRON_DIST, OUT_DIR, { recursive: true });

// 2. Rename the launcher. Electron locates its app from the executable's own
//    directory, so renaming is safe and gives the taskbar the right identity.
const exeSource = join(OUT_DIR, EXE_SOURCE);
const exeTarget = join(OUT_DIR, EXE_TARGET);
if (existsSync(exeSource)) {
  cpSync(exeSource, exeTarget);
  rmSync(exeSource, { force: true });
}

// 3. Our application, at resources/app.
for (const entry of APP_FILES) {
  const from = join(ROOT, entry);
  if (!existsSync(from)) {
    console.error(`dsh-desktop: ${entry} is missing from the project`);
    process.exit(1);
  }
  cpSync(from, join(APP_DIR, entry), { recursive: true });
}
for (const [from, to] of APP_ASSETS) {
  const source = join(ROOT, from);
  if (!existsSync(source)) {
    console.error(`dsh-desktop: ${from} is missing; run \`npm run icon\` first`);
    process.exit(1);
  }
  mkdirSync(dirname(join(APP_DIR, to)), { recursive: true });
  cpSync(source, join(APP_DIR, to));
}
for (const [from, to] of SIDE_ASSETS) {
  if (existsSync(join(ROOT, from))) cpSync(join(ROOT, from), join(OUT_DIR, to));
}

// 4. A manifest for the packaged app. `productName` is kept deliberately: it is
//    what makes Electron's userData directory `%APPDATA%\DSH Desktop`, so the
//    packaged build reads the same settings, logs and window state as the dev
//    run. Dropping it would silently move every user's state to a new folder.
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
for (const key of ['devDependencies', 'scripts', 'private']) delete manifest[key];
writeFileSync(join(APP_DIR, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

// 5. Verify the result rather than assuming the copy order was right.
const packagedMain = readFileSync(join(APP_DIR, manifest.main), 'utf8');
const checks = [
  [`launcher ${EXE_TARGET}`, existsSync(exeTarget)],
  ['resources/app/package.json', existsSync(join(APP_DIR, 'package.json'))],
  [`entry ${manifest.main}`, existsSync(join(APP_DIR, manifest.main))],
  ['entry is the shell', packagedMain.includes('requestSingleInstanceLock')],
  ['productName preserved', JSON.parse(readFileSync(join(APP_DIR, 'package.json'), 'utf8')).productName === 'DSH Desktop'],
  ['loading page', existsSync(join(APP_DIR, 'src', 'loading.html'))],
  ['icon for the window', existsSync(join(APP_DIR, 'build', 'icon.png'))],
  ['icon for the shortcut', existsSync(join(OUT_DIR, 'icon.ico'))],
  ['no stale electron.exe', !existsSync(exeSource)],
  ['runtime present (icudtl.dat)', existsSync(join(OUT_DIR, 'icudtl.dat'))],
  ['locales present', existsSync(join(OUT_DIR, 'locales'))],
];

let failed = 0;
for (const [label, ok] of checks) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) failed += 1;
}

console.log(`dsh-desktop: ${relative(ROOT, OUT_DIR)} is ${(treeSize(OUT_DIR) / 1024 / 1024).toFixed(1)} MB`);
if (failed > 0) {
  console.error(`dsh-desktop: PACK FAILED — ${failed} check(s) failed`);
  process.exit(1);
}
console.log(`dsh-desktop: PACK OK — run ${relative(ROOT, exeTarget)}`);
