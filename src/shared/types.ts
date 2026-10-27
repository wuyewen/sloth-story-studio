// 共享类型与 IPC 契约：主进程与渲染进程都从这里导入。

export interface ModelProvider {
  id: string;
  name: string; // 配置名称
  baseUrl: string; // OpenAI 兼容地址，如 https://api.deepseek.com/v1
  model: string; // 实际调用的 model 名
  displayName: string; // 界面显示名称
  enableThinking: boolean;
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
}

export interface AppSettings {
  novelDir: string;
  backgroundImage: string | null; // dataURL
  agentDir: string; // 自定义 Agent 存储目录，空为默认（应用数据目录）
  workflowDir: string; // 自定义工作流存储目录，空为默认
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

export type WorkflowNodeKind = "start" | "end" | "agent" | "prompt" | "note";

export interface WorkflowNodeData {
  kind: WorkflowNodeKind;
  label: string;
  agentId?: string | null; // kind=agent
  template?: string; // kind=prompt，支持 {{input}} 与 {{nodes.<id>.output}} 插值
  contextTemplate?: string; // kind=agent，自定义上下文；为空时用上游输出
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
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  viewport?: { x: number; y: number; zoom: number };
  createdAt: number;
  updatedAt: number;
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
    updateMeta(id: string, patch: { title?: string; synopsis?: string }): Promise<NovelProject[]>;
    assignWorkflow(projectId: string, workflowId: string): Promise<NovelProject[]>;
    unassignWorkflow(projectId: string, workflowId: string): Promise<NovelProject[]>;
    setWorkflowSlot(projectId: string, slot: WorkflowSlot, workflowId: string | null): Promise<NovelProject[]>;
    remove(id: string): Promise<NovelProject[]>;
    createChapter(projectId: string, title: string): Promise<NovelProject[]>;
    deleteChapter(projectId: string, chapterId: string): Promise<NovelProject[]>;
    readChapter(projectId: string, chapterId: string): Promise<string>;
    writeChapter(projectId: string, chapterId: string, content: string): Promise<void>;
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
    run(runId: string, workflowId: string, input: string, projectId?: string): Promise<{ finalOutput?: string; error?: string; proposalsCreated?: number; proposalsError?: string }>;
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
  app: {
    openConfig(kind: "models" | "settings"): Promise<void>;
    onFocus(cb: () => void): () => void;
  };
}

declare global {
  interface Window {
    sloth: SlothApi;
  }
}
