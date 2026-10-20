import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type {
  AgentInput,
  AgentRunEvent,
  AppSettings,
  ChatRequest,
  ModelProviderInfo,
  ModelProviderInput,
  SlothApi,
  WorkflowEdge,
  WorkflowInput,
  WorkflowNode,
  WorkflowRunEvent
} from "../shared/types.js";

function subscribe<T extends unknown[]>(
  channel: string,
  cb: (...args: T) => void
): () => void {
  const listener = (_event: IpcRendererEvent, ...args: unknown[]): void => {
    cb(...(args as T));
  };
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

const api: SlothApi = {
  models: {
    list: () => ipcRenderer.invoke("models:list"),
    save: (input: ModelProviderInput) => ipcRenderer.invoke("models:save", input),
    remove: (id: string) => ipcRenderer.invoke("models:delete", id),
    test: (input: ModelProviderInput) => ipcRenderer.invoke("models:test", input),
    onChanged: (cb: (providers: ModelProviderInfo[]) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, list: ModelProviderInfo[]) => cb(list);
      ipcRenderer.on("models:changed", listener);
      return () => ipcRenderer.removeListener("models:changed", listener);
    }
  },
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    set: (patch: Partial<AppSettings>) => ipcRenderer.invoke("settings:set", patch),
    pickDirectory: () => ipcRenderer.invoke("dialog:pickDirectory"),
    pickBackgroundImage: () => ipcRenderer.invoke("dialog:pickBackgroundImage"),
    onChanged: (cb: (settings: AppSettings) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, s: AppSettings) => cb(s);
      ipcRenderer.on("settings:changed", listener);
      return () => ipcRenderer.removeListener("settings:changed", listener);
    }
  },
  agents: {
    list: () => ipcRenderer.invoke("agents:list"),
    save: (input: AgentInput) => ipcRenderer.invoke("agents:save", input),
    remove: (id: string) => ipcRenderer.invoke("agents:delete", id)
  },
  novels: {
    list: () => ipcRenderer.invoke("novels:list"),
    create: (title: string, synopsis: string) => ipcRenderer.invoke("novels:create", title, synopsis),
    rename: (id: string, title: string) => ipcRenderer.invoke("novels:rename", id, title),
    remove: (id: string) => ipcRenderer.invoke("novels:remove", id),
    createChapter: (projectId: string, title: string) =>
      ipcRenderer.invoke("novels:createChapter", projectId, title),
    deleteChapter: (projectId: string, chapterId: string) =>
      ipcRenderer.invoke("novels:deleteChapter", projectId, chapterId),
    readChapter: (projectId: string, chapterId: string) =>
      ipcRenderer.invoke("novels:readChapter", projectId, chapterId),
    writeChapter: (projectId: string, chapterId: string, content: string) =>
      ipcRenderer.invoke("novels:writeChapter", projectId, chapterId, content)
  },
  llm: {
    chat: (req: ChatRequest) => ipcRenderer.invoke("llm:chat", req),
    chatStream: (requestId: string, req: ChatRequest) =>
      ipcRenderer.invoke("llm:chatStream", requestId, req),
    stop: (requestId: string) => ipcRenderer.invoke("llm:stopStream", requestId),
    onChunk: (cb) => subscribe("llm:chunk", (payload: { requestId: string; delta: string }) => cb(payload.requestId, payload.delta)),
    onDone: (cb) => subscribe("llm:done", (payload: { requestId: string }) => cb(payload.requestId)),
    onError: (cb) => subscribe("llm:error", (payload: { requestId: string; error: string }) => cb(payload.requestId, payload.error)),
    runAgents: (runId: string, agentIds: string[], input: string) =>
      ipcRenderer.invoke("llm:runAgents", runId, agentIds, input),
    stopAgents: (runId: string) => ipcRenderer.invoke("llm:stopAgents", runId),
    onAgentEvent: (cb) => subscribe<[AgentRunEvent]>("llm:agentEvent", cb)
  },
  workflows: {
    list: () => ipcRenderer.invoke("workflows:list"),
    save: (input: WorkflowInput) => ipcRenderer.invoke("workflows:save", input),
    remove: (id: string) => ipcRenderer.invoke("workflows:delete", id),
    generate: (description: string, providerId: string) =>
      ipcRenderer.invoke("workflows:generate", description, providerId),
    optimize: (current: { nodes: WorkflowNode[]; edges: WorkflowEdge[] }, instruction: string, providerId: string) =>
      ipcRenderer.invoke("workflows:optimize", current, instruction, providerId),
    run: (runId: string, workflowId: string, input: string) =>
      ipcRenderer.invoke("workflows:run", runId, workflowId, input),
    stop: (runId: string) => ipcRenderer.invoke("workflows:stop", runId),
    onEvent: (cb) => subscribe<[WorkflowRunEvent]>("workflow:event", cb)
  }
};

contextBridge.exposeInMainWorld("sloth", api);
