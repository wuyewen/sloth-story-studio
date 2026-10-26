import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { MemoryProposal, ProposalInput } from "../../shared/types.js";
import { newId } from "./store.js";
import { memoryRead, memoryWrite, initMemory, novelDirPath } from "./novelFs.js";

function projectRoot(projectId: string): string {
  initMemory(projectId);
  return path.join(novelDirPath(), projectId);
}

function proposalsDir(projectId: string, kind: "pending" | "applied"): string {
  const dir = path.join(projectRoot(projectId), "memory-proposals", kind);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function hash(content: string): string {
  return crypto.createHash("sha256").update(content, "utf-8").digest("hex");
}

function proposalPath(projectId: string, kind: "pending" | "applied", id: string): string {
  return path.join(proposalsDir(projectId, kind), `${id}.json`);
}

function readProposal(file: string): MemoryProposal | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as MemoryProposal;
  } catch {
    return null;
  }
}

function writeProposal(file: string, p: MemoryProposal): void {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(p, null, 2), "utf-8");
  fs.renameSync(tmp, file);
}

export function list(projectId: string): MemoryProposal[] {
  const dir = proposalsDir(projectId, "pending");
  const out: MemoryProposal[] = [];
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith(".json")) continue;
    const p = readProposal(path.join(dir, entry));
    if (p) out.push(p);
  }
  out.sort((a, b) => b.createdAt - a.createdAt);
  return out;
}

export function create(projectId: string, input: ProposalInput): MemoryProposal[] {
  initMemory(projectId);
  const before = memoryRead(projectId, input.targetFile);
  const proposal: MemoryProposal = {
    id: newId(),
    projectId,
    targetFile: input.targetFile,
    status: "pending",
    summary: input.summary,
    reason: input.reason,
    sourceChapterIds: input.sourceChapterIds ?? [],
    beforeContent: before,
    proposedContent: input.proposedContent,
    createdAt: Date.now(),
    baseRevision: hash(before)
  };
  writeProposal(proposalPath(projectId, "pending", proposal.id), proposal);
  return list(projectId);
}

function findPending(projectId: string, id: string): { p: MemoryProposal; file: string } {
  const file = proposalPath(projectId, "pending", id);
  const p = readProposal(file);
  if (!p) throw new Error("提案不存在或已处理");
  return { p, file };
}

export function reject(projectId: string, id: string): MemoryProposal[] {
  const { p, file } = findPending(projectId, id);
  p.status = "rejected";
  writeProposal(file, p);
  return list(projectId);
}

// 接受提案：冲突检测（baseRevision 与当前文件摘要不一致且未强制 → 标记 conflict，不覆盖）
export function accept(
  projectId: string,
  id: string,
  force = false
): { proposals: MemoryProposal[]; conflict: boolean } {
  const { p, file } = findPending(projectId, id);
  const current = memoryRead(projectId, p.targetFile);
  if (hash(current) !== p.baseRevision && !force) {
    p.status = "conflict";
    writeProposal(file, p);
    return { proposals: list(projectId), conflict: true };
  }
  memoryWrite(projectId, p.targetFile, p.proposedContent);
  p.status = "applied";
  p.appliedAt = Date.now();
  writeProposal(proposalPath(projectId, "applied", p.id), p);
  fs.rmSync(file, { force: true });
  return { proposals: list(projectId), conflict: false };
}

// 冲突后取最新现场内容（用于展示「当前内容 vs 提案内容」）
export function currentOf(projectId: string, id: string): string {
  const { p } = findPending(projectId, id);
  return memoryRead(projectId, p.targetFile);
}
