import { app, Menu, nativeImage, Tray } from "electron";
import { openConfigWindow, openMainWindow } from "./windows.js";

let tray: Tray | null = null;
let isQuitting = false;

export function getIsQuitting(): boolean {
  return isQuitting;
}


export function createTray(): Tray {
  if (tray) return tray;

  const image = nativeImage.createFromDataURL("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABIAAAASCAYAAABWzo5XAAAAAXNSR0IArs4c6QAAAERlWElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAEqADAAQAAAABAAAAEgAAAACaqbJVAAAB8ElEQVQ4Ea3TS4iOURgH8JdxiahpNhgj12kKU8qlXGI2U0ppir3bAklqioXEwkZkY2XBJBbIgp2ILKaREkoZcptJucwsNCHXz/D7v8aXUrKYp37fOX3fe855nue8X1EMU4z4xz6L/RaT+ModrlHhv6LeU2fo5xMveEwvF2kkUUcLIylG5eOPqDU/RSv3OMlzknkNya6ZpzTQRid/xV7fpIyUkLIO08c3BrjBRkaTyDiDMitjMYvxJPVumsiiH5xmO4uYyw62kSzHsnVoNBTFeS6zjtUc4TPZYA6TSeziCheYRjVSd3bexHK+cIkT3Oc2R0nGFZJBslzBLXooI81OnePIhoOk0Zl/ZD8p9xhjyOIOJpJIWe84myZlo0hDu2gZmi80XqWd3NwjcsABmmjkOEuoXn8eeMIblpFNJ9DKOXqZQha9ZzMpr4+0p9zoeyYivVlFHSnxAQdpID2aR55NRrnhND2HZ8Py/nN63p2kv5I0vJ8sSCzgFTtp4yGz2UMt3VQzemaezXJS+pZmbuEmublDJNazlg18IFX08Ks+Y5o9nWyylJQwkzV0kpupJ9nsIzd4nQ5eMljjI5Fa55NFb0nz80LeJS9qMsnV54D0JP/D3SSb9LNckPF3TDV5Td6vvFvJJFnmkArNDNBFbm/44yeaz3bdiBDMEAAAAABJRU5ErkJggg==");
  image.addRepresentation({ scaleFactor: 2, buffer: Buffer.from("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", "base64") });

  if (process.platform === "darwin") image.setTemplateImage(true);
  tray = new Tray(image);
  tray.setToolTip("Sloth Story Studio");

  const menu = Menu.buildFromTemplate([
    { label: "打开主窗口", click: () => openMainWindow() },
    { label: "大模型配置", click: () => openConfigWindow("models") },
    { label: "系统设置", click: () => openConfigWindow("settings") },
    { type: "separator" },
    {
      label: "退出",
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);
  tray.setContextMenu(menu);
  tray.on("click", () => openMainWindow());

  return tray;
}
