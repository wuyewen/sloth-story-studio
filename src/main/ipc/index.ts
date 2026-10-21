import { dialog, ipcMain, webContents, type IpcMainInvokeEvent } from "electron";
import fs from "node:fs";
import path from "node:path";
import type {
  AgentInput,
  AgentProfile,
  AppSettings,
  ChatRequest,
  ModelProviderInfo,
  ModelProviderInput,
  WorkflowEdge,
  WorkflowInput,
  WorkflowNode
} from "../../shared/types.js";
import {
  migrateStoreFile,
  newId,
  readAgents,
  readModels,
  readSettings,
  readWorkflows,
  writeAgents,
  writeModels,
  writeSettings,
  writeWorkflows,
  type ModelRecord
} from "../services/store.js";
import { decryptKey, encryptKey } from "../services/crypto.js";
import { abortStream, chat, chatStream } from "../services/llmClient.js";
import * as novelFs from "../services/novelFs.js";
import * as workflowEngine from "../services/workflowEngine.js";

function toInfo(record: ModelRecord): ModelProviderInfo {
  const { apiKeyEnc, ...rest } = record;
  return { ...rest, hasKey: Boolean(apiKeyEnc) };
}

function getKey(providerId: string): string {
  const record = readModels().find((m) => m.id === providerId);
  return record?.apiKeyEnc ? decryptKey(record.apiKeyEnc) : "";
}

function requireProvider(providerId: string): ModelRecord {
  const record = readModels().find((m) => m.id === providerId);
  if (!record) throw new Error("大模型配置不存在");
  return record;
}

function broadcastModels(senderId: number, models: ModelProviderInfo[]): void {
  for (const wc of webContents.getAllWebContents()) {
    if (wc.id !== senderId && !wc.isDestroyed()) wc.send("models:changed", models);
  }
}

export function registerIpc(): void {
  // ---- models ----

  ipcMain.handle("models:list", (): ModelProviderInfo[] => readModels().map(toInfo));

  ipcMain.handle("models:save", (e, input: ModelProviderInput): ModelProviderInfo[] => {
    const models = readModels();
    const now = Date.now();
    if (input.id) {
      const idx = models.findIndex((m) => m.id === input.id);
      if (idx < 0) throw new Error("大模型配置不存在");
      const prev = models[idx];
      models[idx] = {
        ...prev,
        name: input.name,
        baseUrl: input.baseUrl,
        model: input.model,
        displayName: input.displayName,
        enableThinking: input.enableThinking,
        contextLength: input.contextLength,
        enabled: input.enabled,
        updatedAt: now,
        ...(input.apiKey ? { apiKeyEnc: encryptKey(input.apiKey) } : {})
      };
    } else {
      models.push({
        id: newId(),
        name: input.name,
        baseUrl: input.baseUrl,
        model: input.model,
        displayName: input.displayName,
        enableThinking: input.enableThinking,
        contextLength: input.contextLength,
        enabled: input.enabled,
        createdAt: now,
        updatedAt: now,
        ...(input.apiKey ? { apiKeyEnc: encryptKey(input.apiKey) } : {})
      });
    }
    writeModels(models);
    const infos = models.map(toInfo);
    broadcastModels(e.sender.id, infos);
    return infos;
  });

  ipcMain.handle("models:delete", (e, id: string): ModelProviderInfo[] => {
    const models = readModels().filter((m) => m.id !== id);
    writeModels(models);
    const infos = models.map(toInfo);
    broadcastModels(e.sender.id, infos);
    return infos;
  });

  ipcMain.handle(
    "models:test",
    async (_e, input: ModelProviderInput): Promise<{ ok: boolean; message: string }> => {
      try {
        const apiKey = input.apiKey?.trim() || (input.id ? getKey(input.id) : "");
        const now = Date.now();
        const provider: ModelRecord = {
          id: input.id ?? "__test__",
          name: input.name,
          baseUrl: input.baseUrl,
          model: input.model,
          displayName: input.displayName,
          enableThinking: input.enableThinking,
          contextLength: input.contextLength,
          enabled: input.enabled,
          createdAt: now,
          updatedAt: now,
          ...(apiKey ? { apiKeyEnc: encryptKey(apiKey) } : {})
        };
        await chat(provider, apiKey, [{ role: "user", content: "ping" }], { maxTokens: 8 });
        return { ok: true, message: "连接成功" };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    }
  );

  // ---- settings ----

  ipcMain.handle("settings:get", (): AppSettings => readSettings());

  ipcMain.handle("settings:set", (e, patch: Partial<AppSettings>): AppSettings => {
    const prev = readSettings();
    if (patch.agentDir && patch.agentDir !== prev.agentDir) {
      migrateStoreFile("agents.json", patch.agentDir);
    }
    if (patch.workflowDir && patch.workflowDir !== prev.workflowDir) {
      migrateStoreFile("workflows.json", patch.workflowDir);
    }
    const next = { ...prev, ...patch };
    writeSettings(next);
    for (const wc of webContents.getAllWebContents()) {
      if (wc.id !== e.sender.id && !wc.isDestroyed()) wc.send("settings:changed", next);
    }
    return next;
  });

  ipcMain.handle("dialog:pickDirectory", async (e): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"]
    });
    void e;
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
  });

  ipcMain.handle("dialog:pickBackgroundImage", async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }]
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const filePath = result.filePaths[0];
    const stat = fs.statSync(filePath);
    if (stat.size > 8 * 1024 * 1024) {
      throw new Error("图片超过 8MB，请选择更小的图片");
    }
    const ext = path.extname(filePath).slice(1).toLowerCase();
    const mime = ext === "jpg" ? "jpeg" : ext;
    const data = fs.readFileSync(filePath).toString("base64");
    return `data:image/${mime};base64,${data}`;
  });

  // ---- agents ----

  ipcMain.handle("agents:list", (): AgentProfile[] => readAgents());

  ipcMain.handle("agents:save", (_e, input: AgentInput): AgentProfile[] => {
    const agents = readAgents();
    const now = Date.now();
    if (input.id) {
      const idx = agents.findIndex((a) => a.id === input.id);
      if (idx < 0) throw new Error("Agent 不存在");
      agents[idx] = { ...agents[idx], ...input, id: input.id, updatedAt: now };
    } else {
      agents.push({ ...input, id: newId(), builtin: false, createdAt: now, updatedAt: now });
    }
    writeAgents(agents);
    return agents;
  });

  ipcMain.handle("agents:delete", (_e, id: string): AgentProfile[] => {
    const agents = readAgents();
    const target = agents.find((a) => a.id === id);
    if (!target) throw new Error("Agent 不存在");
    if (target.builtin) throw new Error("内置 Agent 不可删除");
    const next = agents.filter((a) => a.id !== id);
    writeAgents(next);
    return next;
  });

  // ---- novels ----

  ipcMain.handle("novels:list", () => novelFs.list());
  ipcMain.handle("novels:create", (_e, title: string, synopsis: string) =>
    novelFs.create(title, synopsis)
  );
  ipcMain.handle("novels:rename", (_e, id: string, title: string) => novelFs.rename(id, title));
  ipcMain.handle("novels:remove", (_e, id: string) => novelFs.remove(id));
  ipcMain.handle("novels:createChapter", (_e, projectId: string, title: string) =>
    novelFs.createChapter(projectId, title)
  );
  ipcMain.handle("novels:deleteChapter", (_e, projectId: string, chapterId: string) =>
    novelFs.deleteChapter(projectId, chapterId)
  );
  ipcMain.handle("novels:readChapter", (_e, projectId: string, chapterId: string) =>
    novelFs.readChapter(projectId, chapterId)
  );
  ipcMain.handle(
    "novels:writeChapter",
    (_e, projectId: string, chapterId: string, content: string) =>
      novelFs.writeChapter(projectId, chapterId, content)
  );

  // ---- llm ----

  ipcMain.handle("llm:chat", async (_e, req: ChatRequest): Promise<string> => {
    const provider = requireProvider(req.providerId);
    return chat(provider, getKey(provider.id), req.messages, {
      temperature: req.temperature,
      maxTokens: req.maxTokens
    });
  });

  ipcMain.handle(
    "llm:chatStream",
    async (e: IpcMainInvokeEvent, requestId: string, req: ChatRequest): Promise<void> => {
      const provider = requireProvider(req.providerId);
      await chatStream(e.sender, requestId, provider, getKey(provider.id), req.messages, {
        temperature: req.temperature,
        maxTokens: req.maxTokens
      });
    }
  );

  ipcMain.handle(
    "llm:runAgents",
    async (e: IpcMainInvokeEvent, runId: string, agentIds: string[], input: string): Promise<void> => {
      await workflowEngine.runAgents(
        e.sender,
        runId,
        agentIds,
        readAgents(),
        readModels(),
        getKey,
        input
      );
    }
  );

  ipcMain.handle("llm:stopStream", (_e, requestId: string): void => {
    abortStream(requestId);
  });

  ipcMain.handle("llm:stopAgents", (_e, runId: string): void => {
    workflowEngine.stopRun(runId);
  });

  // ---- workflows ----

  ipcMain.handle("workflows:list", () => readWorkflows());

  ipcMain.handle("workflows:save", (_e, input: WorkflowInput) => {
    const workflows = readWorkflows();
    const now = Date.now();
    if (input.id) {
      const idx = workflows.findIndex((w) => w.id === input.id);
      if (idx < 0) throw new Error("工作流不存在");
      workflows[idx] = { ...workflows[idx], ...input, id: input.id, updatedAt: now };
    } else {
      workflows.push({ ...input, id: newId(), createdAt: now, updatedAt: now });
    }
    writeWorkflows(workflows);
    return workflows;
  });

  ipcMain.handle("workflows:delete", (_e, id: string) => {
    const target = readWorkflows().find((w) => w.id === id);
    if (target?.builtin) throw new Error("内置工作流不可删除");
    const workflows = readWorkflows().filter((w) => w.id !== id);
    writeWorkflows(workflows);
    return workflows;
  });

  ipcMain.handle("workflows:generate", async (_e, description: string, providerId: string) => {
    const provider = requireProvider(providerId);
    return workflowEngine.generate(provider, getKey, description);
  });

  ipcMain.handle(
    "workflows:optimize",
    async (
      _e,
      current: { nodes: WorkflowNode[]; edges: WorkflowEdge[] },
      instruction: string,
      providerId: string
    ) => {
      const provider = requireProvider(providerId);
      return workflowEngine.optimize(provider, getKey, current, instruction);
    }
  );

  ipcMain.handle(
    "workflows:run",
    async (
      e: IpcMainInvokeEvent,
      runId: string,
      workflowId: string,
      input: string
    ): Promise<{ finalOutput?: string; error?: string }> => {
      const workflow = readWorkflows().find((w) => w.id === workflowId);
      if (!workflow) throw new Error("工作流不存在");
      return workflowEngine.run(
        e.sender,
        runId,
        workflow,
        readAgents(),
        readModels(),
        getKey,
        input
      );
    }
  );

  ipcMain.handle("workflows:stop", (_e, runId: string): void => {
    workflowEngine.stopRun(runId);
  });
}
