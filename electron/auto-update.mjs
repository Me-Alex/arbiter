import { app, autoUpdater, dialog } from 'electron';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const FEED_URL = process.env.ARBITER_UPDATE_FEED || null;
let initialized = false;
// Where the `update-*` pushes go. Injected rather than derived from the window
// this module is handed, because the two are different surfaces: `installUpdate`
// needs a BrowserWindow to parent its dialog to, while a push has to reach the
// webContents that renders the page — and in this app that is the BrowserView,
// not the window. Deriving the target from the window is what made every one
// of these pushes land on a frame that loads no page.
let push = null;

/** Send one `update-*` event to the app, if an app surface was wired up. */
const toPage = (channel, payload) => {
  if (typeof push === 'function') push(channel, payload);
};

export function getVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function initAutoUpdater(mainWindow, pushToPage) {
  if (initialized || !FEED_URL || process.env.ARBITER_DEV === '1' || !app.isPackaged) return false;
  initialized = true;
  push = typeof pushToPage === 'function' ? pushToPage : null;
  autoUpdater.setFeedURL({ url: FEED_URL, headers: { 'User-Agent': `Arbiter/${getVersion()}` } });
  autoUpdater.on('update-available', (info) => toPage('update-available', { version: info.version }));
  autoUpdater.on('update-not-available', () => toPage('update-not-available'));
  autoUpdater.on('update-downloaded', (info) => toPage('update-downloaded', { version: info.version }));
  autoUpdater.on('error', (error) => toPage('update-error', { error: error.message }));
  checkForUpdates(mainWindow, true);
  return true;
}

export function checkForUpdates(mainWindow, silent = false) {
  if (!initialized) return { available: false, reason: 'updates not configured' };
  if (!silent) toPage('update-checking');
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
