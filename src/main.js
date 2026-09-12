/**
 * DSH Desktop — Electron main process.
 *
 * The shell does four things and nothing else: it owns one window, it owns the
 * harness child's lifecycle, it exposes a small native surface (menu, tray,
 * folder picker, external links), and it keeps its own state under Electron's
 * `userData` directory.
 *
 * It is deliberately not a harness host. The harness runs as a child process on
 * the system Node — see `docs/agent-notes/DECISIONS.md` D-1 for the measurement
 * that decides the boundary — and this process never boots a Cordis tree, never
 * reads a credential, and never mints or replays a launch token.
 *
 * @module dsh-desktop/main
 */

import { app, BrowserWindow, Menu, Tray, clipboard, dialog, globalShortcut, ipcMain, nativeImage, screen, shell } from 'electron';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_CONFIG, normalizeConfig } from './config.mjs';
import { buildDiagnostics } from './diagnostics.mjs';
import { chooseGeometry } from './geometry.mjs';
import { HarnessSupervisor } from './harness.mjs';
import { resolveDshHome, resolveInstallAnchor, resolveNodeExe, workspaceFromArgv } from './paths.mjs';
import { reapStaleChild } from './reap.mjs';
import { normalizeState } from './state.mjs';
import { isWebUrl, redactToken, truncateForLog } from './url-line.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Taskbar/notification identity, and the app's own name. */
const APP_ID = 'com.dsh.desktop';
const APP_NAME = 'DSH Desktop';

app.setAppUserModelId(APP_ID);
app.setName(APP_NAME);

// An EPIPE on stdout arrives as an 'error' event, which is unhandled by default
// and fatal. A packaged GUI app with no console must simply not care.
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

// ---------------------------------------------------------------------------
// Command line, answered before anything else happens
// ---------------------------------------------------------------------------
//
// These must not take the single-instance lock, open a window, or spawn a
// harness: `--version` is the first thing a support request asks for, and it has
// to answer even while another copy is already running.

const USAGE = `${APP_NAME} — a desktop shell for DeepSeek Harness.

Usage:
  DSH Desktop [folder]              open with that folder as the harness workspace
  DSH Desktop --workspace <folder>  the same, spelled out
  DSH Desktop --settings            open with the settings window showing
  DSH Desktop --version             print versions and exit
  DSH Desktop --help                print this and exit

Closing the window quits unless closeToTray is set in
%APPDATA%\\DSH Desktop\\config.json.
`;

/** The switches this shell owns, from argv. Electron's own are filtered out. */
const cliSwitches = process.argv.slice(1).filter((argument) => argument.startsWith('-'));

if (cliSwitches.includes('--version') || cliSwitches.includes('-V')) {
  process.stdout.write(`${APP_NAME} ${app.getVersion()}\n`);
  // Labelled deliberately: these are the versions Electron carries. The harness
  // runs on the SYSTEM Node, which is a different version, and an unlabelled
  // "Node x.y" here would invite exactly the wrong conclusion.
  process.stdout.write(
    `bundled with: Electron ${process.versions.electron} (its Node ${process.versions.node}, Chromium ${process.versions.chrome})\n`,
  );
  process.stdout.write(`harness runs on the Node found on PATH; see --settings for the resolved path\n`);
  process.exit(0);
}

if (cliSwitches.includes('--help') || cliSwitches.includes('-h')) {
  process.stdout.write(USAGE);
  process.exit(0);
}

const USER_DATA = app.getPath('userData');
const LOG_DIR = join(USER_DATA, 'logs');
const CONFIG_PATH = join(USER_DATA, 'config.json');
const STATE_PATH = join(USER_DATA, 'state.json');
const ICON_PNG = join(HERE, '..', 'build', 'icon.png');

/** @type {import('electron').BrowserWindow | null} */
let win = null;
/** @type {import('electron').Tray | null} */
let tray = null;
/** @type {HarnessSupervisor | null} */
let supervisor = null;
let currentUrl = null;
let harnessPageLoaded = false;
let pendingStatus = null;
let quitting = false;
/** The settings window, when one is open. */
let settingsWin = null;
/** The DSH version this shell actually booted, for the settings window. */
let dshVersion = 'not found';
/** Where the harness installation resolved to, for the diagnostics bundle. */
let anchorInfo = {};
/** The Node executable the child runs on, for the diagnostics bundle. */
let nodeExePath = 'unknown';
/** The port the current child reported, for the diagnostics bundle. */
let currentPort = null;

// ---------------------------------------------------------------------------
// Logging. One file per run, under userData; the last ten are kept.
// ---------------------------------------------------------------------------

mkdirSync(LOG_DIR, { recursive: true });

/**
 * A local-time ISO timestamp carrying its UTC offset.
 *
 * `toISOString()` was simpler and wrong here: this machine is UTC+8, so every
 * log line said `06:xx` while the file holding it was stamped `14:xx`, and the
 * file *name* disagreed with the file's own modification time by eight hours.
 *
 * @param date - the moment to render; defaults to now.
 * @returns e.g. `2026-09-12T14:35:07.205+08:00`.
 */
function timestamp(date = new Date()) {
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  const offsetMinutes = -date.getTimezoneOffset();
  const abs = Math.abs(offsetMinutes);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}` +
    `${offsetMinutes < 0 ? '-' : '+'}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

const logPath = join(LOG_DIR, `app-${timestamp().replace(/[:.]/g, '-')}.log`);

/**
 * Append one line to this run's log.
 *
 * The file is the log. The console is a convenience, and it must never be load
 * bearing: a packaged Windows GUI application has no console, and when it is
 * launched by a supervisor whose stdout pipe closes, writing to it throws EPIPE
 * — synchronously, or as an 'error' event on the stream. An unguarded write
 * therefore let a broken pipe abort whatever the caller was doing, which is how
 * this shell once hung with the last log line written and no error anywhere.
 *
 * @param message - the text to record.
 * @returns nothing.
 */
function log(message) {
  const line = `${timestamp()} ${message}\n`;
  try {
    appendFileSync(logPath, line, 'utf8');
  } catch {
    // A failing log must never take the app down.
  }
  try {
    process.stdout.write(line);
  } catch {
    // No console, or the pipe is gone.
  }
}

/**
 * Delete all but the newest few log files.
 *
 * The slice keeps the ten most recent files and the loop removes the rest —
 * the earlier draft had those inverted, which would have deleted exactly the
 * logs worth keeping.
 *
 * @returns nothing.
 */
function pruneLogs() {
  try {
    const stale = readdirSync(LOG_DIR)
      .filter((name) => name.startsWith('app-') && name.endsWith('.log'))
      .map((name) => ({ name, at: statSync(join(LOG_DIR, name)).mtimeMs }))
      .sort((a, b) => b.at - a.at)
      .slice(10);
    for (const file of stale) rmSync(join(LOG_DIR, file.name), { force: true });
  } catch {
    // Best effort only.
  }
}

/**
 * Read a JSON file, reporting rather than throwing when it is absent or broken.
 * @param path - the file to read.
 * @param fallback - returned when the file cannot be used.
 * @returns the parsed value or the fallback.
 */
function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    log(`could not parse ${path}: ${error.message}; ignoring it`);
    return fallback;
  }
}

/**
 * Write a JSON file, reporting rather than throwing on failure.
 * @param path - the file to write.
 * @param value - the value to serialise.
 * @returns nothing.
 */
function writeJson(path, value) {
  try {
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  } catch (error) {
    log(`could not write ${path}: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Settings and state
// ---------------------------------------------------------------------------

if (!existsSync(CONFIG_PATH)) {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeJson(CONFIG_PATH, normalizeConfig(undefined));
  log(`wrote a default config to ${CONFIG_PATH}`);
}

const config = normalizeConfig(readJson(CONFIG_PATH, undefined), (problem) => log(`config: ${problem}`));
// Object-or-nothing: a bare `null` in this file used to throw while the module
// was still evaluating, before a window existed to report it. See state.mjs.
let state = normalizeState(readJson(STATE_PATH, undefined), (problem) => log(`state: ${problem}`));
log(`${APP_NAME} starting. userData=${USER_DATA}`);
log(`log file: ${logPath}`);
log(`config: ${JSON.stringify(config)}`);

/**
 * Pick the directory the harness child runs in.
 *
 * The child's cwd is what the harness treats as the workspace root and where it
 * looks for a `.env`, so this is a real input to the harness, not a preference.
 * The first existing directory among the command line, the config, the last
 * session, and the user's home wins.
 *
 * @returns the absolute workspace path.
 */
function resolveWorkspace() {
  const fromArgv = workspaceFromArgv(process.argv.slice(1));
  if (fromArgv !== null) {
    log(`workspace: ${fromArgv} (from the command line)`);
    return fromArgv;
  }
  for (const [source, candidate] of [
    ['config.workspace', config.workspace],
    ['last session', state.lastWorkspace],
  ]) {
    if (typeof candidate === 'string' && existsSync(candidate) && statSync(candidate).isDirectory()) {
      log(`workspace: ${candidate} (${source})`);
      return candidate;
    }
    if (typeof candidate === 'string') log(`workspace: ignoring ${source} ${candidate}; it is not a directory`);
  }
  const home = app.getPath('home');
  log(`workspace: ${home} (default)`);
  return home;
}

let workspace = resolveWorkspace();

/**
 * Persist the shell's own state.
 * @param patch - keys to merge into the stored state.
 * @returns nothing.
 */
function saveState(patch = {}) {
  state = { ...state, ...patch };
  writeJson(STATE_PATH, state);
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

/**
 * Restore the last window geometry.
 *
 * The decision lives in `geometry.mjs` so its off-screen branch — a window
 * saved on a monitor that is no longer attached — can be tested without
 * unplugging anything.
 *
 * @returns `{ bounds, maximized }` for the BrowserWindow constructor.
 */
function restoreGeometry() {
  return chooseGeometry(state.window, screen.getAllDisplays());
}

/**
 * Send a status update to the loading page, or hold it until the page exists.
 * @param text - the message to show.
 * @param isError - whether to render it as a failure.
 * @returns nothing.
 */
function showStatus(text, isError = false) {
  pendingStatus = { text, isError };
  pushStatus();
}

/**
 * Apply the pending status to the loading page if it is live.
 * @returns nothing.
 */
function pushStatus() {
  if (pendingStatus === null || win === null || win.isDestroyed()) return;
  const payload = JSON.stringify(pendingStatus);
  win.webContents
    .executeJavaScript(`window.__dshSetStatus && window.__dshSetStatus(${payload}.text, ${payload}.isError);`, true)
    .catch(() => {});
}

/**
 * Check that the interface actually mounted, and record it.
 *
 * A blank window is the failure this catches, and it is one the harness cannot
 * rule out on its own: the child can be healthy and its URL load while the page
 * renders nothing — an unauthenticated 401 body, a failed bundle fetch, or a
 * client-side crash all look identical from the outside. The GUI's own root
 * element having children is the cheapest true statement that it rendered.
 *
 * @returns a promise settling once the page has been inspected.
 */
async function reportPageState() {
  if (win === null || win.isDestroyed()) return;
  if (currentUrl === null) {
    log('loaded: the pre-harness page');
    return;
  }
  harnessPageLoaded = true;
  try {
    const mounted = await win.webContents.executeJavaScript(
      'Boolean(document.querySelector("#root") && document.querySelector("#root").childElementCount > 0)',
      true,
    );
    log(`loaded: ${new URL(currentUrl).origin} — interface mounted: ${String(mounted)}`);
    if (mounted !== true) {
      showStatus(
        'The harness is running, but its interface did not render. ' +
          'The log has the details (Help → Show Log Folder).',
        true,
      );
    }
  } catch (error) {
    log(`could not inspect the loaded page: ${error.message}`);
  }
}

/**
 * Say which network layer can reach the harness.
 *
 * Enabled with `DSH_DESKTOP_DIAG=1`. It exists because a navigation that is
 * blocked below the navigation layer produces no event at all: the window simply
 * stays on the old page, `did-fail-load` never fires, and the socket never
 * appears. Testing the three stacks separately — Node's own fetch, Chromium's
 * session network (`net.fetch`), and the renderer's `fetch` — says which one is
 * refusing rather than leaving it to inference.
 *
 * @param origin - the harness origin, without the launch token.
 * @returns a promise settling once every layer has reported.
 */
async function diagnoseConnectivity(origin) {
  const probe = async (label, run) => {
    const started = Date.now();
    try {
      const value = await Promise.race([
        run(),
        new Promise((resolve) => setTimeout(() => resolve('TIMED OUT'), 8000)),
      ]);
      return `${label}=${value} (${Date.now() - started}ms)`;
    } catch (error) {
      return `${label}=THREW(${error.name}: ${error.message})`;
    }
  };

  // Run all three at once. Sequentially, a hung first probe starves the others
  // and the whole diagnostic reports nothing — which is how the first version of
  // this function failed.
  const findings = await Promise.all([
    probe('nodeFetch', async () => `HTTP ${(await fetch(`${origin}/`)).status}`),
    probe('chromiumNet', async () => {
      const { net } = await import('electron');
      return `HTTP ${(await net.fetch(`${origin}/`)).status}`;
    }),
    probe('renderer', async () => {
      if (win === null || win.isDestroyed()) return 'no window';
      return String(
        await win.webContents.executeJavaScript(
          `fetch(${JSON.stringify(`${origin}/`)}).then((r) => 'HTTP ' + r.status).catch((e) => 'REJECTED ' + e.message)`,
          true,
        ),
      );
    }),
  ]);
  log(`DIAG connectivity: ${findings.join('  |  ')}`);
}

/**
 * Open a URL in the user's own browser, refusing anything that is not the web.
 *
 * Both call sites hand a URL straight to the shell, and the loaded page decides
 * what that URL is. Restricting the scheme is three lines and removes a whole
 * class of "the page asked the OS to open this" surprises.
 *
 * @param url - the candidate URL.
 * @param why - what asked for it, for the log.
 * @returns nothing.
 */
function safeOpenExternal(url, why) {
  if (!isWebUrl(url)) {
    log(`refused to open a non-web URL from ${why}: ${truncateForLog(String(url), 120)}`);
    return;
  }
  shell.openExternal(url).catch((error) => log(`could not open ${url}: ${error.message}`));
}

/**
 * Make a failure the user can actually see.
 *
 * Before the interface loads, the loading page carries the message. Afterwards
 * that page is gone, `window.__dshSetStatus` no longer exists, and every status
 * update was silently dropped — so a harness that gave up left the window
 * retrying forever with no explanation anywhere on screen.
 *
 * @param message - what happened, in the user's terms.
 * @returns a promise settling once the user has been told (or the attempt failed).
 */
async function surfaceFailure(message) {
  log(`failure surfaced to the user: ${message}`);
  if (win === null || win.isDestroyed()) return;
  if (currentUrl === null || harnessPageLoaded !== true) {
    // The loading page is still what the user is looking at; showStatus already
    // had its chance and this is the in-page path.
    showStatus(message, true);
    return;
  }
  if (!win.isVisible()) win.show();
  try {
    const { response } = await dialog.showMessageBox(win, {
      type: 'error',
      title: APP_NAME,
      message: 'DeepSeek Harness stopped',
      detail: message,
      buttons: ['Restart DSH', 'Show Logs', 'Dismiss'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    if (response === 0 && supervisor !== null) await supervisor.restartWith(workspace);
    else if (response === 1) void shell.openPath(LOG_DIR);
  } catch (error) {
    log(`could not present the failure dialog: ${error.message}`);
  }
}

/**
 * Create the shell window and show the loading page until the harness is ready.
 * @returns the created window.
 */
function createWindow() {
  const { bounds, maximized } = restoreGeometry();
  win = new BrowserWindow({
    ...bounds,
    minWidth: 720,
    minHeight: 520,
    show: false,
    backgroundColor: '#101418',
    title: APP_NAME,
    icon: existsSync(ICON_PNG) ? ICON_PNG : undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // A persistent partition, so the GUI's own localStorage (theme, layout)
      // survives a restart. The auth cookie is authority-bound and the port
      // changes each launch, so a stale cookie is never sent to the new server.
      partition: 'persist:dsh-desktop',
    },
  });

  win.once('ready-to-show', () => win?.show());
  win.on('page-title-updated', (event) => event.preventDefault());
  win.webContents.on('did-finish-load', () => {
    pushStatus();
    void reportPageState();
  });
  // A navigation that fails leaves the window showing Chromium's own error page
  // under the title "Error", with nothing in this log to say why. These handlers
  // are the difference between that and a diagnosable failure. The page's own
  // console is included because a request blocked below the navigation layer —
  // a Chromium permission denial, for instance — reports itself there and
  // nowhere else.
  win.webContents.on('did-start-navigation', (_event, url, isInPlace, isMainFrame) => {
    if (isMainFrame === true) log(`navigation started: ${redactToken(url)}`);
  });
  win.webContents.on('console-message', (event, level, message) => {
    // The GUI's console is useful evidence and unusable as a log: one measured
    // line was 2654 characters and three of them were 29% of the whole log. Only
    // errors are kept by default, truncated; everything by DSH_DESKTOP_DIAG=1.
    const text = typeof event?.message === 'string' ? event.message : String(message ?? '');
    const severity = String(event?.level ?? level ?? 'unknown');
    if (severity !== 'error' && process.env.DSH_DESKTOP_DIAG !== '1') return;
    const where =
      typeof event?.sourceId === 'string' && event.sourceId !== ''
        ? ` (${event.sourceId}:${String(event.lineNumber ?? '?')})`
        : '';
    log(`[page:${severity}] ${redactToken(truncateForLog(text))}${where}`);
  });
  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    log(
      `navigation failed: ${errorCode} ${errorDescription} ` +
        `url=${redactToken(validatedURL)} mainFrame=${String(isMainFrame)}`,
    );
  });
  win.webContents.on('did-navigate', (_event, url, httpResponseCode) => {
    log(`navigated: ${redactToken(url)} (HTTP ${String(httpResponseCode)})`);
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    log(`the interface process exited: reason=${details.reason} exitCode=${String(details.exitCode)}`);
    showStatus('The interface stopped unexpectedly. The log has the details (Help → Show Log Folder).', true);
  });

  // Nothing in this app should open a second window: send links to the user's
  // browser instead, and never let the window navigate off the harness origin.
  win.webContents.setWindowOpenHandler(({ url }) => {
    log(`external link requested: ${truncateForLog(url, 160)}`);
    safeOpenExternal(url, 'the page');
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    let sameOrigin = false;
    try {
      sameOrigin = currentUrl !== null && new URL(url).origin === new URL(currentUrl).origin;
    } catch {
      sameOrigin = false;
    }
    if (sameOrigin) return;
    event.preventDefault();
    log(`blocked navigation to ${truncateForLog(url, 160)}`);
    safeOpenExternal(url, 'a blocked navigation');
  });

  win.on('close', (event) => {
    if (config.closeToTray && !quitting) {
      event.preventDefault();
      win?.hide();
      return;
    }
    saveWindowGeometry();
  });
  win.on('closed', () => {
    win = null;
    // The settings window would otherwise keep the app alive after its own
    // window is gone, because `window-all-closed` does not fire while it is open.
    if (settingsWin !== null && !settingsWin.isDestroyed()) settingsWin.close();
  });
  win.on('resize', saveWindowGeometrySoon);
  win.on('move', saveWindowGeometrySoon);

  if (maximized) win.maximize();
  if (currentUrl !== null) {
    // The harness is already running, so this is a window being reopened — from
    // the tray, or by a second launch that found this instance. Showing the
    // loading page here would leave it there for good: onReady fires once per
    // child and will never fire again for a child that is already up.
    log(`reopening the running harness at ${new URL(currentUrl).origin}`);
    win.loadURL(currentUrl).catch((error) => log(`could not reopen the harness URL: ${error.message}`));
  } else {
    win.loadFile(join(HERE, 'loading.html')).catch((error) => log(`could not load the loading page: ${error.message}`));
    showStatus('Starting DeepSeek Harness…');
  }
  return win;
}

/**
 * Record the window geometry for the next launch, debounced because `resize`
 * and `move` fire continuously while a window is being dragged.
 * @returns nothing.
 */
let geometryTimer = null;
function saveWindowGeometrySoon() {
  if (geometryTimer !== null) return;
  geometryTimer = setTimeout(() => {
    geometryTimer = null;
    saveWindowGeometry();
  }, 400);
}

/**
 * Record the window geometry for the next launch.
 * @returns nothing.
 */
function saveWindowGeometry() {
  if (win === null || win.isDestroyed()) return;
  const maximized = win.isMaximized();
  if (maximized) {
    saveState({ window: { ...state.window, maximized: true } });
    return;
  }
  const { x, y, width, height } = win.getBounds();
  saveState({ window: { x, y, width, height, maximized: false } });
}

// ---------------------------------------------------------------------------
// Native surface
// ---------------------------------------------------------------------------

/**
 * Open a folder picker and restart the harness in the chosen workspace.
 * @returns a promise settling when the harness has been restarted.
 */
async function chooseWorkspace() {
  if (win === null) return;
  const result = await dialog.showOpenDialog(win, {
    title: 'Choose the workspace for DSH Desktop',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return;
  await switchWorkspace(result.filePaths[0]);
}

/**
 * Point the running harness at another workspace.
 *
 * The child's working directory is the harness's workspace root and cannot be
 * changed in place, so this is a restart, not a setting. Shared by the folder
 * picker and by a second launch that names a directory, so both behave the same.
 *
 * @param chosen - the absolute directory to run in.
 * @returns a promise settling once the replacement has been started.
 */
async function switchWorkspace(chosen) {
  if (chosen === workspace) {
    log(`workspace already ${chosen}; not restarting the harness`);
    return;
  }
  log(`workspace switched to ${chosen}`);
  workspace = chosen;
  saveState({ lastWorkspace: chosen });
  rememberWorkspace(chosen);
  currentUrl = null;
  currentPort = null;
  harnessPageLoaded = false;
  showStatus(`Restarting DeepSeek Harness in ${chosen}…`);
  if (supervisor !== null) await supervisor.restartWith(chosen);
}

/**
 * Build the application menu.
 * @returns nothing.
 */
function buildMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'Open Folder…', accelerator: 'CmdOrCtrl+O', click: () => void chooseWorkspace() },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => void openSettingsWindow() },
        { type: 'separator' },
        {
          label: 'Copy GUI URL',
          click: () => {
            if (currentUrl !== null) clipboard.writeText(currentUrl);
          },
        },
        {
          label: 'Open in Browser',
          click: () => {
            if (currentUrl === null) return;
            shell.openExternal(currentUrl).catch(() => {});
          },
        },
        { type: 'separator' },
        { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Show Log Folder', click: () => void shell.openPath(LOG_DIR) },
        {
          label: 'Export Diagnostics…',
          click: () => {
            const written = exportDiagnostics();
            if (written !== null && win !== null && !win.isDestroyed()) {
              void dialog.showMessageBox(win, {
                type: 'info',
                title: APP_NAME,
                message: 'Diagnostics written',
                detail: `${written}\n\nIt contains versions, settings, state and the last three logs, with any token removed.`,
                buttons: ['OK'],
              });
            }
          },
        },
        {
          label: `About ${APP_NAME}`,
          click: () => {
            const options = {
              type: 'info',
              title: `About ${APP_NAME}`,
              message: `${APP_NAME} ${app.getVersion()}`,
              detail:
                `A desktop shell for DeepSeek Harness.\n\n` +
                `Harness profile: web (your own profile, with your plugins)\n` +
                `Workspace: ${workspace}\n` +
                `Settings: ${CONFIG_PATH}\n` +
                `Logs: ${LOG_DIR}`,
              buttons: ['OK'],
            };
            if (win === null) void dialog.showMessageBox(options);
            else void dialog.showMessageBox(win, options);
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/**
 * Put a tray icon beside the clock, when an icon is available.
 * @returns nothing.
 */
function buildTray() {
  if (!existsSync(ICON_PNG)) {
    log('no build/icon.png yet; skipping the tray icon');
    return;
  }
  try {
    tray = new Tray(nativeImage.createFromPath(ICON_PNG));
    tray.setToolTip(`${APP_NAME} — ${basename(workspace)}`);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: `Show ${APP_NAME}`, click: () => (win === null ? createWindow() : (win.show(), win.focus())) },
        { label: 'Open Folder…', click: () => void chooseWorkspace() },
        { type: 'separator' },
        { label: 'Quit', click: () => app.quit() },
      ]),
    );
    tray.on('click', () => (win === null ? createWindow() : (win.show(), win.focus())));
    log('tray icon created');
  } catch (error) {
    log(`could not create the tray icon: ${error.message}`);
  }
}

/**
 * Open (or re-focus) the settings window.
 *
 * Its own window rather than a form inside the GUI: the GUI belongs to the
 * harness, and this shell must never inject anything into it.
 *
 * @returns the settings window.
 */
function openSettingsWindow() {
  if (settingsWin !== null && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return settingsWin;
  }
  settingsWin = new BrowserWindow({
    width: 640,
    height: 760,
    minWidth: 520,
    minHeight: 480,
    show: false,
    title: `${APP_NAME} — Settings`,
    parent: win ?? undefined,
    backgroundColor: '#101418',
    icon: existsSync(ICON_PNG) ? ICON_PNG : undefined,
    webPreferences: {
      // `sandbox: true` with a CommonJS preload. The bridge is probed and logged
      // on load, because that combination is the one assumption this window was
      // built on and it is cheap to falsify.
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(HERE, 'settings-preload.cjs'),
    },
  });
  settingsWin.once('ready-to-show', () => settingsWin?.show());
  settingsWin.on('closed', () => {
    settingsWin = null;
  });
  settingsWin.webContents.once('did-finish-load', () => {
    settingsWin?.webContents
      .executeJavaScript('typeof window.dshSettings', true)
      .then((kind) => log(`settings bridge: ${String(kind)}`))
      .catch((error) => log(`could not inspect the settings bridge: ${error.message}`));
    if (process.env.DSH_DESKTOP_DIAG === '1') {
      // Exercises the whole path — renderer → main → renderer — without changing
      // anything: an empty patch re-normalises the current settings and saves
      // them back unchanged. Gated on the same flag as the connectivity probe.
      settingsWin?.webContents
        .executeJavaScript(
          `(async () => {
             const before = await window.dshSettings.read();
             const after = await window.dshSettings.save({});
             const shown = {};
             for (const name of ['port', 'bootTimeoutMs', 'restartLimit', 'restartWindowMs', 'graceMs']) {
               shown[name] = Number(document.getElementById(name).value);
             }
             const bound = Object.entries(shown).every(([name, value]) => value === before.config[name]);
             return JSON.stringify({
               workspace: before.workspace,
               versionKeys: Object.keys(before.versions).length,
               problems: after.problems.length,
               samePort: after.config.port === before.config.port,
               formBoundToConfig: bound,
             });
           })()`,
          true,
        )
        .then((summary) => log(`DIAG settings round trip: ${String(summary)}`))
        .catch((error) => log(`DIAG settings round trip failed: ${error.message}`));
      // Exercises the same function the Help menu calls, so the bundle's content
      // and its redaction are checked without a mouse.
      settingsWin?.webContents
        .executeJavaScript('window.dshSettings.exportDiagnostics()', true)
        .then((written) => log(`DIAG diagnostics export: ${String(written)}`))
        .catch((error) => log(`DIAG diagnostics export failed: ${error.message}`));
    }
  });
  settingsWin
    .loadFile(join(HERE, 'settings.html'))
    .catch((error) => log(`could not load the settings page: ${error.message}`));
  log('settings window opened');
  return settingsWin;
}

/**
 * Register the settings window's IPC.
 *
 * The renderer names an operation; it never supplies a path or a command. The
 * two directory keys are an allowlist, and the settings object is rebuilt
 * through `normalizeConfig` on this side, so a compromised page cannot write
 * anything the schema would not accept.
 *
 * @returns nothing.
 */
function registerSettingsIpc() {
  ipcMain.handle('settings:read', () => ({
    config: { ...config },
    defaults: { ...DEFAULT_CONFIG },
    workspace,
    paths: { data: USER_DATA, logs: LOG_DIR },
    versions: {
      app: app.getVersion(),
      electron: process.versions.electron,
      node: process.versions.node,
      dsh: dshVersion,
    },
  }));

  ipcMain.handle('settings:save', (_event, values) => {
    const given = values !== null && typeof values === 'object' && !Array.isArray(values) ? values : {};
    // An empty field means "leave it alone", not "reset it": the form cannot
    // know the difference between a cleared box and a value it never showed.
    const patch = Object.fromEntries(Object.entries(given).filter(([, value]) => value !== undefined));
    const problems = [];
    const next = normalizeConfig({ ...config, ...patch }, (problem) => problems.push(problem));
    writeJson(CONFIG_PATH, next);
    // The supervisor holds this same object, so replacing its fields is what
    // makes restart policy and grace-period changes take effect immediately.
    const hotkeyChanged = next.globalHotkey !== config.globalHotkey;
    Object.assign(config, next);
    if (hotkeyChanged) {
      globalShortcut.unregisterAll();
      registerHotkey();
    }
    log(`settings saved: ${JSON.stringify(next)}${problems.length > 0 ? ` (refused: ${problems.join('; ')})` : ''}`);
    return { config: next, problems };
  });

  ipcMain.handle('settings:choose-workspace', async () => {
    const parent = settingsWin ?? win;
    if (parent === null || parent.isDestroyed()) return null;
    const result = await dialog.showOpenDialog(parent, {
      title: 'Choose the workspace for DSH Desktop',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    await switchWorkspace(result.filePaths[0]);
    return result.filePaths[0];
  });

  ipcMain.handle('settings:restart-harness', async () => {
    if (supervisor !== null) await supervisor.restartWith(workspace);
    return true;
  });

  ipcMain.handle('settings:open-path', (_event, which) => {
    const target = which === 'logs' ? LOG_DIR : which === 'data' ? USER_DATA : null;
    if (target === null) {
      log(`refused to open an unknown path key: ${JSON.stringify(which)}`);
      return false;
    }
    void shell.openPath(target);
    return true;
  });

  ipcMain.handle('settings:close', () => {
    settingsWin?.close();
    return true;
  });

  ipcMain.handle('diagnostics:export', () => exportDiagnostics());
}

// ---------------------------------------------------------------------------
// Native surfaces: hotkey, jump list, diagnostics
// ---------------------------------------------------------------------------

/** How many workspaces the jump list and the recent list remember. */
const MAX_RECENT_WORKSPACES = 6;

/** Remember a workspace, newest first, and refresh the surfaces that show it. */
function rememberWorkspace(dir) {
  const previous = Array.isArray(state.recentWorkspaces)
    ? state.recentWorkspaces.filter((candidate) => typeof candidate === 'string')
    : [];
  const next = [dir, ...previous.filter((candidate) => candidate !== dir)].slice(0, MAX_RECENT_WORKSPACES);
  saveState({ recentWorkspaces: next });
  refreshJumpList();
  return next;
}

/**
 * Rebuild the Windows jump list from the remembered workspaces.
 *
 * `app.setJumpList` returns the result rather than throwing, so the return value
 * is logged: a jump list that silently failed is otherwise indistinguishable
 * from one that is simply not there.
 */
function refreshJumpList() {
  if (process.platform !== 'win32') return;
  // On a first run there is no recent list yet, so the workspace actually in use
  // seeds it — otherwise the jump list is empty exactly when a user first looks.
  const remembered = Array.isArray(state.recentWorkspaces)
    ? state.recentWorkspaces.filter((dir) => typeof dir === 'string')
    : [];
  const recent =
    remembered.length > 0 ? remembered : typeof state.lastWorkspace === 'string' ? [state.lastWorkspace] : [];
  const base = app.isPackaged ? [] : [app.getAppPath()];
  const tasks = [
    { type: 'task', title: `Open ${APP_NAME}`, program: process.execPath, args: [...base] },
    ...recent.map((dir) => ({
      type: 'task',
      title: `Open ${basename(dir)}`,
      program: process.execPath,
      args: [...base, dir],
    })),
  ];
  try {
    log(`jump list: ${String(app.setJumpList([{ type: 'tasks', items: tasks }]))} (${tasks.length} tasks)`);
  } catch (error) {
    log(`could not build the jump list: ${error.message}`);
  }
}

/**
 * Claim the global shortcut, or say why not.
 *
 * An accelerator another program owns is not a startup failure: `register`
 * returns false, and the shell carries on without it.
 */
function registerHotkey() {
  const accelerator = config.globalHotkey;
  if (accelerator === null) {
    log('global hotkey disabled by config');
    return;
  }
  try {
    const claimed = globalShortcut.register(accelerator, () => {
      if (win === null || win.isDestroyed()) return;
      if (win.isVisible() && !win.isMinimized()) {
        win.hide();
      } else {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      }
    });
    log(
      claimed
        ? `global hotkey registered: ${accelerator}`
        : `could not register ${accelerator}: another program already owns it`,
    );
  } catch (error) {
    log(`could not register ${accelerator}: ${error.message}`);
  }
}

/**
 * Notice that the installed DSH changed under us.
 *
 * The shell follows the installation through a junction, so an upgrade is picked
 * up automatically — which is exactly why it is worth saying out loud when it
 * happens, rather than letting a different harness appear with no explanation.
 *
 * @param version - the version this boot found.
 */
function noteDshVersion(version) {
  const previous = typeof state.lastDshVersion === 'string' ? state.lastDshVersion : null;
  if (previous === null) {
    saveState({ lastDshVersion: version });
    return;
  }
  if (previous !== version) {
    log(`the installed DSH changed: ${previous} -> ${version}`);
    saveState({ lastDshVersion: version });
  }
}

/**
 * Write a support bundle and reveal it.
 *
 * Everything in it goes through the aggressive redactor, because this is the one
 * file whose whole purpose is to leave this machine.
 *
 * @returns the path written.
 */
function exportDiagnostics() {
  const wanted = readdirSync(LOG_DIR)
    .filter((name) => name.startsWith('app-') && name.endsWith('.log'))
    .map((name) => ({ name, at: statSync(join(LOG_DIR, name)).mtimeMs }))
    .sort((a, b) => a.at - b.at)
    .slice(-3);
  const logs = wanted.map(({ name }) => {
    try {
      return { name, text: readFileSync(join(LOG_DIR, name), 'utf8') };
    } catch (error) {
      return { name, text: `(unreadable: ${error.message})` };
    }
  });

  const text = buildDiagnostics({
    versions: {
      app: app.getVersion(),
      electron: process.versions.electron,
      node: process.versions.node,
      dsh: dshVersion,
    },
    anchor: anchorInfo,
    runtime: { userData: USER_DATA, logDir: LOG_DIR, nodeExe: nodeExePath, home: app.getPath('home') },
    windows: [{ id: 1, workspace, port: currentPort, state: currentUrl === null ? 'starting' : 'ready' }],
    config,
    state,
    logs,
  });

  const target = join(USER_DATA, `diagnostics-${timestamp().replace(/[:.]/g, '-')}.txt`);
  try {
    writeFileSync(target, text, 'utf8');
    log(`diagnostics written to ${target}`);
    void shell.openPath(USER_DATA);
  } catch (error) {
    log(`could not write the diagnostics bundle: ${error.message}`);
    return null;
  }
  return target;
}

// ---------------------------------------------------------------------------
// Startup and shutdown
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  log('another instance owns the lock; exiting');
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    try {
      const requested = workspaceFromArgv(argv.slice(1));
      log(`second instance requested; requested workspace=${JSON.stringify(requested)} argv=${argv.join(' ')}`);
      if (win === null) {
        workspace = requested ?? workspace;
        createWindow();
        return;
      }
      const reveal = () => {
        if (win === null) return;
        if (win.isMinimized()) win.restore();
        // `focus()` alone does nothing to a window that closeToTray has hidden,
        // which left a hidden window unreachable from a second launch — measured.
        if (!win.isVisible()) win.show();
        win.focus();
      };
      if (requested !== null && requested !== workspace) {
        void switchWorkspace(requested).then(reveal, (error) => {
          log(`could not switch to ${requested}: ${error?.message ?? String(error)}`);
          reveal();
        });
      } else {
        reveal();
      }
    } catch (error) {
      // An exception inside this handler is otherwise an unobserved rejection in
      // a process with no console, which is how a silent no-op looks.
      log(`second-instance handling failed: ${error?.stack ?? error?.message ?? String(error)}`);
    }
  });

  app.whenReady().then(async () => {
    pruneLogs();
    createWindow();
    buildMenu();
    buildTray();
    registerSettingsIpc();
    registerHotkey();
    refreshJumpList();
    if (process.argv.includes('--settings')) openSettingsWindow();

    // Reap a child left behind by a previous run before starting a new one, so
    // a hard-killed shell cannot leave two harnesses holding one profile. A
    // refused reap keeps the record: it is the only handle on that process, and
    // dropping it is what turns an orphan into an invisible one.
    const reaped = reapStaleChild(state.child ?? null, log);
    if (reaped.outcome === 'refused') {
      log(`keeping the previous child record (pid ${String(reaped.pid)}): ${reaped.reason}`);
    } else {
      saveState({ child: null });
    }

    let nodeExe;
    let anchor;
    try {
      const dshHome = resolveDshHome();
      log(`DSH_HOME: ${dshHome}`);
      nodeExe = resolveNodeExe();
      anchor = resolveInstallAnchor(dshHome);
      dshVersion = anchor.version;
      anchorInfo = { dir: anchor.dir, binPath: anchor.binPath };
      nodeExePath = nodeExe;
      noteDshVersion(anchor.version);
      log(`node: ${nodeExe}`);
      log(`dsh: ${anchor.version} at ${anchor.dir}`);
    } catch (error) {
      log(`startup refused: ${error.message}`);
      showStatus(error.message, true);
      return;
    }

    supervisor = new HarnessSupervisor({
      nodeExe,
      anchor,
      config,
      cwd: workspace,
      log,
      onReady: (url) => {
        // The full URL is held in memory for this launch only. It carries the
        // process launch token, which is a live credential: the state file gets
        // the origin (useful, and dead the moment this process exits), never the
        // token, and the log gets neither.
        currentUrl = url.href;
        currentPort = url.port;
        saveState({ lastWorkspace: workspace, guiUrl: url.origin });
        log(`loading ${url.origin}/ (token withheld from the log and the state file)`);
        // The token exchange answers 303 and redirects to the clean root, so the
        // URL that finally renders is never equal to the one requested. Track
        // completion with a flag rather than by comparing URLs: an earlier
        // version compared them and reported a healthy page as stuck.
        harnessPageLoaded = false;
        win?.loadURL(url.href).catch((error) => log(`could not load the harness URL: ${error.message}`));
        if (process.env.DSH_DESKTOP_DIAG === '1') void diagnoseConnectivity(url.origin);
        // Watchdog: a navigation that neither finishes nor fails is invisible in
        // an event log, which is how this shell first produced a window stuck on
        // an error page with nothing recorded to explain it.
        setTimeout(() => {
          if (win === null || win.isDestroyed() || harnessPageLoaded) return;
          log(
            `the window has not finished loading after 20s — ` +
              `url=${redactToken(win.webContents.getURL())} loading=${String(win.webContents.isLoading())} ` +
              `title=${JSON.stringify(win.webContents.getTitle())}`,
          );
          showStatus('The harness is running, but its interface did not load. See Help → Show Log Folder.', true);
        }, 20_000);
      },
      onStatus: (status) => {
        if (status.kind === 'starting') showStatus('Starting DeepSeek Harness…');
        if (status.kind === 'restarting') showStatus(`The harness stopped; restarting (attempt ${status.attempt})…`);
        if (status.kind === 'failed') showStatus(status.message, true);
      },
      onRecord: (record) =>
        saveState({
          // Everything the reaper will later check the live process against, so
          // the identity check is a description match rather than a guess.
          child:
            record === null
              ? null
              : {
                  pid: record.pid,
                  startedAt: record.startedAt,
                  binPath: anchor.binPath,
                  nodeExe,
                  parentPid: process.pid,
                  args: record.args,
                  cwd: workspace,
                },
        }),
      onGiveUp: (message) => void surfaceFailure(message),
    });
    supervisor.start();
  }).catch((error) => {
    // Without this, a throw anywhere in the startup callback becomes an
    // unobserved rejected promise: no window content, no message, and — in a
    // packaged app — no stderr for anyone to read.
    log(`startup failed: ${error?.stack ?? error?.message ?? String(error)}`);
    showStatus(`DSH Desktop could not start.\n\n${error?.message ?? String(error)}`, true);
  });

  app.on('window-all-closed', () => {
    if (!config.closeToTray) app.quit();
  });

  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    // Give the accelerator back: a registered shortcut outlives the window that
    // wanted it until the process ends, and this process may take a while to.
    globalShortcut.unregisterAll();
    saveWindowGeometry();
    const stopping = supervisor === null ? Promise.resolve({ gone: true }) : supervisor.stop();
    // A hard bound on top of the supervisor's own. `stop()` always settles
    // because its grace timer is part of its race, but this is what guarantees
    // the process can leave even if that assumption ever stops holding — and
    // `quitting` is already true, so nothing else will retry the quit.
    const abandon = new Promise((resolve) =>
      setTimeout(() => resolve({ gone: false, abandoned: true }), Math.max(2000, config.graceMs + 2000)),
    );
    void Promise.race([stopping, abandon]).then(
      (outcome) => {
        const gone = outcome?.gone === true;
        // The record is cleared only when the child is confirmed gone: keeping a
        // stale record is recoverable, losing a live one is not.
        if (gone) saveState({ child: null });
        else log('the harness child could not be confirmed gone; keeping its record so the next launch reaps it');
        log(`quit complete (child gone: ${String(gone)})`);
        app.exit(0);
      },
      (error) => {
        log(`quit cleanup failed: ${error?.message ?? String(error)}; leaving the record in place`);
        app.exit(0);
      },
    );
  });
}
