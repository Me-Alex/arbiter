import { contextBridge, ipcRenderer } from 'electron';

/**
 * preload.mjs — context bridge between Electron and the BrowserView.
 *
 * Exposes `window.arbiter` with a small, deliberate surface. The dashboard
 * does NOT get node integration or ipcRenderer directly; it has to call these
 * wrappers.
 */

contextBridge.exposeInMainWorld('arbiter', {
  getVersion: () => ipcRenderer.invoke('arbiter:getVersion'),
  restart: () => ipcRenderer.invoke('arbiter:restart'),
  openExternal: (url) => ipcRenderer.invoke('arbiter:openExternal', url),
  quit: () => ipcRenderer.send('arbiter:quit'),
  checkForUpdates: () => ipcRenderer.invoke('arbiter:checkForUpdates'),
  installUpdate: () => ipcRenderer.invoke('arbiter:installUpdate'),
  onUpdateAvailable: (callback) => ipcRenderer.on('update-available', (event, data) => callback(data)),
  onUpdateNotAvailable: (callback) => ipcRenderer.on('update-not-available', () => callback()),
  onUpdateDownloaded: (callback) => ipcRenderer.on('update-downloaded', (event, data) => callback(data)),
  onUpdateError: (callback) => ipcRenderer.on('update-error', (event, data) => callback(data)),
  // There is deliberately no `onUpdateProgress`. It was here, listening to a
  // channel nothing sends: electron/auto-update.mjs pushes four `update-*`
  // events and a fifth (`update-checking`) from `checkForUpdates`, and progress
  // was not among them. A subscriber to a channel with no sender reads as a
  // wired feature and is not one. `test/ipc-surface.test.mjs` measures both
  // directions and fails if a listener returns without a sender behind it.
  onUpdateChecking: (callback) => ipcRenderer.on('update-checking', () => callback()),
  /**
   * Show a desktop notification. Returns `{ ok, reason? }`; the client falls
   * back to the browser Notification API and then to an in-page banner, so a
   * false here is a downgrade and not a failure.
   */
  notify: (payload) => ipcRenderer.invoke('arbiter:notify', payload),
});
