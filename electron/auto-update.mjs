import { app, autoUpdater, dialog } from 'electron';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const FEED_URL = process.env.ARBITER_UPDATE_FEED || null;
let initialized = false;

export function getVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function initAutoUpdater(mainWindow) {
  if (initialized || !FEED_URL || process.env.ARBITER_DEV === '1' || !app.isPackaged) return false;
  initialized = true;
  autoUpdater.setFeedURL({ url: FEED_URL, headers: { 'User-Agent': `Arbiter/${getVersion()}` } });
  autoUpdater.on('update-available', (info) => mainWindow?.webContents.send('update-available', { version: info.version }));
  autoUpdater.on('update-not-available', () => mainWindow?.webContents.send('update-not-available'));
  autoUpdater.on('update-downloaded', (info) => mainWindow?.webContents.send('update-downloaded', { version: info.version }));
  autoUpdater.on('error', (error) => mainWindow?.webContents.send('update-error', { error: error.message }));
  checkForUpdates(mainWindow, true);
  return true;
}

export function checkForUpdates(mainWindow, silent = false) {
  if (!initialized) return { available: false, reason: 'updates not configured' };
  if (!silent) mainWindow?.webContents.send('update-checking');
  autoUpdater.checkForUpdates();
  return { available: true };
}

export function installUpdate(mainWindow) {
  if (!initialized) return { installed: false, reason: 'updates not configured' };
  const choice = dialog.showMessageBoxSync(mainWindow, {
    type: 'question',
    title: 'Install update',
    message: 'An update has been downloaded. Install it now?',
    buttons: ['Install and Restart', 'Later'],
    defaultId: 0,
    cancelId: 1,
  });
  if (choice === 0) autoUpdater.quitAndInstall();
  return { installed: choice === 0 };
}
