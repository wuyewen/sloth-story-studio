import fs from "node:fs";
import type { StyleProfile, StyleProfileInput, StyleProfileVersion } from "../../shared/types.js";
import { newId, stylesFile } from "./store.js";

// 风格模板（FR-06）：默认存应用数据目录 styles.json，可在系统设置里自定义目录（settings.styleDir），跨项目复用。
// history 记录每次保存前的旧版本快照，每个模板最多保留 20 版。

interface StyleFile {
  profiles: StyleProfile[];
  history: Record<string, StyleProfileVersion[]>;
}

const HISTORY_LIMIT = 20;

function read(): StyleFile {
  let raw: unknown = null;
  try {
    raw = JSON.parse(fs.readFileSync(stylesFile(), "utf-8"));
  } catch {
    return { profiles: [], history: {} };
  }
  try {
    const obj = raw as Partial<StyleFile> | null;
    if (!obj || !Array.isArray(obj.profiles)) throw new Error("styles.json 结构不符");
    return {
      profiles: obj.profiles.filter((p): p is StyleProfile => Boolean(p) && typeof p.id === "string" && typeof p.name === "string"),
      history: obj.history && typeof obj.history === "object" ? obj.history : {}
    };
  } catch (err) {
    console.warn(`[styleStore] styles.json 读取失败，按空表处理: ${err instanceof Error ? err.message : String(err)}`);
    return { profiles: [], history: {} };
  }
}

function write(file: StyleFile): void {
  const target = stylesFile();
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2), "utf-8");
  fs.renameSync(tmp, target);
}

function sorted(profiles: StyleProfile[]): StyleProfile[] {
  return [...profiles].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function list(): StyleProfile[] {
  return sorted(read().profiles);
}

export function get(id: string): StyleProfile | null {
  return read().profiles.find((p) => p.id === id) ?? null;
}

function normalize(input: StyleProfileInput): StyleProfileInput {
  return {
    name: input.name.trim() || "未命名风格",
    genre: (input.genre ?? []).map((s) => s.trim()).filter(Boolean),
    tone: (input.tone ?? []).map((s) => s.trim()).filter(Boolean),
    pacing: input.pacing?.trim() || undefined,
    pointOfView: input.pointOfView?.trim() || undefined,
    tense: input.tense?.trim() || undefined,
    proseRules: (input.proseRules ?? []).map((s) => s.trim()).filter(Boolean),
    dialogueRules: (input.dialogueRules ?? []).map((s) => s.trim()).filter(Boolean),
    avoidRules: (input.avoidRules ?? []).map((s) => s.trim()).filter(Boolean),
    referenceExample: input.referenceExample?.trim() || undefined
  };
}

export function create(input: StyleProfileInput): StyleProfile[] {
  const file = read();
  file.profiles.push({ ...normalize(input), id: newId(), version: 1, updatedAt: Date.now() });
  write(file);
  return sorted(file.profiles);
}

export function update(id: string, input: StyleProfileInput): StyleProfile[] {
  const file = read();
  const idx = file.profiles.findIndex((p) => p.id === id);
  if (idx < 0) throw new Error("风格模板不存在");
  const prev = file.profiles[idx];
  // 旧版本快照入 history（最多 20 版）
  const hist = file.history[id] ?? [];
  hist.push({ version: prev.version, savedAt: prev.updatedAt, snapshot: prev });
  file.history[id] = hist.slice(-HISTORY_LIMIT);
  file.profiles[idx] = { ...prev, ...normalize(input), version: prev.version + 1, updatedAt: Date.now() };
  write(file);
  return sorted(file.profiles);
}

export function duplicate(id: string): StyleProfile[] {
  const file = read();
  const src = file.profiles.find((p) => p.id === id);
  if (!src) throw new Error("风格模板不存在");
  const { id: _id, version: _v, updatedAt: _u, ...rest } = src;
  file.profiles.push({ ...rest, name: `${src.name} 副本`, id: newId(), version: 1, updatedAt: Date.now() });
  write(file);
  return sorted(file.profiles);
}

export function remove(id: string): StyleProfile[] {
  const file = read();
  file.profiles = file.profiles.filter((p) => p.id !== id);
  delete file.history[id];
  write(file);
  return sorted(file.profiles);
}

export function listHistory(id: string): StyleProfileVersion[] {
  return [...(read().history[id] ?? [])].sort((a, b) => b.version - a.version);
}

// 恢复指定版本：以该快照内容生成一个新版本（当前版本照常入 history）
export function restoreVersion(id: string, version: number): StyleProfile[] {
  const file = read();
  const idx = file.profiles.findIndex((p) => p.id === id);
  if (idx < 0) throw new Error("风格模板不存在");
  const snap = (file.history[id] ?? []).find((v) => v.version === version);
  if (!snap) throw new Error("该版本不存在");
  const prev = file.profiles[idx];
  const hist = file.history[id] ?? [];
  hist.push({ version: prev.version, savedAt: prev.updatedAt, snapshot: prev });
  file.history[id] = hist.slice(-HISTORY_LIMIT);
  const { id: _id, version: _v, updatedAt: _u, ...content } = snap.snapshot;
  file.profiles[idx] = { ...content, id, version: prev.version + 1, updatedAt: Date.now() };
  write(file);
  return sorted(file.profiles);
}

// 构建 {{style.*}} 插值上下文：数组字段拼成 "- a\n- b" 列表；full 为完整风格块
export function styleContextMap(profile: StyleProfile | null): Map<string, string> {
  const map = new Map<string, string>();
  if (!profile) return map;
  const listOf = (arr: string[]): string => arr.map((s) => `- ${s}`).join("\n");
  map.set("name", profile.name);
  map.set("version", `v${profile.version}`);
  map.set("genre", listOf(profile.genre));
  map.set("tone", listOf(profile.tone));
  map.set("pacing", profile.pacing ?? "");
  map.set("pointOfView", profile.pointOfView ?? "");
  map.set("tense", profile.tense ?? "");
  map.set("proseRules", listOf(profile.proseRules));
  map.set("dialogueRules", listOf(profile.dialogueRules));
  map.set("avoidRules", listOf(profile.avoidRules));
  map.set("referenceExample", profile.referenceExample ?? "");

  const sections: string[] = [`风格模板：${profile.name}（v${profile.version}）`];
  if (profile.genre.length) sections.push(`题材：${profile.genre.join("、")}`);
  if (profile.tone.length) sections.push(`基调：${profile.tone.join("、")}`);
  if (profile.pacing) sections.push(`节奏：${profile.pacing}`);
  if (profile.pointOfView) sections.push(`叙事视角：${profile.pointOfView}`);
  if (profile.tense) sections.push(`时态：${profile.tense}`);
  if (profile.proseRules.length) sections.push(`行文规则：\n${listOf(profile.proseRules)}`);
  if (profile.dialogueRules.length) sections.push(`对话规则：\n${listOf(profile.dialogueRules)}`);
  if (profile.avoidRules.length) sections.push(`禁忌（避免出现的写法）：\n${listOf(profile.avoidRules)}`);
  if (profile.referenceExample) sections.push(`参考示例（作者认可的原创段落，用于校准文风）：\n${profile.referenceExample}`);
  map.set("full", sections.join("\n"));
  return map;
}
