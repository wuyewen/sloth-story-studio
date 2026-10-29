# Sloth Story Studio

本地优先的 AI 小说创作桌面工具（Electron + React + TypeScript）。小说以纯文本（Markdown）保存在你指定的目录里，AI 能力通过 OpenAI 兼容接口接入任意大模型服务。

## 功能总览

### 创作工作台（每部小说一个）
- 快捷入口：**全书规划 / 规划新单元 / 创作下一章 / 单元复盘**，各绑定一个工作流，输入要求后后台执行，可最小化去编辑别的内容
- **入口守卫**：明显无意义的操作直接拦下（如无单元时创作章节）、可能误操作的弹窗警告可继续（如已有章节时再规划新单元、已有大纲时重跑全书规划）
- 项目概览：标题旁实时显示单元数 / 章节数 / 总字数
- **自定义创作流水线**：描述想要的流程（或选预设风格），LLM 自动生成所需 Agent + 工作流并归入本书分组；Agent 只定义职责，文风统一由绑定的风格模板注入，不冲突
- **共享记忆管理**：
  - 记忆文件（Markdown 自由文本：大纲、世界观、风格规范等），带历史版本与回滚
  - **结构化状态库**：角色 / 伏笔 / 事件 / 道具 / 规则 / 地点六类实体，逐条带来源章节、置信度（已确认 / 推断）、锁定与冲突标记；冲突不静默覆盖
  - 工作流产出的记忆变更走**待审核提案区**，接受才落库
- **章节记忆提取**：章节写完后一键提取新事实（LLM → 逐条审阅勾选 → 落库），自动物化为 `state-*.md` 供工作流引用
- **运行记录**：每次运行的节点时间线（每节点状态 / 耗时 / token / 模型，可展开看输入输出与上下文来源）、运行输入、最终输出一键复制；「存入新章节」仅章节创作工作流显示

### 小说编辑器
- 项目/单元/章节管理：每部小说是一个文件夹（`meta.json` + `chapters/*.md`），单元可重命名/删除，章节支持右键重命名
- 编辑器自动保存（防抖落盘）、Markdown 预览、字数统计
- **版本历史**：所有保存链路（手动 / 工作流 / 回滚）自动快照，版本列表 + 行级 diff 对比 + 一键回滚（回滚本身也留快照）
- AI 写作面板三种模式：**直接写**（流式生成）、**多 Agent**（按序协作）、**工作流**（节点进度实时更新，成稿一键入章节）
- 三种模式都支持随时「停止」；页面切换不中断后台生成

### Agents
- 自定义 Agent：名称、职责、System Prompt、绑定大模型、temperature、标识色
- 内置 4 个：大纲设计师 / 小说写手 / 审核编辑 / 读者顾问（可改不可删）
- **分组**：新增/删除/重命名分组，拖拽或下拉归组；画布选 Agent 可按分组过滤
- 删除保护：正被工作流使用的 Agent 禁止删除并提示具体引用方

### Workflows（可视化工作流）
- 节点类型：Agent / Prompt / **结构化审核**（七维度、严重度分级、契约校验 JSON 输出）/ **局部修订**（old/new 替换对，引擎程序化打补丁，未标记区域逐字不变；审核通过时零调用短路透传）/ **上下文构建**（零 token 组装风格+状态+记忆+最近章节，带预算截断）/ 备注 / 起止（结束节点可指定"输出来源"，多分支汇合时始终输出最新正文）
- 画布编辑：拖拽节点、连线；从描述生成画布草稿；「优化」按描述继续调整；「自动整理」按数据流分层排版
- 边样式：曲线 / 折线 / 直线、自定义颜色、标签；**可视化条件编辑器**（输出包含文本 / 审核结论 / PASS·REVISE 标记 / 节点执行次数上限，支持且·或组合，自动生成并预览表达式；保留自定义表达式兜底，旧表达式自动反解析回显）
- 连线选中高亮：加粗 + 光晕 + 标签强调
- 回退循环自动识别渲染；每个节点可设「最多执行次数」，达上限可走"已达上限"出口优雅结束
- 分支并行：扇出并行执行，汇合节点等待全部上游完成
- 上下文引用：`{{input}}`、`{{nodes.节点名.output}}`、`{{memory.文件名}}`、`{{style.字段}}`（如 `{{style.full}}`）
- **运行可靠性**：节点级状态持久化；失败/停止后可**从断点继续**（已完成节点重放输出，不重复调用模型）；提案/审核输出契约校验，格式错误明确诊断
- **预算控制**：每个工作流可设最大调用次数 / 最大 token / 单次调用超时，超限安全停止并可用断点续跑恢复

### 风格模板
- 可复用的风格配置：题材 / 基调 / 节奏 / 视角 / 时态 / 行文规则 / 对话规则 / 禁忌 / 参考示例
- **版本化**：每次保存留历史快照（20 版），可查看与一键恢复
- 项目设置里绑定风格后：工作流可用 `{{style.*}}` 注入；结构化审核自动以该风格审核文风
- 存储目录可自定义（系统设置），切换时自动迁移

### 系统托盘
- 常驻 macOS 菜单栏 / Windows 托盘：打开主窗口、大模型配置、系统设置、退出
- **大模型配置**：多套 OpenAI 兼容服务（名称、地址、API Key、model、显示名、思考模式、上下文长度、启用开关），支持测试连接；可关闭「自定义温度」（某些套餐模型只接受默认温度），且温度参数被 400 拒绝时自动去参重试一次
- **API Key 安全**：优先经 Electron `safeStorage` 加密——macOS 用钥匙串、Windows 用 DPAPI，磁盘上只存密文；系统不支持安全存储时降级为 Base64 弱保护，且大模型配置窗口顶部会显示黄色警告条提示
- **系统设置**：自定义小说 / Agents / 工作流 / 风格模板存储目录（切换自动迁移）、自定义主窗口背景图（即时生效）

## 数据位置

| 内容 | 位置 |
|---|---|
| 模型配置（key 为密文） | `~/Library/Application Support/Story Studio/models.json`（Windows 为 `%APPDATA%/Story Studio`） |
| Agents / 工作流（可自定义目录） | 同目录 `agents.json` / `workflows.json` |
| 风格模板（含版本历史，可自定义目录） | 同目录 `styles.json` |
| 应用设置 | 同目录 `settings.json` |
| 小说正文 | 默认 `~/Documents/SlothStories`，可自定义 |
| 项目内数据 | `<小说>/memory/`（记忆文件 + `state.json` 结构化状态）、`.history/`（记忆与章节版本快照）、`workflow-runs/`（运行记录） |

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
                         #       小说文件系统、结构化状态库、风格模板库、
                         #       工作流引擎、提案系统、JSON 持久化、safeStorage 加密
  renderer/              # React UI：首页 / 创作工作台 / 编辑器 / Agents / Workflows /
                         #       风格模板页面、工作流画布（@xyflow/react）、托盘配置窗口
    state/store.ts       # 全局共享数据（agents/workflows/projects/groups/styles），聚焦统一刷新
    ui/hooks/            # useFocusRefresh：页面级数据「挂载 + 聚焦」统一刷新
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
