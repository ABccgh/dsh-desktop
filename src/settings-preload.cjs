/**
 * The settings window's bridge.
 *
 * CommonJS on purpose: this window keeps `sandbox: true`, and a sandboxed
 * preload is loaded as a classic script — an ESM preload would require turning
 * the sandbox off, which is not a trade this window is worth.
 *
 * The surface is deliberately six named calls rather than a general "send this
 * to the main process". The renderer chooses *which* operation, never *what it
 * is allowed to do*: every argument is validated on the other side, and the only
 * path-like value it can name is one of two fixed directory keys.
 *
 * @module dsh-desktop/settings-preload
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dshSettings', {
  /** Current settings, versions, paths and the running workspace. */
  read: () => ipcRenderer.invoke('settings:read'),
  /** Persist a settings object; the main process validates it. */
  save: (values) => ipcRenderer.invoke('settings:save', values),
  /** Open the native folder picker; returns the chosen path or null. */
  chooseWorkspace: () => ipcRenderer.invoke('settings:choose-workspace'),
  /** Restart the harness child, e.g. after changing the port. */
  restartHarness: () => ipcRenderer.invoke('settings:restart-harness'),
  /** Reveal one of the shell's own directories: 'logs' or 'data'. */
  openPath: (which) => ipcRenderer.invoke('settings:open-path', which),
  /** Close this window. */
  close: () => ipcRenderer.invoke('settings:close'),
  /** Write a support bundle; resolves to its path, or null on failure. */
  exportDiagnostics: () => ipcRenderer.invoke('diagnostics:export'),
  /** This window's own copy, keyed by message id; no argument, so nothing new is reachable. */
  strings: () => ipcRenderer.invoke('settings:strings'),
});
