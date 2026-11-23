import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { startDroneSession, stopDroneSession } from './drone';
import { registerRcHandlers } from './rc';
import { registerImageExplorer } from './imageExplorer';
import { registerDroneFtp } from './droneFtp';
import { registerFastboot } from './fastbootService';

// Native window-control overlay colors per theme (see renderer/theme.tsx).
const TITLE_BAR_OVERLAY = {
  dark: { color: '#0d1117', symbolColor: '#8d99ab', height: 40 },
  light: { color: '#ffffff', symbolColor: '#59647a', height: 40 },
} as const;

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;

const createWindow = () => {
  // Create the browser window.
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 940,
    minHeight: 600,
    // Matches the theme (renderer/theme.tsx) so the window never flashes white.
    backgroundColor: '#0a0d12',
    // Window/taskbar icon in development; the packaged exe uses the icon baked
    // in by Forge (see forge.config.ts). resourcesPath only exists when packaged.
    icon: app.isPackaged
      ? path.join(process.resourcesPath, 'icon.ico')
      : path.join(app.getAppPath(), 'resources', 'icon.ico'),
    // The renderer draws its own 40px title bar (renderer/TitleBar.tsx); the
    // system window buttons are overlaid on its right end.
    titleBarStyle: 'hidden',
    // Defaults to dark; the renderer repaints it via 'window:titlebar-theme'
    // once it has applied the remembered choice.
    titleBarOverlay: TITLE_BAR_OVERLAY.dark,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  // and load the index.html of the app.
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }

  // DevTools in development only, in their own window so they do not squeeze
  // the three-pane layout.
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
};

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
ipcMain.on('window:titlebar-theme', (event, mode: 'light' | 'dark') => {
  const overlay = TITLE_BAR_OVERLAY[mode === 'light' ? 'light' : 'dark'];
  const window = BrowserWindow.fromWebContents(event.sender);
  // setTitleBarOverlay throws if the window has no overlay (e.g. on macOS).
  try {
    window?.setTitleBarOverlay(overlay);
  } catch {
    // No overlay on this platform; nothing to repaint.
  }
});

app.on('ready', () => {
  startDroneSession();
  registerRcHandlers();
  registerImageExplorer();
  registerDroneFtp();
  registerFastboot();
  createWindow();
});

app.on('will-quit', () => {
  void stopDroneSession();
});

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and import them here.
