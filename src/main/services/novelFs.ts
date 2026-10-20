import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChapterMeta, NovelProject } from "../../shared/types.js";
import { newId, readSettings } from "./store.js";

function novelDir(): string {
  const settings = readSettings();
  const dir = settings.novelDir || path.join(os.homedir(), "Documents", "SlothStories");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
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
}

function metaPath(projectId: string): string {
  return path.join(novelDir(), projectId, "meta.json");
}

function readMeta(projectId: string): MetaFile {
  const raw = fs.readFileSync(metaPath(projectId), "utf-8");
  return JSON.parse(raw) as MetaFile;
}

function writeMeta(meta: MetaFile): void {
  meta.updatedAt = Date.now();
  fs.writeFileSync(metaPath(meta.id), JSON.stringify(meta, null, 2), "utf-8");
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
      out.push({ ...meta, id: entry.name });
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
    chapters: []
  };
  fs.writeFileSync(metaPath(dirName), JSON.stringify(meta, null, 2), "utf-8");
  return list();
}

export function rename(id: string, title: string): NovelProject[] {
  const meta = readMeta(id);
  meta.title = title.trim() || meta.title;
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
  meta.chapters.push({
    id: newId(),
    title: title.trim() || `第 ${meta.chapters.length + 1} 章`,
    file,
    words: 0,
    updatedAt: now
  });
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
