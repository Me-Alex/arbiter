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
  onUpdateProgress: (callback) => ipcRenderer.on('update-progress', (event, data) => callback(data)),
  onUpdateChecking: (callback) => ipcRenderer.on('update-checking', () => callback()),
});

ipcRenderer.on('arbiter:noop', () => {});
