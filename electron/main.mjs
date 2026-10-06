import { app, BrowserWindow, BrowserView, Menu, ipcMain, shell, dialog, Notification } from 'electron';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { initAutoUpdater, checkForUpdates, installUpdate, getVersion } from './auto-update.mjs';
import { normalizeNotification } from './notification.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PORT = Number(process.env.PORT || 3022);
const HOST = process.env.HOST || '127.0.0.1';
// The console opens on Arbitrage, which is the page an operator wants on
// launch: it is the scan, ranked. Scrape is one nav item away and still on the
// sidebar of every console page.
//
// With the `.html` suffix, because serveStatic maps only "/" to /index.html and
// reads every other path verbatim — the extensionless form this used to carry
// 404s, which is why src/server.mjs logs the suffixed form and this did not
// match it.
const URL = `http://${HOST}:${PORT}/admin/arbitrage.html`;
const IS_DEV = process.env.ARBITER_DEV === '1';

let serverProcess = null;
let mainWindow = null;
let browserView = null;

/** Spawn the Node server as a child process. */
function startServer() {
  serverProcess = spawn(process.execPath, [join(ROOT, 'src', 'server.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST,
      ARBITER_DATA_DIR: process.env.ARBITER_DATA_DIR || join(ROOT, 'data'),
      ELECTRON_RUN_AS_NODE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  serverProcess.stdout.on('data', (chunk) => process.stdout.write(`[server] ${chunk}`));
  serverProcess.stderr.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`));
  serverProcess.on('exit', (code) => {
    console.error(`[electron] server exited with code ${code}`);
    if (mainWindow) {
      dialog.showErrorBox('Server crashed', `The local Node server exited with code ${code}.`);
      app.quit();
    }
  });
}

/** Poll the server until it prints "Arbitrage dashboard". */
function waitForServer({ timeoutMs = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = setInterval(async () => {
      if (Date.now() - start > timeoutMs) {
        clearInterval(tick);
        return reject(new Error(`server did not start within ${timeoutMs}ms`));
      }
      try {
        const res = await fetch(URL, { method: 'GET' });
        if (res.ok || res.status === 404 || res.status === 200) {
          clearInterval(tick);
          return resolve();
        }
      } catch {
        // not yet
      }
    }, 250);
  });
}

function buildAppMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Restart server',
          accelerator: 'CmdOrCtrl+R',
          click: () => restartServer(),
        },
        { type: 'separator' },
        // The two halves of the updater, called in the main process exactly the
        // way `Restart server` above is: the capability lives here and the menu
        // is its front end, so the renderer needs no bridge for either. They sit
        // on the same list as the restart because they are the same kind of
        // thing — something the operator triggers on purpose.
        {
          label: 'Check for updates',
          click: () => checkForUpdates(mainWindow),
        },
        {
          label: 'Install update and restart',
          click: () => installUpdate(mainWindow),
        },
        { type: 'separator' },
        { role: isMac ? 'close' : 'quit' },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Reload',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => {
            if (browserView) browserView.webContents.reload();
          },
        },
        {
          label: 'Toggle DevTools',
          accelerator: isMac ? 'Alt+Cmd+I' : 'Ctrl+Shift+I',
          click: () => {
            if (browserView) browserView.webContents.toggleDevTools();
          },
        },
      ],
    },
    {
      role: 'help',
      submenu: [
        {
          label: 'About Arbiter',
          click: () => dialog.showMessageBox({
            type: 'info',
            title: 'Arbiter',
            message: `Arbiter ${getVersion()}`,
            detail: 'Local-first sports arbitrage scanner for Romanian bookmakers.',
          }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    backgroundColor: '#0e1117',
    show: false,
    title: 'Arbiter',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // The preload belongs HERE and not on the window above. `mainWindow` is a
  // frame that holds a BrowserView and loads no page of its own, so a preload
  // on it never runs; the app runs in `browserView`, which is why Reload,
  // DevTools and `restartServer` below all address `browserView.webContents`
  // rather than `mainWindow.webContents`.
  //
  // With the preload on the wrong surface `window.arbiter` is undefined in the
  // page, and the first rung of the alert ladder (public/js/alerts.js) silently
  // never fires: it asks the main process for a desktop notification, gets
  // nothing back, and degrades a rung down with no error anywhere. The
  // capability was there the whole time. `restartServer` reloading the view is
  // the proof that the two surfaces were already known to be different; the
  // preload just was not moved with it.
  browserView = new BrowserView({
    webPreferences: {
      preload: join(__dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.setBrowserView(browserView);
  browserView.setBounds({ x: 0, y: 0, width: 1280, height: 820 });
  browserView.setAutoResize({ width: true, height: true });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  if (IS_DEV) browserView.webContents.openDevTools({ mode: 'detach' });

  browserView.webContents.on('did-fail-load', (_e, code, desc) => {
    console.error(`[electron] failed to load ${URL}: ${code} ${desc}`);
  });

  // open external links in default browser, not inside the app.
  browserView.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function restartServer() {
  if (serverProcess) {
    try { serverProcess.kill(); } catch { /* ignore */ }
  }
  startServer();
  waitForServer().then(() => {
    if (browserView) browserView.webContents.reload();
  }).catch((err) => {
    console.error('[electron] restart failed', err);
  });
}

ipcMain.handle('arbiter:restart', () => {
  restartServer();
  return { ok: true };
});
ipcMain.handle('arbiter:openExternal', (_e, url) => {
  if (typeof url === 'string' && /^https?:/.test(url)) shell.openExternal(url);
  return { ok: true };
});
ipcMain.handle('arbiter:checkForUpdates', () => {
  checkForUpdates(mainWindow);
  return { ok: true };
});
ipcMain.handle('arbiter:installUpdate', () => {
  installUpdate(mainWindow);
  return { ok: true };
});
ipcMain.handle('arbiter:getVersion', () => {
  return { version: getVersion() };
});

// `preload.quit` sends this one, and nothing answered it: the six `handle`
// calls above are the whole list, so a renderer calling `window.arbiter.quit()`
// fired a message into a channel with no listener and nothing happened. The
// menu's `{ role: quit }` covers the operator, which is why this went unnoticed
// — but the bridge is exposed, so it is either answered or absent.
ipcMain.on('arbiter:quit', () => app.quit());

/**
 * Desktop notifications, asked for by the alert client in the renderer.
 *
 * The renderer cannot raise one on its own here: the page runs in a BrowserView
 * with contextIsolation on, and rather than reaching for the web Notification
 * API — which would need a permission round trip and still does not exist in a
 * plain browser tab on Linux — the page asks the main process, which can.
 *
 * `shown` exists because Electron's Notification has no tag: without it a
 * re-alerted opportunity stacks a second identical toast behind the first, and
 * by the fifth the trader has stopped reading them. Same tag replaces.
 */
const shownNotifications = new Map();

ipcMain.handle('arbiter:notify', (_e, payload) => {
  const note = normalizeNotification(payload);
  if (!note) return { ok: false, reason: 'empty' };
  if (!Notification.isSupported()) return { ok: false, reason: 'unsupported' };

  // An untagged notification is a one-off, so it must not evict a real alert
  // that is still on screen and be evicted by the next one.
  if (note.tag && shownNotifications.has(note.tag)) {
    shownNotifications.get(note.tag).close();
    shownNotifications.delete(note.tag);
  }
  // Bound the map even when every notification is untagged and nothing is ever
  // replaced: a long session must not grow a Map of dead objects forever.
  if (shownNotifications.size >= MAX_TRACKED_NOTIFICATIONS) {
    const oldest = shownNotifications.keys().next().value;
    if (oldest !== undefined) shownNotifications.delete(oldest);
  }

  const notification = new Notification({ title: note.title, body: note.body, silent: note.silent });
  notification.on('click', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  notification.on('close', () => {
    if (note.tag && shownNotifications.get(note.tag) === notification) shownNotifications.delete(note.tag);
  });
  notification.show();
  if (note.tag) shownNotifications.set(note.tag, notification);
  return { ok: true, tagged: Boolean(note.tag) };
});

/** A ceiling on the replacement map, not on notifications shown — those are the user's to see. */
const MAX_TRACKED_NOTIFICATIONS = 50;

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  startServer();
  try {
    await waitForServer();
  } catch (err) {
    console.error('[electron] server failed to start:', err.message);
    dialog.showErrorBox('Startup failed', err.message);
    app.quit();
    return;
  }
  buildAppMenu();
  createWindow();
  
  // Initialize auto-updater. The window parents the install dialog; the
  // BrowserView's webContents is what actually renders the app, so it is the
  // target the `update-*` pushes must go to. Passing the window for both is
  // how they ended up on a surface with no listener.
  initAutoUpdater(mainWindow, (channel, payload) => browserView?.webContents.send(channel, payload));
  
  browserView.webContents.loadURL(URL);
});

app.on('window-all-closed', () => {
  if (serverProcess) {
    try { serverProcess.kill(); } catch { /* ignore */ }
  }
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
