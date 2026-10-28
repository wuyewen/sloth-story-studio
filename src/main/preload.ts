import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type {
  AgentInput,
  AgentRunEvent,
  AppSettings,
  ChatRequest,
  ModelProviderInfo,
  ModelProviderInput,
  ProposalInput,
  SlothApi,
  StateEntityInput,
  StyleProfileInput,
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
    remove: (id: string) => ipcRenderer.invoke("agents:delete", id),
    listGroups: () => ipcRenderer.invoke("agents:groupsList"),
    createGroup: (name: string) => ipcRenderer.invoke("agents:groupsCreate", name),
    renameGroup: (id: string, name: string) => ipcRenderer.invoke("agents:groupsRename", id, name),
    deleteGroup: (id: string) => ipcRenderer.invoke("agents:groupsDelete", id),
    setGroup: (agentId: string, groupId: string | null) =>
      ipcRenderer.invoke("agents:setGroup", agentId, groupId)
  },
  novels: {
    list: () => ipcRenderer.invoke("novels:list"),
    create: (title: string, synopsis: string) => ipcRenderer.invoke("novels:create", title, synopsis),
    rename: (id: string, title: string) => ipcRenderer.invoke("novels:rename", id, title),
    updateMeta: (id: string, patch: { title?: string; synopsis?: string }) =>
      ipcRenderer.invoke("novels:updateMeta", id, patch),
    assignWorkflow: (projectId: string, workflowId: string) =>
      ipcRenderer.invoke("novels:assignWorkflow", projectId, workflowId),
    unassignWorkflow: (projectId: string, workflowId: string) =>
      ipcRenderer.invoke("novels:unassignWorkflow", projectId, workflowId),
    setWorkflowSlot: (projectId: string, slot: string, workflowId: string | null) =>
      ipcRenderer.invoke("novels:setWorkflowSlot", projectId, slot, workflowId),
    remove: (id: string) => ipcRenderer.invoke("novels:remove", id),
    createChapter: (projectId: string, title: string, unitId?: string) =>
      ipcRenderer.invoke("novels:createChapter", projectId, title, unitId),
    deleteChapter: (projectId: string, chapterId: string) =>
      ipcRenderer.invoke("novels:deleteChapter", projectId, chapterId),
    readChapter: (projectId: string, chapterId: string) =>
      ipcRenderer.invoke("novels:readChapter", projectId, chapterId),
    writeChapter: (projectId: string, chapterId: string, content: string, source?: string) =>
      ipcRenderer.invoke("novels:writeChapter", projectId, chapterId, content, source),
    createUnit: (projectId: string, title: string) =>
      ipcRenderer.invoke("novels:createUnit", projectId, title),
    renameUnit: (projectId: string, unitId: string, title: string) =>
      ipcRenderer.invoke("novels:renameUnit", projectId, unitId, title),
    renameChapter: (projectId: string, chapterId: string, title: string) =>
      ipcRenderer.invoke("novels:renameChapter", projectId, chapterId, title),
    deleteUnit: (projectId: string, unitId: string) =>
      ipcRenderer.invoke("novels:deleteUnit", projectId, unitId),
    setChapterUnit: (projectId: string, chapterId: string, unitId: string) =>
      ipcRenderer.invoke("novels:setChapterUnit", projectId, chapterId, unitId),
    unsetChapterUnit: (projectId: string, chapterId: string) =>
      ipcRenderer.invoke("novels:unsetChapterUnit", projectId, chapterId),
    memoryList: (projectId: string) => ipcRenderer.invoke("novels:memoryList", projectId),
    memoryRead: (projectId: string, rel: string) =>
      ipcRenderer.invoke("novels:memoryRead", projectId, rel),
    memoryWrite: (projectId: string, rel: string, content: string) =>
      ipcRenderer.invoke("novels:memoryWrite", projectId, rel, content),
    memoryDelete: (projectId: string, rel: string) =>
      ipcRenderer.invoke("novels:memoryDelete", projectId, rel),
    memoryHistory: (projectId: string, rel: string) =>
      ipcRenderer.invoke("novels:memoryHistory", projectId, rel),
    memoryReadVersion: (projectId: string, rel: string, ts: number) =>
      ipcRenderer.invoke("novels:memoryReadVersion", projectId, rel, ts),
    memoryRestore: (projectId: string, rel: string, ts: number) =>
      ipcRenderer.invoke("novels:memoryRestore", projectId, rel, ts),
    runHistory: (projectId: string) => ipcRenderer.invoke("novels:runHistory", projectId),
    revealArtifact: (projectId: string, rel: string) =>
      ipcRenderer.invoke("novels:revealArtifact", projectId, rel),
    chapterVersions: (projectId: string, chapterId: string) =>
      ipcRenderer.invoke("novels:chapterVersions", projectId, chapterId),
    chapterVersionRead: (projectId: string, chapterId: string, ts: number) =>
      ipcRenderer.invoke("novels:chapterVersionRead", projectId, chapterId, ts),
    chapterRollback: (projectId: string, chapterId: string, ts: number) =>
      ipcRenderer.invoke("novels:chapterRollback", projectId, chapterId, ts),
    stateList: (projectId: string) => ipcRenderer.invoke("novels:stateList", projectId),
    stateUpsert: (projectId: string, input: StateEntityInput) =>
      ipcRenderer.invoke("novels:stateUpsert", projectId, input),
    stateRemove: (projectId: string, id: string) =>
      ipcRenderer.invoke("novels:stateRemove", projectId, id),
    stateSetLock: (projectId: string, id: string, locked: boolean) =>
      ipcRenderer.invoke("novels:stateSetLock", projectId, id, locked),
    extractChapterState: (projectId: string, chapterRef: { unitId?: string; chapterId: string }) =>
      ipcRenderer.invoke("novels:extractChapterState", projectId, chapterRef)
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
    run: (runId: string, workflowId: string, input: string, projectId?: string, resumeFromRunId?: string) =>
      ipcRenderer.invoke("workflows:run", runId, workflowId, input, projectId, resumeFromRunId),
    stop: (runId: string) => ipcRenderer.invoke("workflows:stop", runId),
    onEvent: (cb) => subscribe<[WorkflowRunEvent]>("workflow:event", cb),
    listGroups: () => ipcRenderer.invoke("workflows:groupsList"),
    createGroup: (name: string) => ipcRenderer.invoke("workflows:groupsCreate", name),
    renameGroup: (id: string, name: string) => ipcRenderer.invoke("workflows:groupsRename", id, name),
    deleteGroup: (id: string) => ipcRenderer.invoke("workflows:groupsDelete", id),
    setGroup: (workflowId: string, groupId: string | null) =>
      ipcRenderer.invoke("workflows:setGroup", workflowId, groupId)
  },
  proposals: {
    list: (projectId: string) => ipcRenderer.invoke("proposals:list", projectId),
    create: (projectId: string, input: ProposalInput) =>
      ipcRenderer.invoke("proposals:create", projectId, input),
    accept: (projectId: string, id: string, force?: boolean) =>
      ipcRenderer.invoke("proposals:accept", projectId, id, force),
    reject: (projectId: string, id: string) => ipcRenderer.invoke("proposals:reject", projectId, id),
    currentOf: (projectId: string, id: string) => ipcRenderer.invoke("proposals:currentOf", projectId, id)
  },
  styles: {
    list: () => ipcRenderer.invoke("styles:list"),
    create: (input: StyleProfileInput) => ipcRenderer.invoke("styles:create", input),
    update: (id: string, input: StyleProfileInput) => ipcRenderer.invoke("styles:update", id, input),
    duplicate: (id: string) => ipcRenderer.invoke("styles:duplicate", id),
    remove: (id: string) => ipcRenderer.invoke("styles:delete", id),
    listHistory: (id: string) => ipcRenderer.invoke("styles:listHistory", id),
    restoreVersion: (id: string, version: number) =>
      ipcRenderer.invoke("styles:restoreVersion", id, version)
  },
  app: {
    openConfig: (kind: "models" | "settings") => ipcRenderer.invoke("app:openConfig", kind),
    onFocus: (cb: () => void) => subscribe("app:focus", cb)
  }
};

contextBridge.exposeInMainWorld("sloth", api);
