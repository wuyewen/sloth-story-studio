import { app, BrowserWindow } from "electron";
import { existsSync } from "node:fs";
import path from "node:path";

// 改名后的 dev bundle 会让 app.isPackaged 误判为 true，所以用项目根 index.html 是否存在来判断 dev
const isDev = existsSync(path.join(app.getAppPath(), "index.html")) && existsSync(path.join(app.getAppPath(), "vite.config.ts"));

let mainWindow: BrowserWindow | null = null;
let configWindow: BrowserWindow | null = null;

function appIcon(): string {
  return path.join(
    isDev ? app.getAppPath() : process.resourcesPath,
    isDev ? "assets/branding/app-icon-512.png" : "branding/app-icon-512.png"
  );
}

function loadRenderer(win: BrowserWindow, hash: string): void {
  if (isDev) {
    void win.loadURL(`http://127.0.0.1:5173/#${hash}`);
  } else {
    void win.loadFile(path.join(app.getAppPath(), "dist", "renderer", "index.html"), {
      hash
    });
  }
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

export function openMainWindow(): BrowserWindow {
  const existing = getMainWindow();
  if (existing) {
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
    return existing;
  }

  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 720,
    title: "Sloth Story Studio",
    backgroundColor: "#F1E6CC",
    show: false,
    ...(process.platform === "win32" ? { icon: appIcon() } : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: false
    }
  });

  win.once("ready-to-show", () => win.show());
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });

  loadRenderer(win, "/app");
  mainWindow = win;
  return win;
}

export function openConfigWindow(kind: "models" | "settings"): BrowserWindow {
  if (configWindow && !configWindow.isDestroyed()) {
    loadRenderer(configWindow, `/config/${kind}`);
    configWindow.show();
    configWindow.focus();
    return configWindow;
  }

  const win = new BrowserWindow({
    width: 920,
    height: 840,
    minWidth: 780,
    minHeight: 640,
    title: "Sloth Story Studio",
    backgroundColor: "#F1E6CC",
    show: false,
    ...(process.platform === "win32" ? { icon: appIcon() } : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: false
    }
  });

  win.once("ready-to-show", () => {
    win.center();
    win.show();
  });
  win.on("closed", () => {
    if (configWindow === win) configWindow = null;
  });

  loadRenderer(win, `/config/${kind}`);
  configWindow = win;
  return win;
}
