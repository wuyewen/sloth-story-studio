import { app, dialog, ipcMain, webContents, type IpcMainInvokeEvent } from "electron";
import fs from "node:fs";
import path from "node:path";
import type {
  AgentInput,
  AgentProfile,
  AppSettings,
  ChatRequest,
  ItemGroup,
  ModelProviderInfo,
  ModelProviderInput,
  ProposalInput,
  StateEntity,
  StateEntityInput,
  StateExtractItem,
  StyleProfileInput,
  WorkflowEdge,
  WorkflowInput,
  WorkflowNode
} from "../../shared/types.js";
import {
  migrateStoreFile,
  newId,
  readAgents,
  readGroups,
  readModels,
  readSettings,
  readWorkflows,
  writeAgents,
  writeGroups,
  writeModels,
  writeSettings,
  writeWorkflows,
  type ModelRecord
} from "../services/store.js";
import { decryptKey, encryptKey, isEncryptionAvailable } from "../services/crypto.js";
import { abortStream, chat, chatStream } from "../services/llmClient.js";
import { isSafeCondition } from "../services/condExpr.js";
import * as novelFs from "../services/novelFs.js";
import * as novelState from "../services/novelState.js";
import * as proposals from "../services/proposals.js";
import * as styleStore from "../services/styleStore.js";
import * as workflowEngine from "../services/workflowEngine.js";
import { openConfigWindow } from "../windows.js";

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
  ipcMain.handle("app:openConfig", (_e, kind: "models" | "settings") => {
    openConfigWindow(kind);
  });

  ipcMain.handle("app:encryptionAvailable", () => isEncryptionAvailable());
  ipcMain.handle("app:version", () => app.getVersion());

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
        sendTemperature: input.sendTemperature !== false,
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
        sendTemperature: input.sendTemperature !== false,
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
          sendTemperature: input.sendTemperature !== false,
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
    if (patch.styleDir && patch.styleDir !== prev.styleDir) {
      migrateStoreFile("styles.json", patch.styleDir);
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

  // ---- 分组（agents / workflows 共用结构） ----

  const groupHandlers = (kind: "agent" | "workflow") => {
    const prefix = kind === "agent" ? "agents" : "workflows";
    const readItems = kind === "agent" ? readAgents : readWorkflows;
    const writeItems = kind === "agent" ? writeAgents : writeWorkflows;

    ipcMain.handle(`${prefix}:groupsList`, () => readGroups(kind));

    ipcMain.handle(`${prefix}:groupsCreate`, (_e, name: string): ItemGroup[] => {
      const groups = readGroups(kind);
      groups.push({ id: newId(), name: name.trim() || "未命名分组", createdAt: Date.now() });
      writeGroups(kind, groups);
      return groups;
    });

    ipcMain.handle(`${prefix}:groupsRename`, (_e, id: string, name: string): ItemGroup[] => {
      const groups = readGroups(kind);
      const g = groups.find((x) => x.id === id);
      if (!g) throw new Error("分组不存在");
      g.name = name.trim() || g.name;
      writeGroups(kind, groups);
      return groups;
    });

    ipcMain.handle(`${prefix}:groupsDelete`, (_e, id: string): ItemGroup[] => {
      writeGroups(kind, readGroups(kind).filter((g) => g.id !== id));
      // 组内成员回落默认分组
      const items = readItems() as Array<{ id: string; groupId?: string | null }>;
      let touched = false;
      for (const item of items) {
        if (item.groupId === id) {
          item.groupId = null;
          touched = true;
        }
      }
      if (touched) writeItems(items as never);
      return readGroups(kind);
    });

    ipcMain.handle(`${prefix}:setGroup`, (_e, itemId: string, groupId: string | null) => {
      const items = readItems() as Array<{ id: string; groupId?: string | null }>;
      const item = items.find((x) => x.id === itemId);
      if (!item) throw new Error("条目不存在");
      item.groupId = groupId;
      writeItems(items as never);
      return items;
    });
  };

  groupHandlers("agent");
  groupHandlers("workflow");

  // ---- novels ----

  ipcMain.handle("novels:list", () => novelFs.list());
  ipcMain.handle("novels:create", (_e, title: string, synopsis: string) =>
    novelFs.create(title, synopsis)
  );
  ipcMain.handle("novels:rename", (_e, id: string, title: string) => novelFs.rename(id, title));

  ipcMain.handle("novels:updateMeta", (_e, id: string, patch: { title?: string; synopsis?: string; styleId?: string | null; unitChapterCap?: number | null }) =>
    novelFs.updateMeta(id, patch)
  );

  ipcMain.handle("novels:assignWorkflow", (_e, projectId: string, workflowId: string) =>
    novelFs.assignWorkflow(projectId, workflowId)
  );

  ipcMain.handle("novels:unassignWorkflow", (_e, projectId: string, workflowId: string) =>
    novelFs.unassignWorkflow(projectId, workflowId)
  );

  ipcMain.handle("novels:setWorkflowSlot", (_e, projectId: string, slot: string, workflowId: string | null) =>
    novelFs.setWorkflowSlot(projectId, slot, workflowId)
  );
  ipcMain.handle("novels:remove", (_e, id: string) => novelFs.remove(id));
  ipcMain.handle("novels:createChapter", (_e, projectId: string, title: string, unitId?: string) =>
    novelFs.createChapter(projectId, title, unitId)
  );
  ipcMain.handle("novels:deleteChapter", (_e, projectId: string, chapterId: string) =>
    novelFs.deleteChapter(projectId, chapterId)
  );
  ipcMain.handle("novels:readChapter", (_e, projectId: string, chapterId: string) =>
    novelFs.readChapter(projectId, chapterId)
  );
  ipcMain.handle(
    "novels:writeChapter",
    (_e, projectId: string, chapterId: string, content: string, source?: string) =>
      novelFs.writeChapter(projectId, chapterId, content, source)
  );

  ipcMain.handle("novels:chapterVersions", (_e, projectId: string, chapterId: string) =>
    novelFs.chapterVersions(projectId, chapterId)
  );

  ipcMain.handle("novels:chapterVersionRead", (_e, projectId: string, chapterId: string, ts: number) =>
    novelFs.chapterVersionRead(projectId, chapterId, ts)
  );

  ipcMain.handle("novels:chapterRollback", (_e, projectId: string, chapterId: string, ts: number) =>
    novelFs.chapterRollback(projectId, chapterId, ts)
  );

  ipcMain.handle("novels:createUnit", (_e, projectId: string, title: string) =>
    novelFs.createUnit(projectId, title)
  );

  ipcMain.handle("novels:renameUnit", (_e, projectId: string, unitId: string, title: string) =>
    novelFs.renameUnit(projectId, unitId, title)
  );

  ipcMain.handle("novels:renameChapter", (_e, projectId: string, chapterId: string, title: string) =>
    novelFs.renameChapter(projectId, chapterId, title)
  );

  ipcMain.handle("novels:deleteUnit", (_e, projectId: string, unitId: string) =>
    novelFs.deleteUnit(projectId, unitId)
  );

  ipcMain.handle(
    "novels:setChapterUnit",
    (_e, projectId: string, chapterId: string, unitId: string) =>
      novelFs.setChapterUnit(projectId, chapterId, unitId)
  );

  ipcMain.handle("novels:unsetChapterUnit", (_e, projectId: string, chapterId: string) =>
    novelFs.unsetChapterUnit(projectId, chapterId)
  );

  ipcMain.handle("novels:memoryList", (_e, projectId: string) => novelFs.memoryList(projectId));

  ipcMain.handle("novels:memoryRead", (_e, projectId: string, rel: string) =>
    novelFs.memoryRead(projectId, rel)
  );

  ipcMain.handle("novels:memoryWrite", (_e, projectId: string, rel: string, content: string) =>
    novelFs.memoryWrite(projectId, rel, content)
  );

  ipcMain.handle("novels:memoryDelete", (_e, projectId: string, rel: string) =>
    novelFs.memoryDelete(projectId, rel)
  );

  ipcMain.handle("novels:memoryHistory", (_e, projectId: string, rel: string) =>
    novelFs.memoryHistory(projectId, rel)
  );

  ipcMain.handle("novels:memoryReadVersion", (_e, projectId: string, rel: string, ts: number) =>
    novelFs.memoryReadVersion(projectId, rel, ts)
  );

  ipcMain.handle("novels:memoryRestore", (_e, projectId: string, rel: string, ts: number) =>
    novelFs.memoryRestore(projectId, rel, ts)
  );

  ipcMain.handle("novels:runHistory", (_e, projectId: string) => novelFs.runHistory(projectId));

  ipcMain.handle("novels:revealArtifact", (_e, projectId: string, rel: string) =>
    novelFs.revealArtifact(projectId, rel)
  );

  // ---- 结构化状态库（FR-03）----

  ipcMain.handle("novels:stateList", (_e, projectId: string) => novelState.load(projectId));

  ipcMain.handle("novels:stateUpsert", (_e, projectId: string, input: StateEntityInput) =>
    novelState.upsert(projectId, input)
  );

  ipcMain.handle("novels:stateRemove", (_e, projectId: string, id: string) =>
    novelState.remove(projectId, id)
  );

  ipcMain.handle("novels:stateSetLock", (_e, projectId: string, id: string, locked: boolean) =>
    novelState.setLock(projectId, id, locked)
  );

  // ---- 风格模板（FR-06，应用级存储）----

  ipcMain.handle("styles:list", () => styleStore.list());

  ipcMain.handle("styles:create", (_e, input: StyleProfileInput) => styleStore.create(input));

  ipcMain.handle("styles:update", (_e, id: string, input: StyleProfileInput) =>
    styleStore.update(id, input)
  );

  ipcMain.handle("styles:duplicate", (_e, id: string) => styleStore.duplicate(id));

  ipcMain.handle("styles:delete", (_e, id: string) => styleStore.remove(id));

  ipcMain.handle("styles:listHistory", (_e, id: string) => styleStore.listHistory(id));

  ipcMain.handle("styles:restoreVersion", (_e, id: string, version: number) =>
    styleStore.restoreVersion(id, version)
  );

  // ---- 章节记忆提取（FR-04）：解析后不落库，返回提案列表给渲染端审阅 ----

  ipcMain.handle(
    "novels:extractChapterState",
    async (
      _e,
      projectId: string,
      chapterRef: { unitId?: string; chapterId: string }
    ): Promise<{ chapterTitle: string; items: StateExtractItem[] }> => {
      const project = novelFs.list().find((p) => p.id === projectId);
      const chapter = project?.chapters.find((c) => c.id === chapterRef.chapterId);
      if (!project || !chapter) throw new Error("章节不存在");
      const content = novelFs.readChapter(projectId, chapterRef.chapterId);
      if (!content.trim()) throw new Error(`章节《${chapter.title}》还没有正文内容`);

      const record = readModels().find((m) => m.enabled);
      if (!record) throw new Error("没有可用的大模型配置，请先在设置中启用一个模型");
      const { apiKeyEnc: _enc, ...provider } = record;

      const existing = novelState.load(projectId);
      const existingSummary =
        existing.length > 0
          ? existing
              .map((e) => `- [${e.type}] ${e.name}（${e.status === "confirmed" ? "已确认" : "推断"}）：${e.data.slice(0, 200)}`)
              .join("\n")
          : "（暂无）";

      const system = `你是小说创作的状态提取助手。从章节正文中提取结构化状态实体，只输出一个 JSON 数组，不要输出任何其他文字。
元素格式：{"type":"character|foreshadowing|event|item|rule|location","name":"实体名","data":"状态描述（简明 markdown）","status":"confirmed|inferred"}
规则：
- type 只能是六种之一：character 角色、foreshadowing 伏笔、event 事件、item 物品、rule 规则/设定、location 地点。
- 正文明确写出的事实 status 填 confirmed；推测、暗示填 inferred。
- 只提取本章新增或发生变化的事实；已有实体没有变化就不要重复输出。
- 只输出 JSON 数组，不要 markdown 代码围栏，不要解释。`;

      const user = `章节标题：${chapter.title}

已有实体（供判重，无需重复输出无变化项）：
${existingSummary}

章节正文：
${content}`;

      const raw = await chat(provider, getKey(record.id), [
        { role: "system", content: system },
        { role: "user", content: user }
      ]);

      const fenced = raw.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
      const text = fenced ? fenced[1] : raw.trim();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(`模型输出不是有效 JSON。输出前 200 字：${raw.slice(0, 200)}`);
      }
      if (!Array.isArray(parsed)) {
        throw new Error(`模型输出不是有效 JSON 数组。输出前 200 字：${raw.slice(0, 200)}`);
      }

      const VALID_TYPES = ["character", "foreshadowing", "event", "item", "rule", "location"];
      const items: StateExtractItem[] = [];
      for (const item of parsed as Array<Record<string, unknown>>) {
        if (!item || typeof item.name !== "string" || !item.name.trim()) continue;
        if (typeof item.data !== "string" || !item.data.trim()) continue;
        if (typeof item.type !== "string" || !VALID_TYPES.includes(item.type)) continue;
        const entity = {
          type: item.type as StateEntity["type"],
          name: item.name.trim(),
          data: item.data.trim(),
          status: (item.status === "confirmed" ? "confirmed" : "inferred") as "confirmed" | "inferred",
          source: chapter.title
        };
        const match = existing.find((e) => e.type === entity.type && e.name === entity.name);
        const relation: StateExtractItem["relation"] = !match
          ? "new"
          : match.locked || (match.status === "confirmed" && match.data !== entity.data)
            ? "conflict"
            : "update";
        items.push({ entity, relation, ...(match ? { existingData: match.data } : {}) });
      }
      return { chapterTitle: chapter.title, items };
    }
  );

  // ---- 记忆提案 ----

  ipcMain.handle("proposals:list", (_e, projectId: string) => proposals.list(projectId));

  ipcMain.handle("proposals:create", (_e, projectId: string, input: ProposalInput) =>
    proposals.create(projectId, input)
  );

  ipcMain.handle("proposals:accept", (_e, projectId: string, id: string, force?: boolean) =>
    proposals.accept(projectId, id, force)
  );

  ipcMain.handle("proposals:reject", (_e, projectId: string, id: string) =>
    proposals.reject(projectId, id)
  );

  ipcMain.handle("proposals:currentOf", (_e, projectId: string, id: string) =>
    proposals.currentOf(projectId, id)
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
    // F-01：保存前校验边条件能被白名单求值器解析，不能解析的清空条件并告警
    for (const edge of input.edges) {
      const expr = edge.data?.conditionExpr;
      if (expr && !isSafeCondition(expr)) {
        console.warn(`[ipc] 工作流「${input.name}」存在不被安全求值器支持的边条件，已清空: ${expr.slice(0, 120)}`);
        if (edge.data) delete edge.data.conditionExpr;
      }
    }
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
      input: string,
      projectId?: string,
      resumeFromRunId?: string
    ): Promise<{ finalOutput?: string; error?: string; proposalsCreated?: number }> => {
      const workflow = readWorkflows().find((w) => w.id === workflowId);
      if (!workflow) throw new Error("工作流不存在");
      // 断点续跑：从上次运行的记录中取出已成功节点的输出构建重放表；找不到记录则按普通运行
      let replayOutputs: Record<string, string> | undefined;
      let effectiveInput = input;
      if (resumeFromRunId && projectId) {
        const prev = novelFs.runHistory(projectId).find((r) => r.runId === resumeFromRunId);
        if (prev) {
          // F-05：续跑绑定工作流版本——id 与定义哈希都必须一致，否则拒绝重放
          if (
            prev.workflowId !== workflow.id ||
            !prev.workflowHash ||
            prev.workflowHash !== workflowEngine.computeWorkflowHash(workflow)
          ) {
            throw new Error("工作流已修改，无法从断点继续，请重新开始运行");
          }
          if (prev.nodeRuns) {
            const table: Record<string, string> = {};
            for (const nr of prev.nodeRuns) {
              if (nr.status === "succeeded" && typeof nr.output === "string") {
                table[`${nr.nodeId}#${nr.attempt}`] = nr.output;
              }
            }
            if (Object.keys(table).length > 0) {
              replayOutputs = table;
              if (typeof prev.input === "string") effectiveInput = prev.input;
            }
          }
        }
      }
      return workflowEngine.run(
        e.sender,
        runId,
        workflow,
        readAgents(),
        readModels(),
        getKey,
        effectiveInput,
        projectId,
        replayOutputs
      );
    }
  );

  ipcMain.handle("workflows:stop", (_e, runId: string): void => {
    workflowEngine.stopRun(runId);
  });
}
