import fs from "node:fs";
import path from "node:path";
import type { StateEntity, StateEntityInput, StateEntityType } from "../../shared/types.js";
import { newId } from "./store.js";
import { initMemory, novelDirPath } from "./novelFs.js";

// 结构化状态库（FR-03）：数据存 <项目>/memory/state.json，每次保存后物化出 memory/state-<type>s.md，
// 供工作流通过 {{memory.state-characters}} 等插值直接引用。

const STATE_FILE = "state.json";

const TYPE_FILE: Record<StateEntityType, string> = {
  character: "state-characters.md",
  foreshadowing: "state-foreshadowing.md",
  event: "state-events.md",
  item: "state-items.md",
  rule: "state-rules.md",
  location: "state-locations.md"
};

const TYPE_LABEL: Record<StateEntityType, string> = {
  character: "角色",
  foreshadowing: "伏笔",
  event: "事件",
  item: "物品",
  rule: "规则",
  location: "地点"
};

// 物化文件头标记：只有带该标记的文件才允许在实体清空时删除（绝不误删用户手写文件）
const GENERATED_MARK = "<!-- 由结构化状态库自动生成，请勿手动编辑 -->";

function memoryDir(projectId: string): string {
  initMemory(projectId);
  return path.join(novelDirPath(), projectId, "memory");
}

function statePath(projectId: string): string {
  return path.join(memoryDir(projectId), STATE_FILE);
}

function writeFileAtomic(file: string, content: string): void {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, "utf-8");
  fs.renameSync(tmp, file);
}

// 文件不存在返回空表；损坏时告警并返回空表，不崩
export function load(projectId: string): StateEntity[] {
  const file = statePath(projectId);
  try {
    if (!fs.existsSync(file)) return [];
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as unknown;
    if (!Array.isArray(parsed)) throw new Error("state.json 不是数组");
    return parsed.filter(
      (e): e is StateEntity =>
        Boolean(e) && typeof (e as StateEntity).id === "string" && typeof (e as StateEntity).name === "string"
    );
  } catch (err) {
    console.warn(`[novelState] state.json 读取失败，按空表处理: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function save(projectId: string, entities: StateEntity[]): void {
  try {
    writeFileAtomic(statePath(projectId), JSON.stringify(entities, null, 2));
    materialize(projectId, entities);
  } catch (err) {
    console.warn(`[novelState] state.json 写入失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// 把状态按类型物化成 memory/state-<type>s.md（每个实体一段：名称、状态、来源，冲突标【冲突】）
export function materialize(projectId: string, entities?: StateEntity[]): void {
  const list = entities ?? load(projectId);
  const dir = memoryDir(projectId);
  for (const type of Object.keys(TYPE_FILE) as StateEntityType[]) {
    const file = path.join(dir, TYPE_FILE[type]);
    const items = list.filter((e) => e.type === type);
    try {
      if (items.length === 0) {
        // 该类型已清空：仅删除我们自己生成的文件
        if (fs.existsSync(file) && fs.readFileSync(file, "utf-8").includes(GENERATED_MARK)) {
          fs.rmSync(file, { force: true });
        }
        continue;
      }
      const body = [
        GENERATED_MARK,
        `# 结构化状态 · ${TYPE_LABEL[type]}`,
        "",
        ...items.map((e) =>
          [
            `## ${e.name}`,
            `- 状态：${e.status === "confirmed" ? "已确认" : "推断"}${e.locked ? " · 已锁定" : ""}`,
            ...(e.source ? [`- 来源：${e.source}`] : []),
            ...(e.conflict ? [`- 【冲突】${e.conflict}`] : []),
            "",
            e.data
          ].join("\n")
        )
      ].join("\n");
      writeFileAtomic(file, body + "\n");
    } catch (err) {
      console.warn(`[novelState] 物化 ${TYPE_FILE[type]} 失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

const short = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

// 同 type+name（或显式 id）视为同一实体
// - 普通写入：locked 或 confirmed 且内容不同的既有实体不覆盖，标 conflict
// - force：强制覆盖，旧值记入 conflict 备注（作者手动覆盖）
// - clearConflict：作者手动编辑，写入并清除冲突标记
export function upsert(projectId: string, input: StateEntityInput): StateEntity[] {
  const entities = load(projectId);
  const name = input.name.trim();
  if (!name) throw new Error("实体名称不能为空");
  const idx = input.id
    ? entities.findIndex((e) => e.id === input.id)
    : entities.findIndex((e) => e.type === input.type && e.name === name);
  const now = Date.now();

  if (idx < 0) {
    entities.push({
      id: newId(),
      type: input.type,
      name,
      data: input.data,
      status: input.status ?? "confirmed",
      ...(input.source ? { source: input.source } : {}),
      updatedAt: now
    });
    save(projectId, entities);
    return entities;
  }

  const existing = entities[idx];
  const sameContent = existing.data === input.data;
  const next: StateEntity = { ...existing, updatedAt: now };

  if (input.clearConflict) {
    next.data = input.data;
    next.status = input.status ?? existing.status;
    if (input.source !== undefined) next.source = input.source || undefined;
    delete next.conflict;
  } else if (input.force) {
    next.data = input.data;
    next.status = input.status ?? existing.status;
    if (input.source !== undefined) next.source = input.source || undefined;
    if (!sameContent) {
      next.conflict = `已被作者手动覆盖。原内容：${short(existing.data, 500)}`;
    } else {
      delete next.conflict;
    }
  } else if (existing.locked && !sameContent) {
    next.conflict = `实体已锁定，未应用新内容。被驳回的内容：${short(input.data, 500)}`;
  } else if (existing.status === "confirmed" && !sameContent) {
    next.conflict = `与已确认内容不一致，未自动覆盖。新内容：${short(input.data, 500)}`;
  } else {
    next.data = input.data;
    next.status = input.status ?? existing.status;
    if (input.source !== undefined) next.source = input.source || undefined;
    if (!sameContent) delete next.conflict;
  }

  entities[idx] = next;
  save(projectId, entities);
  return entities;
}

export function remove(projectId: string, id: string): StateEntity[] {
  const entities = load(projectId).filter((e) => e.id !== id);
  save(projectId, entities);
  return entities;
}

export function setLock(projectId: string, id: string, locked: boolean): StateEntity[] {
  const entities = load(projectId);
  const target = entities.find((e) => e.id === id);
  if (!target) throw new Error("状态实体不存在");
  target.locked = locked || undefined;
  target.updatedAt = Date.now();
  save(projectId, entities);
  return entities;
}
