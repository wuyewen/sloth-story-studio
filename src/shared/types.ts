// 共享类型与 IPC 契约：主进程与渲染进程都从这里导入。

export interface ModelProvider {
  id: string;
  name: string; // 配置名称
  baseUrl: string; // OpenAI 兼容地址，如 https://api.deepseek.com/v1
  model: string; // 实际调用的 model 名
  displayName: string; // 界面显示名称
  enableThinking: boolean;
  sendTemperature?: boolean; // 是否发送 temperature 参数；缺省=true。某些套餐模型只接受默认温度时关闭
  contextLength: number | null; // 可选，作为 max_tokens 上限
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

// models:list 返回的脱敏形态
export type ModelProviderInfo = ModelProvider & { hasKey: boolean };

// models:save 入参；apiKey 为空字符串表示不修改已保存的 key
export interface ModelProviderInput {
  id?: string;
  name: string;
  baseUrl: string;
  apiKey?: string;
  model: string;
  displayName: string;
  enableThinking: boolean;
  sendTemperature?: boolean;
  contextLength: number | null;
  enabled: boolean;
}

export interface AgentProfile {
  id: string;
  name: string;
  role: string; // 职责描述，如「大纲设计师」
  systemPrompt: string;
  providerId: string | null; // 绑定的大模型配置
  temperature: number;
  color: string; // 卡片标识色
  builtin: boolean;
  groupId?: string | null; // 所属分组，空为默认分组
  createdAt: number;
  updatedAt: number;
}

export interface ItemGroup {
  id: string;
  name: string;
  createdAt: number;
}

export type AgentInput = Omit<AgentProfile, "id" | "builtin" | "createdAt" | "updatedAt"> & { id?: string };

export interface ChapterMeta {
  id: string;
  title: string;
  file: string; // chapters/ 下的文件名
  words: number;
  updatedAt: number;
}

export interface UnitMeta {
  id: string;
  title: string;
  chapterIds: string[]; // 该单元包含的章节（按顺序）
}

export interface NovelProject {
  id: string; // 目录名
  title: string;
  synopsis: string;
  createdAt: number;
  updatedAt: number;
  chapters: ChapterMeta[];
  units: UnitMeta[];
  workflowIds: string[]; // 本书关联的工作流
  workflowSlots?: Partial<Record<WorkflowSlot, string>>; // 工作台四个操作位绑定的工作流
  styleId?: string; // 绑定的风格模板（FR-06），空为不绑定
}

export type WorkflowSlot = "planning" | "unit" | "chapter" | "review";

export interface MemoryFileInfo {
  rel: string; // memory/ 下的相对路径，如 story-bible.md、unit-summaries/第1单元.md
  size: number;
  updatedAt: number;
}

export interface MemoryVersion {
  ts: number; // 快照时间戳
  size: number;
}

// 章节正文版本快照（FR-08）
export interface ChapterVersion {
  ts: number;
  size: number;
  source: string; // manual 手动保存 / workflow 工作流保存 / rollback 回滚 / unknown
}

export interface NodeRunRecord {
  nodeId: string;
  label: string;
  kind: string; // agent | prompt
  attempt: number; // 第几次执行该节点（返修循环会>1）
  status: "succeeded" | "failed";
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  model?: string; // provider.model 或显示名
  inputChars: number;
  inputPreview: string; // 输入前 500 字符
  output?: string; // 完整输出（失败时省略）
  error?: string;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number }; // 服务未返回时整个字段缺省
  replayed?: boolean; // 断点续跑时复用了上次运行的输出（未调用模型）
  contextRefs?: { source: string; chars: number }[]; // kind=context：实际包含的来源与字符数（被预算移除的 chars=0，名带「(已省略)」）
}

export interface RunUsage {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  unknown: boolean; // 有调用未返回用量时 true
}

export interface WorkflowRunRecord {
  runId: string;
  workflowId: string;
  workflowName: string;
  projectId: string;
  startedAt: number;
  endedAt: number;
  status: "done" | "error" | "stopped";
  error?: string;
  steps: number;
  memoryRefs: string[]; // 本次运行读取的记忆文件
  outputPreview: string;
  finalOutput?: string; // 完整最终输出
  artifactPath?: string; // 产物文件（项目目录下的相对路径）
  input?: string; // 本次运行输入（断点续跑要用）
  workflowHash?: string; // 工作流定义 {nodes,edges} 的 sha256（断点续跑校验用）
  budgetExceeded?: boolean; // 本次运行累计 token 超出预算上限（F-07）
  nodeRuns?: NodeRunRecord[]; // 节点级执行记录（仅 agent/prompt 节点）
  usage?: RunUsage; // 运行级 token 用量汇总
}

export interface AppSettings {
  novelDir: string;
  backgroundImage: string | null; // dataURL
  agentDir: string; // 自定义 Agent 存储目录，空为默认（应用数据目录）
  workflowDir: string; // 自定义工作流存储目录，空为默认
  styleDir: string; // 自定义风格模板存储目录，空为默认
}

// ---- LLM ----

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  providerId: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
}

// ---- Workflow ----

export type WorkflowNodeKind = "start" | "end" | "agent" | "prompt" | "note" | "review" | "patch" | "context";

// 上下文构建器节点（FR-05）的来源清单：数组顺序即优先级（前=高优先级）
export const CONTEXT_SOURCES: { id: string; label: string }[] = [
  { id: "style", label: "本书风格配置" },
  { id: "state-characters", label: "角色状态" },
  { id: "state-foreshadowing", label: "伏笔追踪" },
  { id: "state-events", label: "事件" },
  { id: "state-items", label: "物品" },
  { id: "state-rules", label: "规则设定" },
  { id: "state-locations", label: "地点" },
  { id: "memory-files", label: "额外记忆文件" },
  { id: "recent-chapters", label: "最近章节正文" },
  { id: "input", label: "本次运行输入" }
];

export const CONTEXT_DEFAULT_SOURCES = [
  "style",
  "state-characters",
  "state-foreshadowing",
  "recent-chapters",
  "input"
];

// 结构化审核节点的审核维度（默认全选）
export const REVIEW_DIMENSIONS = [
  "剧情与时间线一致性",
  "人物行为与动机",
  "章节目标完成度",
  "世界观规则一致性",
  "伏笔前后呼应",
  "语言风格一致性",
  "重复表达与对话自然度"
] as const;

export interface WorkflowNodeData {
  kind: WorkflowNodeKind;
  label: string;
  agentId?: string | null; // kind=agent
  template?: string; // kind=prompt，支持 {{input}} 与 {{nodes.<id>.output}} 插值
  contextTemplate?: string; // kind=agent/review，自定义上下文；为空时用上游输出
  dimensions?: string[]; // kind=review，审核维度；空/缺省 = 全部维度
  textSource?: string; // kind=patch，被修订文本来源节点 label；空 = 直接上游
  reviewSource?: string; // kind=patch，审核结果来源节点 label；空 = 直接上游
  contextSources?: string[]; // kind=context，勾选的来源 id，有序即优先级（前=高优先级）
  contextMaxChars?: number; // kind=context，总预算，默认 12000
  contextRecentChapters?: number; // kind=context，最近 N 章，默认 1
  contextChapterChars?: number; // kind=context，每章最多字符，默认 3000
  contextMemoryFiles?: string; // kind=context，额外记忆文件名，逗号分隔（不含 .md 也可）
  outputSource?: string; // kind=end，输出来源节点 label（逗号分隔，按顺序取第一个已有输出的）；空 = 直接上游
  maxVisits?: number; // 单次运行中该节点最多执行次数（重试上限），默认 3
  autoProposal?: boolean; // 输出为提案 JSON 时，自动解析并创建到待审核提案（不自动应用）
  [key: string]: unknown;
}

export interface WorkflowNode {
  id: string;
  type: string; // React Flow 自定义类型 = kind
  position: { x: number; y: number };
  data: WorkflowNodeData;
}

export type WorkflowEdgeLine = "bezier" | "step" | "straight";

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  type?: string; // React Flow 边类型
  label?: string;
  animated?: boolean;
  style?: Record<string, unknown>;
  data?: {
    line?: WorkflowEdgeLine;
    color?: string;
    conditionExpr?: string; // 以 output / context 求值，真则走这条边
    loopY?: number; // 回退线顶部通道 y 坐标（自动整理计算）
  };
}

export interface WorkflowDef {
  id: string;
  name: string;
  description: string;
  builtin?: boolean; // 内置工作流不可删除
  providerId?: string | null; // 工作流级大模型，优先级高于 Agent 绑定
  groupId?: string | null; // 所属分组，空为默认分组
  budget?: WorkflowBudget; // 模型调用预算（FR-09），0 或缺省 = 不限
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  viewport?: { x: number; y: number; zoom: number };
  createdAt: number;
  updatedAt: number;
}

export interface WorkflowBudget {
  maxCalls?: number; // 单次运行最多模型调用次数
  maxTokens?: number; // 单次运行最多 token 数
  callTimeoutSec?: number; // 单次调用超时秒数
}

export type WorkflowInput = Omit<WorkflowDef, "id" | "createdAt" | "updatedAt"> & { id?: string };

export interface WorkflowRunEvent {
  runId: string;
  type: "node-start" | "node-done" | "node-error" | "run-done" | "run-error";
  nodeId?: string;
  label?: string;
  outputPreview?: string;
  output?: string; // 节点完整输出
  error?: string;
  finalOutput?: string;
}

// ---- 多 Agent 顺序执行 ----

export interface AgentRunEvent {
  runId: string;
  agentId: string;
  agentName: string;
  status: "start" | "done" | "error";
  output?: string;
  error?: string;
}

// ---- 风格模板（FR-06，应用级存储，跨项目复用）----

export interface StyleProfile {
  id: string;
  name: string;
  version: number; // 每次保存 +1
  genre: string[]; // 题材：如 ["系统流","玄幻","搞笑","反诈"]
  tone: string[]; // 基调：如 ["轻松","吐槽向"]
  pacing?: string; // 节奏
  pointOfView?: string; // 叙事视角
  tense?: string; // 时态
  proseRules: string[]; // 行文规则
  dialogueRules: string[]; // 对话规则
  avoidRules: string[]; // 禁忌（避免出现的写法）
  referenceExample?: string; // 作者认可的原创示例段落（用于校准，单段即可）
  updatedAt: number;
}

export interface StyleProfileVersion {
  version: number;
  savedAt: number;
  snapshot: StyleProfile;
}

export type StyleProfileInput = Omit<StyleProfile, "id" | "version" | "updatedAt">;

// ---- 结构化状态库（FR-03）----

export type StateEntityType = "character" | "foreshadowing" | "event" | "item" | "rule" | "location";

export interface StateEntity {
  id: string; // 主进程生成
  type: StateEntityType;
  name: string; // 如「林渡」「F02 你是第一个查契约的」
  data: string; // 状态描述（markdown 文本）
  status: "confirmed" | "inferred"; // confirmed=正文明确事实/作者确认；inferred=模型推断
  source?: string; // 来源章节标题
  locked?: boolean; // 作者锁定后，提取不得覆盖
  conflict?: string; // 与既有内容冲突时的说明，非空即处于冲突状态
  updatedAt: number;
}

// stateUpsert 入参；同 type+name 视为同一实体
export interface StateEntityInput {
  id?: string; // 已知 id 时直接定位
  type: StateEntityType;
  name: string;
  data: string;
  status?: "confirmed" | "inferred";
  source?: string;
  force?: boolean; // 强制覆盖：locked/冲突也写入，旧值记入 conflict 备注
  clearConflict?: boolean; // 作者手动编辑：写入并清除冲突标记
}

// 章节记忆提取的审阅项（不落库，由渲染端勾选后再 upsert）
export interface StateExtractItem {
  entity: { type: StateEntityType; name: string; data: string; status: "confirmed" | "inferred"; source?: string };
  relation: "new" | "update" | "conflict"; // 与现有实体的关系
  existingData?: string; // 现有内容（更新/冲突时展示）
}

// ---- 记忆提案 ----

export type ProposalStatus = "pending" | "applied" | "rejected" | "conflict";

export interface MemoryProposal {
  id: string;
  projectId: string;
  targetFile: string; // memory/ 下相对路径
  status: ProposalStatus;
  summary: string;
  reason: string;
  sourceChapterIds: string[];
  beforeContent: string; // 提案创建时的文件内容
  proposedContent: string;
  createdAt: number;
  appliedAt?: number;
  baseRevision: string; // beforeContent 的 sha256，用于冲突检测
}

export interface ProposalInput {
  targetFile: string;
  summary: string;
  reason: string;
  sourceChapterIds?: string[];
  proposedContent: string;
}

// ---- window.sloth API ----

export interface SlothApi {
  models: {
    list(): Promise<ModelProviderInfo[]>;
    save(input: ModelProviderInput): Promise<ModelProviderInfo[]>;
    remove(id: string): Promise<ModelProviderInfo[]>;
    test(input: ModelProviderInput): Promise<{ ok: boolean; message: string }>;
    onChanged(cb: (providers: ModelProviderInfo[]) => void): () => void;
  };
  settings: {
    get(): Promise<AppSettings>;
    set(patch: Partial<AppSettings>): Promise<AppSettings>;
    pickDirectory(): Promise<string | null>;
    pickBackgroundImage(): Promise<string | null>; // dataURL
    onChanged(cb: (settings: AppSettings) => void): () => void;
  };
  agents: {
    list(): Promise<AgentProfile[]>;
    save(input: AgentInput): Promise<AgentProfile[]>;
    remove(id: string): Promise<AgentProfile[]>;
    listGroups(): Promise<ItemGroup[]>;
    createGroup(name: string): Promise<ItemGroup[]>;
    renameGroup(id: string, name: string): Promise<ItemGroup[]>;
    deleteGroup(id: string): Promise<ItemGroup[]>;
    setGroup(agentId: string, groupId: string | null): Promise<AgentProfile[]>;
  };
  novels: {
    list(): Promise<NovelProject[]>;
    create(title: string, synopsis: string): Promise<NovelProject[]>;
    rename(id: string, title: string): Promise<NovelProject[]>;
    updateMeta(id: string, patch: { title?: string; synopsis?: string; styleId?: string | null }): Promise<NovelProject[]>;
    assignWorkflow(projectId: string, workflowId: string): Promise<NovelProject[]>;
    unassignWorkflow(projectId: string, workflowId: string): Promise<NovelProject[]>;
    setWorkflowSlot(projectId: string, slot: WorkflowSlot, workflowId: string | null): Promise<NovelProject[]>;
    remove(id: string): Promise<NovelProject[]>;
    createChapter(projectId: string, title: string, unitId?: string): Promise<NovelProject[]>;
    deleteChapter(projectId: string, chapterId: string): Promise<NovelProject[]>;
    readChapter(projectId: string, chapterId: string): Promise<string>;
    writeChapter(projectId: string, chapterId: string, content: string, source?: string): Promise<void>;
    createUnit(projectId: string, title: string): Promise<NovelProject[]>;
    renameUnit(projectId: string, unitId: string, title: string): Promise<NovelProject[]>;
    renameChapter(projectId: string, chapterId: string, title: string): Promise<NovelProject[]>;
    deleteUnit(projectId: string, unitId: string): Promise<NovelProject[]>;
    setChapterUnit(projectId: string, chapterId: string, unitId: string): Promise<NovelProject[]>;
    unsetChapterUnit(projectId: string, chapterId: string): Promise<NovelProject[]>;
    memoryList(projectId: string): Promise<MemoryFileInfo[]>;
    memoryRead(projectId: string, rel: string): Promise<string>;
    memoryWrite(projectId: string, rel: string, content: string): Promise<void>;
    memoryDelete(projectId: string, rel: string): Promise<void>;
    memoryHistory(projectId: string, rel: string): Promise<MemoryVersion[]>;
    memoryReadVersion(projectId: string, rel: string, ts: number): Promise<string>;
    memoryRestore(projectId: string, rel: string, ts: number): Promise<void>;
    runHistory(projectId: string): Promise<WorkflowRunRecord[]>;
    revealArtifact(projectId: string, rel: string): Promise<void>;
    chapterVersions(projectId: string, chapterId: string): Promise<ChapterVersion[]>;
    chapterVersionRead(projectId: string, chapterId: string, ts: number): Promise<string>;
    chapterRollback(projectId: string, chapterId: string, ts: number): Promise<void>;
    stateList(projectId: string): Promise<StateEntity[]>;
    stateUpsert(projectId: string, input: StateEntityInput): Promise<StateEntity[]>;
    stateRemove(projectId: string, id: string): Promise<StateEntity[]>;
    stateSetLock(projectId: string, id: string, locked: boolean): Promise<StateEntity[]>;
    extractChapterState(projectId: string, chapterRef: { unitId?: string; chapterId: string }): Promise<{ chapterTitle: string; items: StateExtractItem[] }>;
  };
  llm: {
    chat(req: ChatRequest): Promise<string>;
    chatStream(requestId: string, req: ChatRequest): Promise<void>;
    stop(requestId: string): Promise<void>;
    onChunk(cb: (requestId: string, delta: string) => void): () => void;
    onDone(cb: (requestId: string) => void): () => void;
    onError(cb: (requestId: string, error: string) => void): () => void;
    runAgents(runId: string, agentIds: string[], input: string): Promise<void>;
    stopAgents(runId: string): Promise<void>;
    onAgentEvent(cb: (ev: AgentRunEvent) => void): () => void;
  };
  workflows: {
    list(): Promise<WorkflowDef[]>;
    save(input: WorkflowInput): Promise<WorkflowDef[]>;
    remove(id: string): Promise<WorkflowDef[]>;
    generate(description: string, providerId: string): Promise<{ nodes: WorkflowNode[]; edges: WorkflowEdge[] }>;
    optimize(
      current: { nodes: WorkflowNode[]; edges: WorkflowEdge[] },
      instruction: string,
      providerId: string
    ): Promise<{ nodes: WorkflowNode[]; edges: WorkflowEdge[] }>;
    run(runId: string, workflowId: string, input: string, projectId?: string, resumeFromRunId?: string): Promise<{ finalOutput?: string; error?: string; proposalsCreated?: number }>;
    stop(runId: string): Promise<void>;
    onEvent(cb: (ev: WorkflowRunEvent) => void): () => void;
    listGroups(): Promise<ItemGroup[]>;
    createGroup(name: string): Promise<ItemGroup[]>;
    renameGroup(id: string, name: string): Promise<ItemGroup[]>;
    deleteGroup(id: string): Promise<ItemGroup[]>;
    setGroup(workflowId: string, groupId: string | null): Promise<WorkflowDef[]>;
  };
  proposals: {
    list(projectId: string): Promise<MemoryProposal[]>;
    create(projectId: string, input: ProposalInput): Promise<MemoryProposal[]>;
    accept(projectId: string, id: string, force?: boolean): Promise<{ proposals: MemoryProposal[]; conflict: boolean }>;
    reject(projectId: string, id: string): Promise<MemoryProposal[]>;
    currentOf(projectId: string, id: string): Promise<string>;
  };
  styles: {
    list(): Promise<StyleProfile[]>;
    create(input: StyleProfileInput): Promise<StyleProfile[]>;
    update(id: string, input: StyleProfileInput): Promise<StyleProfile[]>;
    duplicate(id: string): Promise<StyleProfile[]>;
    remove(id: string): Promise<StyleProfile[]>;
    listHistory(id: string): Promise<StyleProfileVersion[]>;
    restoreVersion(id: string, version: number): Promise<StyleProfile[]>;
  };
  app: {
    openConfig(kind: "models" | "settings"): Promise<void>;
    encryptionAvailable(): Promise<boolean>; // safeStorage 是否可用（false 时 API Key 降级为 Base64 弱保护）
    version(): Promise<string>; // 应用版本号（package.json）
    onFocus(cb: () => void): () => void;
  };
}

declare global {
  interface Window {
    sloth: SlothApi;
  }
}
