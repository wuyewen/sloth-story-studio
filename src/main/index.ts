import { app, BrowserWindow, nativeImage } from "electron";
import { existsSync } from "node:fs";
import path from "node:path";
import { createTray, getIsQuitting } from "./tray.js";
import { openMainWindow } from "./windows.js";
import { registerIpc } from "./ipc/index.js";

function devAsset(rel: string): string | null {
  // dev 下 electron 从项目根启动，cwd 即项目根；改名 bundle 会导致 app.isPackaged 误判，不用它
  const p = path.join(process.cwd(), "assets", "branding", rel);
  return existsSync(p) ? p : null;
}

export function brandAsset(rel: string): string | null {
  return devAsset(rel) ?? (app.isPackaged ? path.join(process.resourcesPath, "branding", rel) : null);
}

function setDockIcon(): void {
  if (process.platform !== "darwin" || !app.dock) return;
  const iconFile = brandAsset("app-icon-512.png");
  if (!iconFile) return;
  const image = nativeImage.createFromPath(iconFile);
  if (!image.isEmpty()) app.dock.setIcon(image);
}

app.setName("Story Studio");

app.whenReady().then(() => {
  setDockIcon();
  registerIpc();
  createTray();
  openMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) openMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (getIsQuitting()) {
    app.quit();
  }
});
