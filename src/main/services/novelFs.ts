import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { shell } from "electron";
import type { ChapterMeta, MemoryFileInfo, MemoryVersion, NovelProject, UnitMeta, WorkflowRunRecord, WorkflowSlot } from "../../shared/types.js";
import { newId, readSettings } from "./store.js";

function novelDir(): string {
  const settings = readSettings();
  const dir = settings.novelDir || path.join(os.homedir(), "Documents", "SlothStories");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function novelDirPath(): string {
  return novelDir();
}

function sanitizeName(name: string): string {
  const cleaned = name.replace(/[/\\:*?"<>|\r\n\t]/g, "").trim();
  return cleaned || "untitled";
}

interface MetaFile {
  id: string;
  title: string;
  synopsis: string;
  createdAt: number;
  updatedAt: number;
  chapters: ChapterMeta[];
  units?: UnitMeta[];
  workflowIds?: string[];
  workflowSlots?: Partial<Record<WorkflowSlot, string>>;
}

// ---- 项目级共享记忆 ----

const MEMORY_DIR = "memory";

// 默认记忆文件已取消：新项目 memory/ 为空目录，由用户/提案自行创建
const MEMORY_DEFAULTS: Record<string, string> = {};

// 旧版默认占位文件（内容未被改过的才清理，用户写过的保留）
const LEGACY_DEFAULTS: Record<string, string> = {
  "story-bible.md": "# 全书核心设定\n",
  "system-design.md": "# 系统设计\n",
  "world-bible.md": "# 世界观设定\n",
  "master-outline.md": "# 全书大纲\n",
  "style-guide.md": "# 风格规范\n",
  "character-state.md": "# 角色状态\n",
  "foreshadowing-tracker.md": "# 伏笔追踪表\n",
  "material-library.md": "# 素材库\n"
};

const MEMORY_SUBDIRS = [
  "memory/unit-summaries",
  "memory/handoffs",
  "reviews",
  "workflow-runs",
  "memory-proposals/pending",
  "memory-proposals/applied"
];

// 初始化记忆目录：幂等、绝不覆盖已有文件
export function initMemory(projectId: string): void {
  const root = projectDirOf(projectId);
  const memDir = path.join(root, MEMORY_DIR);
  fs.mkdirSync(memDir, { recursive: true });
  for (const sub of MEMORY_SUBDIRS) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  for (const [name, content] of Object.entries(MEMORY_DEFAULTS)) {
    const file = path.join(memDir, name);
    if (!fs.existsSync(file)) fs.writeFileSync(file, content, "utf-8");
  }
  // 清理旧版默认占位文件（仅限内容未被用户修改过的）
  for (const [name, content] of Object.entries(LEGACY_DEFAULTS)) {
    const file = path.join(memDir, name);
    if (fs.existsSync(file) && fs.readFileSync(file, "utf-8") === content) {
      fs.rmSync(file);
    }
  }
}

// 校验并解析 memory/ 内的相对路径，拒绝路径穿越
function resolveMemoryPath(projectId: string, rel: string): string {
  const memDir = path.join(projectDirOf(projectId), MEMORY_DIR);
  if (!rel || rel.includes("\0") || path.isAbsolute(rel)) throw new Error("非法路径");
  const resolved = path.resolve(memDir, rel);
  const prefix = memDir.endsWith(path.sep) ? memDir : memDir + path.sep;
  if (resolved !== memDir && !resolved.startsWith(prefix)) throw new Error("非法路径：越出记忆目录");
  return resolved;
}

export function memoryList(projectId: string): MemoryFileInfo[] {
  initMemory(projectId);
  const memDir = path.join(projectDirOf(projectId), MEMORY_DIR);
  const out: MemoryFileInfo[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue; // 跳过 .history 等隐藏目录/文件
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        const stat = fs.statSync(full);
        out.push({ rel: path.relative(memDir, full), size: stat.size, updatedAt: stat.mtimeMs });
      }
    }
  };
  walk(memDir);
  out.sort((a, b) => a.rel.localeCompare(b.rel));
  return out;
}

export function memoryRead(projectId: string, rel: string): string {
  const file = resolveMemoryPath(projectId, rel);
  if (!fs.existsSync(file)) return "";
  return fs.readFileSync(file, "utf-8");
}

export function memoryWrite(projectId: string, rel: string, content: string): void {
  const file = resolveMemoryPath(projectId, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 写入前快照旧版本（最多保留 10 份）
  if (fs.existsSync(file)) {
    const prev = fs.readFileSync(file, "utf-8");
    if (prev !== content) snapshotMemory(projectId, rel, prev);
  }
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, "utf-8");
  fs.renameSync(tmp, file);
}

export function memoryDelete(projectId: string, rel: string): void {
  const file = resolveMemoryPath(projectId, rel);
  fs.rmSync(file, { force: true });
}

// ---- 记忆版本历史 ----

const HISTORY_KEEP = 10;

function historyDir(projectId: string): string {
  const dir = path.join(projectDirOf(projectId), MEMORY_DIR, ".history");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function historyName(rel: string, ts: number): string {
  const d = new Date(ts);
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}${String(d.getSeconds()).padStart(2, "0")}`;
  return `${rel.replace(/[/\\]/g, "__")}.${stamp}.md`;
}

function snapshotMemory(projectId: string, rel: string, content: string): void {
  const dir = historyDir(projectId);
  const prefix = `${rel.replace(/[/\\]/g, "__")}.`;
  fs.writeFileSync(path.join(dir, historyName(rel, Date.now())), content, "utf-8");
  const versions = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".md"))
    .sort();
  while (versions.length > HISTORY_KEEP) {
    fs.rmSync(path.join(dir, versions.shift() as string), { force: true });
  }
}

export function memoryHistory(projectId: string, rel: string): MemoryVersion[] {
  const dir = historyDir(projectId);
  const prefix = `${rel.replace(/[/\\]/g, "__")}.`;
  const parseStamp = (s: string): number => {
    if (/^\d{8}-\d{6}$/.test(s)) {
      return new Date(
        Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)),
        Number(s.slice(9, 11)), Number(s.slice(11, 13)), Number(s.slice(13, 15))
      ).getTime();
    }
    return Number(s); // 旧的毫秒时间戳格式
  };
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".md"))
    .map((f) => {
      const ts = parseStamp(f.slice(prefix.length, -3));
      const stat = fs.statSync(path.join(dir, f));
      return { ts, size: stat.size };
    })
    .filter((v) => Number.isFinite(v.ts) && v.ts > 0)
    .sort((a, b) => b.ts - a.ts);
}

export function memoryReadVersion(projectId: string, rel: string, ts: number): string {
  const dir = historyDir(projectId);
  const prefix = `${rel.replace(/[/\\]/g, "__")}.`;
  const parseStamp = (s: string): number => {
    if (/^\d{8}-\d{6}$/.test(s)) {
      return new Date(
        Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)),
        Number(s.slice(9, 11)), Number(s.slice(11, 13)), Number(s.slice(13, 15))
      ).getTime();
    }
    return Number(s);
  };
  for (const f of fs.readdirSync(dir)) {
    if (!f.startsWith(prefix) || !f.endsWith(".md")) continue;
    if (parseStamp(f.slice(prefix.length, -3)) === ts) {
      return fs.readFileSync(path.join(dir, f), "utf-8");
    }
  }
  throw new Error("版本不存在");
}

export function memoryRestore(projectId: string, rel: string, ts: number): void {
  const content = memoryReadVersion(projectId, rel, ts);
  memoryWrite(projectId, rel, content);
}

// ---- 工作流运行历史 ----

// 把每次运行的最终输出存成可读 Markdown 产物，返回项目内相对路径
export function writeRunArtifact(
  projectId: string,
  workflowName: string,
  startedAt: number,
  finalOutput: string,
  status: string,
  error?: string
): string | null {
  if (!finalOutput.trim()) return null;
  const dir = path.join(projectDirOf(projectId), "workflow-runs");
  fs.mkdirSync(dir, { recursive: true });
  const d = new Date(startedAt);
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}${String(d.getSeconds()).padStart(2, "0")}`;
  const safeName = sanitizeName(workflowName).slice(0, 40);
  const rel = path.join("workflow-runs", `${stamp}-${safeName}.md`);
  const body = [
    `# ${workflowName}`,
    "",
    `- 时间：${d.toLocaleString()}`,
    `- 状态：${status === "done" ? "运行完成" : status === "stopped" ? "已停止" : "失败"}`,
    ...(error ? [`- 错误：${error}`] : []),
    "",
    "---",
    "",
    finalOutput
  ].join("\n");
  const file = path.join(projectDirOf(projectId), rel);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, body, "utf-8");
  fs.renameSync(tmp, file);
  return rel;
}

export function writeRunRecord(projectId: string, record: WorkflowRunRecord): void {
  const dir = path.join(projectDirOf(projectId), "workflow-runs");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${record.runId}.json`);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2), "utf-8");
  fs.renameSync(tmp, file);
}

export function runHistory(projectId: string): WorkflowRunRecord[] {
  const dir = path.join(projectDirOf(projectId), "workflow-runs");
  if (!fs.existsSync(dir)) return [];
  const out: WorkflowRunRecord[] = [];
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(dir, entry), "utf-8")) as WorkflowRunRecord);
    } catch {
      // 跳过损坏的记录
    }
  }
  out.sort((a, b) => b.startedAt - a.startedAt);
  return out.slice(0, 50);
}

export function revealArtifact(projectId: string, rel: string): void {
  if (rel.includes("..") || path.isAbsolute(rel)) throw new Error("非法路径");
  shell.showItemInFolder(path.join(projectDirOf(projectId), rel));
}

function metaPath(projectId: string): string {
  return path.join(novelDir(), projectId, "meta.json");
}

function readMeta(projectId: string): MetaFile {
  const raw = fs.readFileSync(metaPath(projectId), "utf-8");
  const meta = JSON.parse(raw) as MetaFile;
  // 老项目迁移：无 units 时全部章节归入「第 1 单元」
  if (!meta.units || meta.units.length === 0) {
    meta.units = [
      {
        id: newId(),
        title: "第 1 单元",
        chapterIds: meta.chapters.map((c) => c.id)
      }
    ];
  }
  return meta;
}

// 章节归属一致性：只清理已删除章节的悬空引用；单元外章节（如序章）允许存在
function normalizeUnits(meta: MetaFile): void {
  const units = meta.units ?? [];
  const chapterIds = new Set(meta.chapters.map((c) => c.id));
  for (const u of units) u.chapterIds = u.chapterIds.filter((id) => chapterIds.has(id));
}

function writeMeta(meta: MetaFile): void {
  normalizeUnits(meta);
  meta.updatedAt = Date.now();
  const file = metaPath(meta.id);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2), "utf-8");
  fs.renameSync(tmp, file);
}

function countWords(text: string): number {
  return text.replace(/\s+/g, "").length;
}

function projectDirOf(projectId: string): string {
  return path.join(novelDir(), projectId);
}

export function list(): NovelProject[] {
  const dir = novelDir();
  const out: NovelProject[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const metaFile = path.join(dir, entry.name, "meta.json");
    if (!fs.existsSync(metaFile)) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(metaFile, "utf-8")) as MetaFile;
      if (!meta.units || meta.units.length === 0) {
        // 老项目懒迁移
        meta.units = [
          { id: newId(), title: "第 1 单元", chapterIds: meta.chapters.map((c) => c.id) }
        ];
      }
      out.push({ ...meta, id: entry.name, units: meta.units, workflowIds: meta.workflowIds ?? [] });
      initMemory(entry.name);
    } catch {
      // 跳过损坏的项目
    }
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

export function create(title: string, synopsis: string): NovelProject[] {
  const now = Date.now();
  let dirName = sanitizeName(title);
  let candidate = dirName;
  let n = 1;
  while (fs.existsSync(path.join(novelDir(), candidate))) {
    n += 1;
    candidate = `${dirName}-${n}`;
  }
  dirName = candidate;
  fs.mkdirSync(path.join(novelDir(), dirName, "chapters"), { recursive: true });
  const meta: MetaFile = {
    id: dirName,
    title: title.trim() || dirName,
    synopsis,
    createdAt: now,
    updatedAt: now,
    chapters: [],
    units: [{ id: newId(), title: "第 1 单元", chapterIds: [] }]
  };
  fs.writeFileSync(metaPath(dirName), JSON.stringify(meta, null, 2), "utf-8");
  initMemory(dirName);
  return list();
}

export function rename(id: string, title: string): NovelProject[] {
  const meta = readMeta(id);
  meta.title = title.trim() || meta.title;
  writeMeta(meta);
  return list();
}

export function updateMeta(id: string, patch: { title?: string; synopsis?: string }): NovelProject[] {
  const meta = readMeta(id);
  if (patch.title !== undefined) meta.title = patch.title.trim() || meta.title;
  if (patch.synopsis !== undefined) meta.synopsis = patch.synopsis;
  writeMeta(meta);
  return list();
}

// ---- 项目 ↔ 工作流关联 ----

export function assignWorkflow(projectId: string, workflowId: string): NovelProject[] {
  const meta = readMeta(projectId);
  const ids = meta.workflowIds ?? [];
  if (!ids.includes(workflowId)) {
    meta.workflowIds = [...ids, workflowId];
    writeMeta(meta);
  }
  return list();
}

export function unassignWorkflow(projectId: string, workflowId: string): NovelProject[] {
  const meta = readMeta(projectId);
  meta.workflowIds = (meta.workflowIds ?? []).filter((id) => id !== workflowId);
  if (meta.workflowSlots) {
    for (const [slot, id] of Object.entries(meta.workflowSlots)) {
      if (id === workflowId) delete meta.workflowSlots[slot as keyof typeof meta.workflowSlots];
    }
  }
  writeMeta(meta);
  return list();
}

export function setWorkflowSlot(projectId: string, slot: string, workflowId: string | null): NovelProject[] {
  const meta = readMeta(projectId);
  const slots = { ...(meta.workflowSlots ?? {}) } as Record<string, string>;
  if (workflowId) {
    if (!(meta.workflowIds ?? []).includes(workflowId)) throw new Error("该工作流未关联到本项目");
    slots[slot] = workflowId;
  } else {
    delete slots[slot];
  }
  meta.workflowSlots = slots as MetaFile["workflowSlots"];
  writeMeta(meta);
  return list();
}

export function remove(id: string): NovelProject[] {
  fs.rmSync(projectDirOf(id), { recursive: true, force: true });
  return list();
}

function chapterFileName(index: number, title: string): string {
  const nn = String(index).padStart(2, "0");
  return `${nn}-${sanitizeName(title)}.md`;
}

export function createChapter(projectId: string, title: string): NovelProject[] {
  const meta = readMeta(projectId);
  const now = Date.now();
  const file = chapterFileName(meta.chapters.length + 1, title);
  const filePath = path.join(projectDirOf(projectId), "chapters", file);
  fs.writeFileSync(filePath, "", "utf-8");
  const chapter: ChapterMeta = {
    id: newId(),
    title: title.trim() || `第 ${meta.chapters.length + 1} 章`,
    file,
    words: 0,
    updatedAt: now
  };
  meta.chapters.push(chapter);
  writeMeta(meta);
  return list();
}

// 把章节移出所有单元（序章等独立于单元的章节）
export function unsetChapterUnit(projectId: string, chapterId: string): NovelProject[] {
  const meta = readMeta(projectId);
  findChapter(meta, chapterId);
  for (const u of meta.units ?? []) u.chapterIds = u.chapterIds.filter((id) => id !== chapterId);
  writeMeta(meta);
  return list();
}

export function deleteChapter(projectId: string, chapterId: string): NovelProject[] {
  const meta = readMeta(projectId);
  const idx = meta.chapters.findIndex((c) => c.id === chapterId);
  if (idx < 0) throw new Error("章节不存在");
  const [chapter] = meta.chapters.splice(idx, 1);
  fs.rmSync(path.join(projectDirOf(projectId), "chapters", chapter.file), { force: true });
  writeMeta(meta);
  return list();
}

function findChapter(meta: MetaFile, chapterId: string): ChapterMeta {
  const chapter = meta.chapters.find((c) => c.id === chapterId);
  if (!chapter) throw new Error("章节不存在");
  return chapter;
}

export function readChapter(projectId: string, chapterId: string): string {
  const meta = readMeta(projectId);
  const chapter = findChapter(meta, chapterId);
  const filePath = path.join(projectDirOf(projectId), "chapters", chapter.file);
  if (!fs.existsSync(filePath)) return "";
  return fs.readFileSync(filePath, "utf-8");
}

export function writeChapter(projectId: string, chapterId: string, content: string): void {
  const meta = readMeta(projectId);
  const chapter = findChapter(meta, chapterId);
  const filePath = path.join(projectDirOf(projectId), "chapters", chapter.file);
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, "utf-8");
  fs.renameSync(tmp, filePath);
  chapter.words = countWords(content);
  chapter.updatedAt = Date.now();
  writeMeta(meta);
}

// ---- 单元（故事单元 / 卷）----

export function createUnit(projectId: string, title: string): NovelProject[] {
  const meta = readMeta(projectId);
  const units = meta.units ?? [];
  units.push({
    id: newId(),
    title: title.trim() || `第 ${units.length + 1} 单元`,
    chapterIds: []
  });
  meta.units = units;
  writeMeta(meta);
  return list();
}

export function renameUnit(projectId: string, unitId: string, title: string): NovelProject[] {
  const meta = readMeta(projectId);
  const unit = meta.units?.find((u) => u.id === unitId);
  if (!unit) throw new Error("单元不存在");
  unit.title = title.trim() || unit.title;
  writeMeta(meta);
  return list();
}

export function renameChapter(projectId: string, chapterId: string, title: string): NovelProject[] {
  const meta = readMeta(projectId);
  const chapter = findChapter(meta, chapterId);
  chapter.title = title.trim() || chapter.title;
  chapter.updatedAt = Date.now();
  writeMeta(meta);
  return list();
}

// 删除单元：组内章节落到「单元外」，不删章节本身
export function deleteUnit(projectId: string, unitId: string): NovelProject[] {
  const meta = readMeta(projectId);
  meta.units = (meta.units ?? []).filter((u) => u.id !== unitId);
  writeMeta(meta);
  return list();
}

export function setChapterUnit(projectId: string, chapterId: string, unitId: string): NovelProject[] {
  const meta = readMeta(projectId);
  findChapter(meta, chapterId);
  const units = meta.units ?? [];
  const target = units.find((u) => u.id === unitId);
  if (!target) throw new Error("单元不存在");
  for (const u of units) u.chapterIds = u.chapterIds.filter((id) => id !== chapterId);
  target.chapterIds.push(chapterId);
  writeMeta(meta);
  return list();
}
