import { app, BrowserWindow, BrowserView, Menu, ipcMain, shell, dialog } from 'electron';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { initAutoUpdater, checkForUpdates, installUpdate, getVersion } from './auto-update.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PORT = Number(process.env.PORT || 3022);
const HOST = process.env.HOST || '127.0.0.1';
const URL = `http://${HOST}:${PORT}/admin/scrape`;
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
            message: 'Arbiter',
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
      preload: join(__dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  browserView = new BrowserView({
    webPreferences: {
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
  
  // Initialize auto-updater
  initAutoUpdater(mainWindow);
  
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
