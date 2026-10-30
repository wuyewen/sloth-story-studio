import { app, Menu, shell } from "electron";
import { openHelpWindow, openMainWindow } from "./windows.js";

// 应用菜单：macOS 顶部菜单栏 / Windows 窗口菜单栏
export function setupAppMenu(): void {
  const isMac = process.platform === "darwin";

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [{
          label: app.name,
          submenu: [
            { role: "about" as const, label: `关于 ${app.name}` },
            { type: "separator" as const },
            { role: "hide" as const, label: "隐藏" },
            { role: "hideOthers" as const, label: "隐藏其他" },
            { type: "separator" as const },
            { role: "quit" as const, label: "退出" }
          ]
        }]
      : []),
    {
      label: "编辑",
      submenu: [
        { role: "undo", label: "撤销" },
        { role: "redo", label: "重做" },
        { type: "separator" },
        { role: "cut", label: "剪切" },
        { role: "copy", label: "复制" },
        { role: "paste", label: "粘贴" },
        { role: "selectAll", label: "全选" }
      ]
    },
    {
      label: "窗口",
      submenu: [
        { label: "打开主窗口", click: () => openMainWindow() },
        { type: "separator" },
        { role: "minimize", label: "最小化" },
        { role: "close", label: "关闭窗口" }
      ]
    },
    {
      label: "帮助",
      role: "help",
      submenu: [
        { label: "使用指南", accelerator: "F1", click: () => openHelpWindow() },
        { type: "separator" },
        {
          label: "项目主页（GitHub）",
          click: () => void shell.openExternal("https://github.com/")
        }
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
