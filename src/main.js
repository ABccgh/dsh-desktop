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

import { app, BrowserWindow, Menu, Tray, clipboard, dialog, nativeImage, screen, shell } from 'electron';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeConfig } from './config.mjs';
import { HarnessSupervisor } from './harness.mjs';
import { resolveDshHome, resolveInstallAnchor, resolveNodeExe } from './paths.mjs';
import { reapStaleChild } from './reap.mjs';
import { redactToken } from './url-line.mjs';

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

// ---------------------------------------------------------------------------
// Logging. One file per run, under userData; the last ten are kept.
// ---------------------------------------------------------------------------

mkdirSync(LOG_DIR, { recursive: true });
const logPath = join(LOG_DIR, `app-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);

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
  const line = `${new Date().toISOString()} ${message}\n`;
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
let state = readJson(STATE_PATH, {});
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
  const fromArgv = process.argv
    .slice(app.isPackaged ? 1 : 2)
    .find((argument) => !argument.startsWith('-') && existsSync(argument) && statSync(argument).isDirectory());
  if (fromArgv !== undefined) {
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
 * Restore the last window geometry, rejecting positions on displays that are
 * no longer attached so the window cannot come back off-screen.
 * @returns geometry to pass to the BrowserWindow constructor.
 */
function restoreGeometry() {
  const saved = state.window;
  const fallback = { width: 1280, height: 860 };
  if (saved === undefined || saved === null) return fallback;
  const { width, height, x, y } = saved;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 640 || height < 480) return fallback;
  if (!Number.isInteger(x) || !Number.isInteger(y)) return { width, height };
  // Reject a position that no longer lands on an attached display, so a window
  // saved on a since-unplugged monitor cannot come back invisible.
  const displays = screen.getAllDisplays();
  const visible = displays.some(
    (display) =>
      x + 80 > display.workArea.x &&
      y + 40 > display.workArea.y &&
      x < display.workArea.x + display.workArea.width &&
      y < display.workArea.y + display.workArea.height,
  );
  return visible ? { width, height, x, y } : { width, height };
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
 * Create the shell window and show the loading page until the harness is ready.
 * @returns the created window.
 */
function createWindow() {
  const geometry = restoreGeometry();
  win = new BrowserWindow({
    ...geometry,
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
    const text = typeof event?.message === 'string' ? event.message : String(message ?? '');
    const where = typeof event?.sourceId === 'string' && event.sourceId !== '' ? ` (${event.sourceId}:${String(event.lineNumber ?? '?')})` : '';
    log(`[page:${String(event?.level ?? level ?? '?')}] ${redactToken(text)}${where}`);
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
    log(`external link: ${url}`);
    shell.openExternal(url).catch((error) => log(`could not open ${url}: ${error.message}`));
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    const origin = currentUrl === null ? null : new URL(currentUrl).origin;
    if (origin !== null && new URL(url).origin === origin) return;
    event.preventDefault();
    log(`blocked navigation to ${url}`);
    shell.openExternal(url).catch(() => {});
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
  });
  win.on('resize', saveWindowGeometrySoon);
  win.on('move', saveWindowGeometrySoon);

  win.loadFile(join(HERE, 'loading.html')).catch((error) => log(`could not load the loading page: ${error.message}`));
  if (state.window?.maximized === true) win.maximize();
  showStatus('Starting DeepSeek Harness…');
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
  const chosen = result.filePaths[0];
  log(`workspace switched to ${chosen}`);
  workspace = chosen;
  saveState({ lastWorkspace: chosen });
  showStatus(`Restarting DeepSeek Harness in ${chosen}…`);
  currentUrl = null;
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
    tray.setToolTip(APP_NAME);
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

// ---------------------------------------------------------------------------
// Startup and shutdown
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  log('another instance owns the lock; exiting');
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    log(`second instance requested; focusing. argv=${argv.join(' ')}`);
    if (win === null) createWindow();
    else {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    pruneLogs();
    createWindow();
    buildMenu();
    buildTray();

    // Reap a child left behind by a previous run before starting a new one, so
    // a hard-killed shell cannot leave two harnesses holding one profile.
    reapStaleChild(state.child ?? null, log);
    saveState({ child: null });

    let nodeExe;
    let anchor;
    try {
      const dshHome = resolveDshHome();
      log(`DSH_HOME: ${dshHome}`);
      nodeExe = resolveNodeExe();
      anchor = resolveInstallAnchor(dshHome);
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
          child:
            record === null
              ? null
              : { pid: record.pid, startedAt: record.startedAt, binPath: anchor.binPath, cwd: workspace },
        }),
      onGiveUp: (message) => showStatus(message, true),
    });
    supervisor.start();
  });

  app.on('window-all-closed', () => {
    if (!config.closeToTray) app.quit();
  });

  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    saveWindowGeometry();
    const stopping = supervisor === null ? Promise.resolve() : supervisor.stop();
    void stopping.finally(() => {
      saveState({ child: null });
      log('quit complete');
      app.exit(0);
    });
  });
}
