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
  createdAt: number;
  updatedAt: number;
}

export type AgentInput = Omit<AgentProfile, "id" | "builtin" | "createdAt" | "updatedAt"> & { id?: string };

export interface ChapterMeta {
  id: string;
  title: string;
  file: string; // chapters/ 下的文件名
  words: number;
  updatedAt: number;
}

export interface NovelProject {
  id: string; // 目录名
  title: string;
  synopsis: string;
  createdAt: number;
  updatedAt: number;
  chapters: ChapterMeta[];
}

export interface AppSettings {
  novelDir: string;
  backgroundImage: string | null; // dataURL
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
  };
  novels: {
    list(): Promise<NovelProject[]>;
    create(title: string, synopsis: string): Promise<NovelProject[]>;
    rename(id: string, title: string): Promise<NovelProject[]>;
    remove(id: string): Promise<NovelProject[]>;
    createChapter(projectId: string, title: string): Promise<NovelProject[]>;
    deleteChapter(projectId: string, chapterId: string): Promise<NovelProject[]>;
    readChapter(projectId: string, chapterId: string): Promise<string>;
    writeChapter(projectId: string, chapterId: string, content: string): Promise<void>;
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
    run(runId: string, workflowId: string, input: string): Promise<{ finalOutput?: string; error?: string }>;
    stop(runId: string): Promise<void>;
    onEvent(cb: (ev: WorkflowRunEvent) => void): () => void;
  };
}

declare global {
  interface Window {
    sloth: SlothApi;
  }
}
