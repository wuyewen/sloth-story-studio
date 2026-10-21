# Sloth Story Studio

本地优先的 AI 小说创作桌面工具（Electron + React + TypeScript）。小说以纯文本（Markdown）保存在你指定的目录里，AI 能力通过 OpenAI 兼容接口接入任意大模型服务。

## 功能总览

### 小说编辑器
- 项目/章节管理：每部小说是一个文件夹（`meta.json` + `chapters/*.md`），可被任意编辑器直接打开
- 编辑器自动保存（防抖落盘）、Markdown 预览、字数统计
- AI 写作面板三种模式：
  - **直接写**：输入描述，流式生成，可插入光标处 / 追加章节 / 另存新章节
  - **多 Agent**：勾选多个 Agent 按序协作，前序输出完整传递给后续，每个 Agent 的输出实时可见
  - **工作流**：选择已配置的工作流运行，节点进度时间线实时更新，成稿一键入章节
- 三种模式都支持随时「停止」（立即中断进行中的 LLM 请求）
- 页面切换不中断：切去别的菜单，AI 生成在后台继续，切回来原样恢复

### Agents
- 自定义 Agent：名称、职责、System Prompt、绑定大模型、temperature、标识色
- 内置 4 个：大纲设计师 / 小说写手 / 审核编辑 / 读者顾问（可改不可删）
- 删除保护：正被工作流使用的 Agent 禁止删除并提示具体引用方

### Workflows（可视化工作流）
- 画布编辑：拖拽节点、连线；节点支持 Agent / Prompt / 备注，起止节点锚定
- 从描述生成：一句话描述流程，LLM 自动生成画布草稿；编辑页还可用「优化」按描述继续调整
- 边样式：曲线 / 折线 / 直线、自定义颜色、标签、条件表达式（如 `output.includes('通过')`）
- 回退循环：自动识别并渲染为琥珀色虚线、走节点上方通道；每个节点可设「最多执行次数」防止无限循环
- 分支并行：一个节点扇出多个下游时并行执行，全部完成后才汇合
- 上下文引用：`{{input}}` 与 `{{nodes.节点名.output}}` 可把任意前序节点的完整输出带进后续节点
- 内置「简易小说工作流」（大纲 → 初稿 → 审核 → 读者 → 修订循环 → 终稿），只读不可改删
- 自动整理：按数据流分层排版，带文字的连线自动加宽列距

### 系统托盘
- 常驻 macOS 菜单栏 / Windows 托盘：打开主窗口、大模型配置、系统设置、退出
- **大模型配置**：多套 OpenAI 兼容服务（名称、地址、API Key、model、显示名、思考模式、上下文长度、启用开关），支持测试连接
- **API Key 安全**：经 Electron `safeStorage` 加密——macOS 用钥匙串、Windows 用 DPAPI，磁盘上只存密文
- **系统设置**：自定义小说存储目录、自定义主窗口背景图（即时生效）

## 数据位置

| 内容 | 位置 |
|---|---|
| 模型配置（key 为密文） | `~/Library/Application Support/Story Studio/models.json`（Windows 为 `%APPDATA%/Story Studio`） |
| Agents / 工作流 | 同目录 `agents.json` / `workflows.json` |
| 应用设置 | 同目录 `settings.json` |
| 小说正文 | `~/Documents/SlothStories`（默认，可自定义） |

## 开发环境
- Node.js 20+，npm 10+
- Windows 或 macOS

## 启动
```bash
npm install
npm run dev
```

`npm run dev` 会先编译主进程、运行 `scripts/dev-prepare.mjs`（macOS 上把 dev 用的 Electron 壳改名为 Story Studio，让 Dock 悬停名/图标正确，仅影响本地 node_modules），再并行启动 Vite 与主进程 watch。

## 构建与打包
```bash
npm run typecheck        # 类型检查
npm run build:renderer   # 仅渲染层
npm run build            # 完整打包（electron-builder，输出 dmg / nsis）
```

## 发布（自动构建安装包）

推送 `v*` 标签即可触发 GitHub Actions 自动构建并发布三平台安装包（`.github/workflows/release.yml`）：

```bash
git tag v1.0.1
git push origin v1.0.1
```

- 构建矩阵：macOS Apple 芯片（arm64）、macOS Intel（x86_64）、Windows（x64）
- 版本号以 tag 为准（CI 临时写入 package.json，不回写仓库）
- 产物自动上传到对应的 GitHub Release
- 未签名：macOS 首次打开需右键 → 打开；消除提示需配置 Apple 开发者证书 secrets

## 目录结构
```
src/
  shared/types.ts        # 主进程与渲染进程的 IPC 契约与数据类型
  main/                  # 主进程：托盘、窗口、preload、IPC、LLM 客户端、
                         #       小说文件系统、工作流引擎、JSON 持久化、safeStorage 加密
  renderer/              # React UI：编辑器 / Agents / Workflows 页面、
                         #       工作流画布（@xyflow/react）、托盘配置窗口
scripts/dev-prepare.mjs  # dev 模式下修正 Dock 名称与图标的本地脚本
assets/branding/         # 图标与品牌素材
```

## 品牌素材
素材位于 `assets/branding/`，界面通过 `assets/branding/...` 引用：
- `app-icon-512.png` / `app-icon-1024.png`：侧边栏品牌、Dock 图标、打包图标（`app-icon.icns`）
- `sidebar-mark-256.png`：托盘菜单栏图标来源
- `tray-icon.png` / `tray-icon@2x.png`：托盘图标（内嵌于主进程代码，不依赖文件路径）
- `favicon-16/32.png`：页面图标
- `brand-board.png`：品牌参考板
