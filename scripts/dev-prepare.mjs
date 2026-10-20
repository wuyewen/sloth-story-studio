// dev 模式下让 macOS Dock 悬停名/应用菜单显示 "Story Studio" 而不是 "Electron"：
// 复制 Electron.app 为 "Story Studio.app"，改写其 CFBundleName，并把 electron 启动器的
// path.txt 指向新 bundle。仅影响本地开发环境（node_modules），不影响打包产物。
import { execFileSync, execSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";

if (process.platform === "darwin") {
  const distDir = "node_modules/electron/dist";
  const srcApp = `${distDir}/Electron.app`;
  const dstApp = `${distDir}/Story Studio.app`;

  if (existsSync(srcApp)) {
    if (!existsSync(dstApp)) {
      execSync(`cp -R "${srcApp}" "${dstApp}"`);
      console.log("[dev-prepare] copied Electron.app -> Story Studio.app");
    }
    const plist = `${dstApp}/Contents/Info.plist`;
    for (const key of ["CFBundleName", "CFBundleDisplayName"]) {
      try {
        execFileSync("/usr/libexec/PlistBuddy", ["-c", `Set :${key} Story Studio`, plist], { stdio: "pipe" });
      } catch {
        try {
          execFileSync("/usr/libexec/PlistBuddy", ["-c", `Add :${key} string Story Studio`, plist], { stdio: "pipe" });
        } catch {
          // 忽略：无权限或 plist 结构异常时跳过
        }
      }
    }
    // macOS 的 Dock 悬停名/进程名取自可执行文件名，一并改名
    const oldExec = `${dstApp}/Contents/MacOS/Electron`;
    const newExec = `${dstApp}/Contents/MacOS/Story Studio`;
    if (existsSync(oldExec) && !existsSync(newExec)) {
      execSync(`mv "${oldExec}" "${newExec}"`);
      try {
        execFileSync("/usr/libexec/PlistBuddy", ["-c", "Set :CFBundleExecutable Story Studio", plist], { stdio: "pipe" });
      } catch {
        // 忽略
      }
    }
    writeFileSync("node_modules/electron/path.txt", "Story Studio.app/Contents/MacOS/Story Studio");
    const icns = "assets/branding/app-icon.icns";
    if (existsSync(icns)) {
      execSync(`cp "${icns}" "${dstApp}/Contents/Resources/electron.icns"`);
    }
    try {
      execFileSync(
        "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
        ["-f", `${process.cwd()}/${dstApp}`],
        { stdio: "pipe" }
      );
    } catch {
      // lsregister 失败不阻塞启动
    }
    console.log("[dev-prepare] dev bundle name set to Story Studio");
  }
}
