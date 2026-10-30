import { useEffect, useMemo, useRef, useState } from "react";
import {
  BookMarked, FolderTree, Layers, PenLine, Library, Loader2, Play, Square, ChevronRight, Plus,
  CheckCircle2, XCircle, History, Wand2, Lock, Unlock, Trash2, Pencil, ScanSearch
} from "lucide-react";
import { sloth } from "../../api";
import { useStudio } from "../../state/store";
import { useFocusRefresh } from "../hooks/useFocusRefresh";
import { Modal, ConfirmDialog } from "../components/Modal";
import type { MemoryFileInfo, MemoryProposal, MemoryVersion, NodeRunRecord, StateEntity, StateEntityType, StateExtractItem, WorkflowRunEvent, WorkflowRunRecord } from "../../../shared/types";
import CustomFlowModal from "./workbench/CustomFlowModal";
import SimpleMode from "./workbench/SimpleMode";

const STATE_TYPE_LABEL: Record<StateEntityType, string> = {
  character: "角色",
  foreshadowing: "伏笔",
  event: "事件",
  item: "物品",
  rule: "规则",
  location: "地点"
};

const STATE_TYPE_ORDER: StateEntityType[] = ["character", "foreshadowing", "event", "item", "rule", "location"];

// 运行详情里的「节点执行时间线」：按执行顺序列出 agent/prompt 节点，可展开查看输入与完整输出
function NodeRunsTimeline({ nodeRuns, usage }: { nodeRuns: NodeRunRecord[]; usage?: WorkflowRunRecord["usage"] }) {
  const [open, setOpen] = useState<Set<number>>(new Set());
  const toggle = (i: number) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  const totalMs = nodeRuns.reduce((sum, n) => sum + n.durationMs, 0);
  return (
    <div className="form-row">
      <span className="form-label">节点执行时间线（{nodeRuns.length} 个节点）</span>
      <div className="nr-summary">
        <span>LLM 调用 {usage ? usage.calls : nodeRuns.filter((n) => n.status === "succeeded").length} 次</span>
        <span>
          总 tokens {usage ? usage.totalTokens : "-"}
          {usage?.unknown && "（部分模型未返回用量）"}
        </span>
        <span>总耗时 {(totalMs / 1000).toFixed(1)} 秒</span>
      </div>
      <div className="nr-list">
        {nodeRuns.map((nr, i) => (
          <div key={`${nr.nodeId}-${nr.attempt}-${i}`} className={`nr-item ${nr.status === "failed" ? "is-failed" : ""}`}>
            <button className="nr-head" onClick={() => toggle(i)}>
              <span className="nr-idx">{i + 1}</span>
              {nr.status === "succeeded" ? (
                <CheckCircle2 size={13} className="run-ok" />
              ) : (
                <XCircle size={13} className="run-fail" />
              )}
              <strong>
                {nr.label}
                {nr.attempt > 1 && `（第${nr.attempt}次）`}
              </strong>
              <small>{(nr.durationMs / 1000).toFixed(1)}s</small>
              <small>{nr.usage?.totalTokens != null ? `${nr.usage.totalTokens} tok` : "-"}</small>
              {nr.model && <small className="nr-model">{nr.model}</small>}
            </button>
            {open.has(i) && (
              <div className="nr-detail">
                {nr.contextRefs && nr.contextRefs.length > 0 && (
                  <div className="nr-ctx-refs">
                    {nr.contextRefs.map((r, ri) => (
                      <span key={ri} className={`nr-ctx-ref ${r.chars === 0 ? "is-skipped" : ""}`}>
                        {r.source}{r.chars > 0 ? ` ${r.chars}字` : ""}
                      </span>
                    ))}
                  </div>
                )}
                <span className="form-label">输入（共 {nr.inputChars} 字符，以下为前 500 字）</span>
                <pre className="prop-diff-text nr-text">{nr.inputPreview || "（空）"}</pre>
                {nr.error ? (
                  <p className="inline-msg err">{nr.error}</p>
                ) : (
                  nr.output !== undefined && (
                    <>
                      <span className="form-label">输出</span>
                      <pre className="prop-diff-text nr-text">{nr.output || "（空）"}</pre>
                    </>
                  )
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

interface TimelineItem {
  key: number;
  label: string;
  status: "running" | "done" | "error";
  preview?: string;
  output?: string; // 节点完整输出
  error?: string;
}

const PREFIX_TO_SLOT: Record<string, "planning" | "unit" | "chapter" | "review"> = {
  WF01: "planning",
  WF02: "unit",
  WF03: "chapter",
  WF04: "review"
};

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="ghost-button small"
      onClick={() => {
        void navigator.clipboard.writeText(text);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? "已复制 ✓" : "一键复制"}
    </button>
  );
}

function findWorkflow(workflows: { id: string; name: string }[], prefix: string) {
  return workflows.find((w) => w.name.startsWith(prefix)) ?? null;
}

const MEMORY_NAMES: Record<string, string> = {
  "story-bible.md": "全书核心设定",
  "system-design.md": "系统设计",
  "world-bible.md": "世界观设定",
  "master-outline.md": "全书大纲",
  "style-guide.md": "风格规范",
  "character-state.md": "角色状态",
  "foreshadowing-tracker.md": "伏笔追踪表",
  "material-library.md": "素材库"
};

function memoryLabel(rel: string): string {
  if (MEMORY_NAMES[rel]) return MEMORY_NAMES[rel];
  if (rel.startsWith("unit-summaries/")) return `单元摘要 · ${rel.slice("unit-summaries/".length).replace(/\.md$/, "")}`;
  if (rel.startsWith("handoffs/")) return `交接 · ${rel.slice("handoffs/".length).replace(/\.md$/, "")}`;
  return rel;
}

export default function WorkbenchPage() {
  const projects = useStudio((s) => s.projects);
  const workflows = useStudio((s) => s.workflows);
  const currentProjectId = useStudio((s) => s.currentProjectId);
  const setCurrentProject = useStudio((s) => s.setCurrentProject);
  const workbenchMemoryOpen = useStudio((s) => s.workbenchMemoryOpen);
  const setWorkbenchMemoryOpen = useStudio((s) => s.setWorkbenchMemoryOpen);

  const [projectId, setProjectId] = useState("");
  const project = useMemo(
    () => projects.find((p) => p.id === (projectId || currentProjectId)) ?? projects[0] ?? null,
    [projects, projectId, currentProjectId]
  );
  const [unitId, setUnitId] = useState("");
  const unit = useMemo(
    () => project?.units.find((u) => u.id === unitId) ?? project?.units[project.units.length - 1] ?? null,
    [project, unitId]
  );

  const unitChapters = useMemo(() => {
    if (!project || !unit) return [];
    return unit.chapterIds
      .map((id) => project.chapters.find((c) => c.id === id))
      .filter((c): c is NonNullable<typeof c> => Boolean(c));
  }, [project, unit]);
  const doneChapters = unitChapters.filter((c) => c.words > 0).length;
  const progress = unitChapters.length > 0 ? Math.round((doneChapters / unitChapters.length) * 100) : 0;

  // ---- 工作流运行 ----
  const [runWf, setRunWf] = useState<{ id: string; name: string } | null>(null);
  const [runMinimized, setRunMinimized] = useState(false);
  const [runInput, setRunInput] = useState("");
  const [running, setRunning] = useState(false);
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [finalOutput, setFinalOutput] = useState("");
  const [runError, setRunError] = useState("");
  const [propMsg, setPropMsg] = useState<{ text: string; kind: "ok" | "err" } | null>(null);
  const [chapterMsg, setChapterMsg] = useState("");
  const [customOpen, setCustomOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const refreshProjects = useStudio((s) => s.refreshProjects);

  // 把工作流输出存入当前单元的新章节
  async function saveAsChapter(text: string): Promise<{ id: string; title: string } | null> {
    if (!sloth || !project || !text.trim()) return null;
    const firstLine = text.split(/\r?\n/).find((l) => l.trim())?.trim() ?? "";
    const title = firstLine.replace(/^#+\s*/, "").slice(0, 12) || `第 ${unitChapters.length + 1} 章`;
    const list = await sloth.novels.createChapter(project.id, title);
    const updated = list.find((p) => p.id === project.id);
    const created = updated?.chapters[updated.chapters.length - 1];
    if (created) {
      await sloth.novels.writeChapter(project.id, created.id, text, "workflow");
      if (unit) await sloth.novels.setChapterUnit(project.id, created.id, unit.id);
    }
    await refreshProjects();
    return created ? { id: created.id, title: created.title } : null;
  }

  function toggleExpand(key: number) {
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }
  const runIdRef = useRef<string | null>(null);
  const seq = useRef(0);
  const cleanups = useRef<(() => void)[]>([]);

  // 入口守卫：明显的误操作给提示（可继续），完全无意义的操作直接拦下
  const [runGuard, setRunGuard] = useState<{ title: string; message: string; block?: boolean; altText?: string; onAlt?: () => void; onOk?: () => void } | null>(null);

  function openRun(prefix: string) {
    if (!project) return;
    const unitCount = project.units.length;
    const curChapters = unit?.chapterIds.length ?? 0;

    if (prefix === "WF03") {
      if (unitCount === 0) {
        setRunGuard({ title: "创作章节", message: "还没有故事单元。请先用「规划新单元」创建单元，再创作章节。", block: true });
        return;
      }
      // 记忆新鲜度检查：最新章节保存时间晚于状态库最后更新 → 提醒先提取章节记忆
      void sloth?.novels.stateList(project.id).then((entities) => {
        const lastChapterAt = Math.max(0, ...project.chapters.map((c) => c.updatedAt ?? 0));
        const lastStateAt = Math.max(0, ...entities.map((e) => e.updatedAt ?? 0));
        if (lastChapterAt > 0 && lastChapterAt > lastStateAt) {
          setRunGuard({
            title: "创作章节",
            message: "最近的章节还没提取记忆，角色/伏笔状态可能已过时，直接写新章容易前后不一致。建议先「提取章节记忆」。",
            altText: "去提取",
            onAlt: () => openExtract(),
            onOk: () => doOpenRun(prefix)
          });
        } else {
          doOpenRun(prefix);
        }
      });
      return;
    }
    if (prefix === "WF04" && curChapters === 0) {
      setRunGuard({ title: "单元复盘", message: `当前单元「${unit?.title ?? "未选择"}」还没有章节，暂无可复盘内容。`, block: true });
      return;
    }
    if (prefix === "WF02" && unitCount > 0 && curChapters > 0) {
      // 复盘新鲜度检查：当前单元有章节但「单元复盘」没跑过（或复盘后又有新章节）→ 引导先复盘
      void sloth?.novels.memoryList(project.id).then((files) => {
        const unitChapterIds = new Set(unit?.chapterIds ?? []);
        const lastChapterAt = Math.max(0, ...project.chapters.filter((c) => unitChapterIds.has(c.id)).map((c) => c.updatedAt ?? 0));
        const summary = files.find((f) => f.rel === "unit-summaries/latest.md");
        const summaryAt = summary?.updatedAt ?? 0;
        if (summaryAt >= lastChapterAt) {
          doOpenRun(prefix); // 复盘已覆盖最新章节，直接打开
          return;
        }
        setRunGuard({
          title: "规划新单元",
          message: summary
            ? `当前单元「${unit?.title}」在上次复盘后又写了新章节。建议先重新运行「单元复盘」更新归档，再开启新单元。`
            : `当前单元「${unit?.title}」已有 ${curChapters} 章，但还没做过「单元复盘」。建议先复盘归档（产出单元摘要与交接），再开启新单元。`,
          altText: "去复盘",
          onAlt: () => doOpenRun("WF04"),
          onOk: () => doOpenRun(prefix)
        });
      });
      return;
    }
    if (prefix === "WF01") {
      void sloth?.novels.memoryList(project.id).then((files) => {
        if (files.some((f) => f.rel === "master-outline.md")) {
          setRunGuard({
            title: "全书规划",
            message: "已存在全书大纲。再次运行会生成新的规划提案——不会直接覆盖现有记忆，需你在提案区审核接受。继续运行吗？",
            onOk: () => doOpenRun(prefix)
          });
        } else {
          doOpenRun(prefix);
        }
      });
      return;
    }
    doOpenRun(prefix);
  }

  function doOpenRun(prefix: string) {
    const slot = PREFIX_TO_SLOT[prefix];
    const slotWfId = slot ? project?.workflowSlots?.[slot] : undefined;
    const wf = (slotWfId ? workflows.find((w) => w.id === slotWfId) : null) ?? findWorkflow(workflows, prefix);
    if (!wf) return;
    setRunWf(wf);
    setRunMinimized(false);
    setRunInput("");
    setTimeline([]);
    setFinalOutput("");
    setRunError("");
    setPropMsg(null);
    setChapterMsg("");
    setChainCount(1);
    setChainTotal(0);
    setChainIdx(0);
    setChainLog([]);
    setChainSummary(null);
    chainStopRef.current = false;
  }

  // 可 await 的单章/单次执行：运行 + 事件订阅 + 清理，resolve 运行结果
  function runOnce(
    wf: { id: string; name: string },
    inputText: string,
    resumeFromRunId?: string
  ): Promise<{ finalOutput?: string; error?: string; proposalsCreated?: number }> {
    return new Promise((resolve) => {
      if (!sloth || !project) {
        resolve({ error: "应用未就绪" });
        return;
      }
      const runId = crypto.randomUUID();
      runIdRef.current = runId;
      setTimeline([]);
      setFinalOutput("");
      setRunError("");
      setRunning(true);
      const off = sloth.workflows.onEvent((ev: WorkflowRunEvent) => {
        if (ev.runId !== runId) return;
        if (ev.type === "node-start") {
          seq.current += 1;
          setTimeline((t) => [...t, { key: seq.current, label: ev.label ?? "节点", status: "running" }]);
        } else if (ev.type === "node-done" || ev.type === "node-error") {
          setTimeline((t) => {
            const next = [...t];
            for (let i = next.length - 1; i >= 0; i--) {
              if (next[i].status === "running") {
                next[i] = {
                  ...next[i],
                  status: ev.type === "node-done" ? "done" : "error",
                  preview: ev.outputPreview,
                  output: ev.output,
                  error: ev.error
                };
                break;
              }
            }
            return next;
          });
        } else if (ev.type === "run-done") {
          setFinalOutput(ev.finalOutput ?? "");
        } else if (ev.type === "run-error") {
          setRunError(ev.error ?? "运行失败");
        }
      });
      cleanups.current.push(off);
      sloth.workflows
        .run(runId, wf.id, inputText, project.id, resumeFromRunId)
        .then((res) =>
          resolve({
            finalOutput: res?.finalOutput,
            error: res?.error,
            proposalsCreated: res?.proposalsCreated
          })
        )
        .catch((e) => resolve({ error: String(e) }))
        .finally(() => off());
    });
  }

  // 单次运行（含章节槽位自动存章节、提案提示、刷新）
  async function singleRun(wf: { id: string; name: string }, inputText: string, resumeFromRunId?: string) {
    if (!project) return;
    const res = await runOnce(wf, inputText, resumeFromRunId);
    if (res.error) setRunError(res.error);
    if (res.finalOutput) setFinalOutput(res.finalOutput);
    if (res.proposalsCreated) setPropMsg({ kind: "ok", text: `已自动创建 ${res.proposalsCreated} 条记忆提案，请到「待审核的记忆提案」查看并确认。` });
    // 「章节创作」槽位的工作流：终稿自动存入当前单元的新章节
    const isChapterWf = project.workflowSlots?.chapter === wf.id || wf.name.includes("章节创作");
    if (res.finalOutput && isChapterWf) {
      const created = await saveAsChapter(res.finalOutput);
      if (created) setChapterMsg(`已自动存入新章节《${created.title}》（当前单元）`);
    }
    setRunning(false);
    void refreshRuns();
    void refreshProposals();
  }

  // ---- 连写 N 章（仅章节创作槽位）----
  const [chainCount, setChainCount] = useState(1);
  const [chainTotal, setChainTotal] = useState(0); // >0 表示本次是连写运行
  const [chainIdx, setChainIdx] = useState(0);
  const [chainLog, setChainLog] = useState<{ kind: "ok" | "err" | "warn"; text: string }[]>([]);
  const [chainSummary, setChainSummary] = useState<{ text: string; conflicts: { type: string; name: string }[] } | null>(null);
  const chainStopRef = useRef(false);

  async function runChain(wf: { id: string; name: string }, total: number) {
    if (!project) return;
    chainStopRef.current = false;
    setChainTotal(total);
    setChainIdx(0);
    setChainLog([]);
    setChainSummary(null);
    setPropMsg(null);
    setChapterMsg("");
    const baseInput = runInput.trim();
    let saved = 0;
    let memApplied = 0;
    const conflicts: { type: string; name: string }[] = [];

    for (let i = 1; i <= total; i++) {
      if (chainStopRef.current) break; // 用户点过停止：在章节边界干净退出
      setChainIdx(i);
      const inputText =
        baseInput + (i > 1 ? `\n\n（本次为连写第 ${i} 章，共 ${total} 章；承接上一章结尾继续推进故事。）` : "");
      const res = await runOnce(wf, inputText);
      if (res.error || !res.finalOutput) {
        const msg = `第 ${i} 章失败：${res.error ?? "无输出"}${saved > 0 ? `，已完成的 ${saved} 章已保存` : ""}`;
        setChainLog((l) => [...l, { kind: "err", text: msg }]);
        break;
      }
      const created = await saveAsChapter(res.finalOutput);
      if (created) saved++;
      // 自动提取记忆：new/update 直接落库，conflict 记入待裁决列表；提取失败不中断连写
      if (created) {
        try {
          const ex = await sloth!.novels.extractChapterState(project.id, {
            unitId: unit?.id,
            chapterId: created.id
          });
          let memCount = 0;
          for (const it of ex.items) {
            if (it.relation === "conflict") {
              conflicts.push({ type: it.entity.type, name: it.entity.name });
              continue;
            }
            await sloth!.novels.stateUpsert(project.id, {
              type: it.entity.type,
              name: it.entity.name,
              data: it.entity.data,
              status: it.entity.status,
              ...(it.entity.source ? { source: it.entity.source } : {})
            });
            memCount++;
          }
          memApplied += memCount;
          setChainLog((l) => [
            ...l,
            { kind: "ok", text: `第 ${i} 章 ✓ 已保存《${created.title}》${memCount > 0 ? ` · 记忆 +${memCount} 条` : ""}` }
          ]);
        } catch (err) {
          setChainLog((l) => [
            ...l,
            {
              kind: "warn",
              text: `第 ${i} 章已保存《${created.title}》，但记忆提取失败：${err instanceof Error ? err.message : String(err)}（不中断连写）`
            }
          ]);
        }
      } else {
        setChainLog((l) => [...l, { kind: "warn", text: `第 ${i} 章运行成功但存章节失败` }]);
      }
    }

    setRunning(false);
    setChainSummary({
      text: `连写结束：已保存 ${saved}/${total} 章；记忆自动更新 ${memApplied} 条${conflicts.length > 0 ? `；${conflicts.length} 条冲突待裁决` : ""}`,
      conflicts
    });
    await refreshState();
    void refreshProjects();
    void refreshRuns();
    void refreshProposals();
  }

  function startRun() {
    if (!runWf || !project) return;
    const isChapterWf = project.workflowSlots?.chapter === runWf.id || runWf.name.includes("章节创作");
    if (isChapterWf && chainCount > 1) {
      void runChain(runWf, Math.min(10, Math.max(1, chainCount)));
      return;
    }
    void singleRun(runWf, runInput.trim());
  }

  // 断点续跑：以同一工作流 + 原输入 + resumeFromRunId 发起新运行，已成功的节点复用上次输出（不走连写）
  function resumeRun(rec: WorkflowRunRecord) {
    const wf = workflows.find((w) => w.id === rec.workflowId);
    if (!wf || !project) return;
    const inputText = (rec.input ?? "").trim();
    setRunDetail(null);
    setRunWf({ id: wf.id, name: wf.name });
    setRunMinimized(false);
    setRunInput(rec.input ?? "");
    setPropMsg(null);
    setChapterMsg("");
    setChainCount(1);
    void singleRun({ id: wf.id, name: wf.name }, inputText, rec.runId);
  }

  function stopRun() {
    chainStopRef.current = true; // 连写时让循环在当前章结束后中断
    if (sloth && runIdRef.current) void sloth.workflows.stop(runIdRef.current);
  }

  // ---- 记忆提案 ----
  const [proposals, setProposals] = useState<MemoryProposal[]>([]);
  const [selected, setSelected] = useState<MemoryProposal | null>(null);
  const [conflictCurrent, setConflictCurrent] = useState("");
  const [newOpen, setNewOpen] = useState(false);
  const [npTarget, setNpTarget] = useState("");
  const [npSummary, setNpSummary] = useState("");
  const [npReason, setNpReason] = useState("");
  const [npContent, setNpContent] = useState("");

  // ---- 运行历史 ----
  const [runs, setRuns] = useState<WorkflowRunRecord[]>([]);
  const [runDetail, setRunDetail] = useState<WorkflowRunRecord | null>(null);

  async function refreshRuns() {
    if (sloth && project) setRuns(await sloth.novels.runHistory(project.id));
  }

  useFocusRefresh(() => {
    if (!sloth || !project) {
      setProposals([]);
      setRuns([]);
      return;
    }
    void sloth.proposals.list(project.id).then(setProposals);
    void sloth.novels.runHistory(project.id).then(setRuns);
  }, [project?.id]);

  async function refreshProposals() {
    if (sloth && project) setProposals(await sloth.proposals.list(project.id));
  }

  async function openProposal(p: MemoryProposal) {
    setSelected(p);
    setConflictCurrent("");
    if (p.status === "conflict" && sloth && project) {
      setConflictCurrent(await sloth.proposals.currentOf(project.id, p.id));
    }
  }

  async function acceptProposal(force = false) {
    if (!sloth || !project || !selected) return;
    const res = await sloth.proposals.accept(project.id, selected.id, force);
    setProposals(res.proposals);
    if (res.conflict) {
      setConflictCurrent(await sloth.proposals.currentOf(project.id, selected.id));
      setSelected((s) => (s ? { ...s, status: "conflict" } : s));
    } else {
      setSelected(null);
    }
  }

  async function rejectProposal() {
    if (!sloth || !project || !selected) return;
    setProposals(await sloth.proposals.reject(project.id, selected.id));
    setSelected(null);
  }

  async function createProposal() {
    if (!sloth || !project || !npTarget || !npSummary.trim() || !npContent.trim()) return;
    await sloth.proposals.create(project.id, {
      targetFile: npTarget,
      summary: npSummary.trim(),
      reason: npReason.trim(),
      proposedContent: npContent
    });
    await refreshProposals();
    setNewOpen(false);
    setNpTarget("");
    setNpSummary("");
    setNpReason("");
    setNpContent("");
  }

  const pendingProposals = proposals.filter((p) => p.status === "pending" || p.status === "conflict");

  // ---- 模式切换：专业模式 / 极简创作 ----
  const [wbMode, setWbMode] = useState<"pro" | "simple">("pro");

  // ---- 记忆管理 ----
  const [memOpen, setMemOpen] = useState(false);
  const [memFiles, setMemFiles] = useState<MemoryFileInfo[]>([]);
  const [memRel, setMemRel] = useState("");
  const [memContent, setMemContent] = useState("");
  const [memDirty, setMemDirty] = useState(false);
  const [memMsg, setMemMsg] = useState("");
  const [memVersions, setMemVersions] = useState<MemoryVersion[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyPreview, setHistoryPreview] = useState<{ ts: number; content: string } | null>(null);
  const [memDeleting, setMemDeleting] = useState(false);

  // ---- 结构化状态库（FR-03）----
  const [memTab, setMemTab] = useState<"files" | "state">("files");
  const [stateEntities, setStateEntities] = useState<StateEntity[]>([]);
  const [stateEdit, setStateEdit] = useState<{ id?: string; type: StateEntityType; name: string; data: string } | null>(null);
  const [stateDeleting, setStateDeleting] = useState<StateEntity | null>(null);
  const [stateErr, setStateErr] = useState(""); // 状态库写操作失败提示（F-04：保存失败不再静默）
  const [stateEditErr, setStateEditErr] = useState("");

  async function refreshState() {
    if (sloth && project) setStateEntities(await sloth.novels.stateList(project.id));
  }

  async function saveStateEntity() {
    if (!sloth || !project || !stateEdit || !stateEdit.name.trim()) return;
    setStateEditErr("");
    try {
      await sloth.novels.stateUpsert(project.id, {
        ...(stateEdit.id ? { id: stateEdit.id } : {}),
        type: stateEdit.type,
        name: stateEdit.name.trim(),
        data: stateEdit.data,
        status: "confirmed", // 作者手动维护的实体视为已确认
        clearConflict: true
      });
      setStateEdit(null);
      await refreshState();
    } catch (err) {
      setStateEditErr(err instanceof Error ? err.message : String(err));
    }
  }

  async function toggleStateLock(e: StateEntity) {
    if (!sloth || !project) return;
    try {
      await sloth.novels.stateSetLock(project.id, e.id, !e.locked);
      await refreshState();
    } catch (err) {
      setStateErr(err instanceof Error ? err.message : String(err));
    }
  }

  async function deleteStateEntity() {
    if (!sloth || !project || !stateDeleting) return;
    try {
      await sloth.novels.stateRemove(project.id, stateDeleting.id);
      setStateDeleting(null);
      await refreshState();
    } catch (err) {
      setStateErr(err instanceof Error ? err.message : String(err));
    }
  }

  // ---- 章节记忆提取（FR-04，多选批量）----
  const [extractOpen, setExtractOpen] = useState(false);
  const [extractUnitId, setExtractUnitId] = useState("");
  const [extractChapterIds, setExtractChapterIds] = useState<Set<string>>(new Set());
  const [extractLatestStateAt, setExtractLatestStateAt] = useState(0); // 状态库最新实体时间，用于默认勾选"提取后有更新"的章节
  const [extracting, setExtracting] = useState(false);
  const [extractProgress, setExtractProgress] = useState<{ i: number; n: number; title: string } | null>(null);
  const [extractError, setExtractError] = useState("");
  interface ReviewRow {
    chapterTitle: string;
    item: StateExtractItem;
  }
  const [extractReview, setExtractReview] = useState<{ chapters: number; items: ReviewRow[]; failures: { title: string; error: string }[] } | null>(null);
  const [extractChecked, setExtractChecked] = useState<Set<number>>(new Set());
  const [extractApplying, setExtractApplying] = useState(false);
  const [extractMsg, setExtractMsg] = useState("");

  // 默认勾选：updatedAt 晚于状态库最新实体的章节（"提取后有更新"）；全部已提取过则只勾最后一章
  function defaultCheckedFor(unitId: string, latestStateAt: number): Set<string> {
    if (!project) return new Set();
    const u = project.units.find((x) => x.id === unitId);
    const ids = (u?.chapterIds ?? []).filter((id) => project.chapters.some((c) => c.id === id));
    const updatedAfter = ids.filter((id) => {
      const c = project.chapters.find((x) => x.id === id);
      return c && c.words > 0 && c.updatedAt > latestStateAt;
    });
    return new Set(updatedAfter.length > 0 ? updatedAfter : ids.slice(-1));
  }

  async function openExtract() {
    if (!project || !sloth) return;
    const u = unit ?? project.units[project.units.length - 1] ?? null;
    const uid = u?.id ?? "";
    setExtractUnitId(uid);
    setExtractError("");
    setExtractMsg("");
    setExtractProgress(null);
    const entities = await sloth.novels.stateList(project.id);
    setStateEntities(entities);
    const latest = entities.reduce((m, e) => Math.max(m, e.updatedAt), 0);
    setExtractLatestStateAt(latest);
    setExtractChapterIds(defaultCheckedFor(uid, latest));
    setExtractOpen(true);
  }

  const extractChapters = useMemo(() => {
    if (!project) return [];
    const u = project.units.find((x) => x.id === extractUnitId);
    return (u?.chapterIds ?? [])
      .map((id) => project.chapters.find((c) => c.id === id))
      .filter((c): c is NonNullable<typeof c> => Boolean(c));
  }, [project, extractUnitId]);

  function toggleExtractChapter(id: string) {
    setExtractChapterIds((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // 批量提取：按章节顺序串行，单章失败不中断
  async function runExtract() {
    if (!sloth || !project) return;
    const targets = extractChapters.filter((c) => extractChapterIds.has(c.id));
    if (targets.length === 0) return;
    setExtracting(true);
    setExtractError("");
    const agg: ReviewRow[] = [];
    const failures: { title: string; error: string }[] = [];
    for (const [i, c] of targets.entries()) {
      setExtractProgress({ i: i + 1, n: targets.length, title: c.title });
      try {
        const res = await sloth.novels.extractChapterState(project.id, {
          unitId: extractUnitId || undefined,
          chapterId: c.id
        });
        for (const it of res.items) agg.push({ chapterTitle: res.chapterTitle, item: it });
      } catch (err) {
        failures.push({ title: c.title, error: err instanceof Error ? err.message : String(err) });
      }
    }
    setExtractProgress(null);
    setExtracting(false);
    if (agg.length === 0 && failures.length > 0) {
      setExtractError(`全部提取失败（${failures.length} 章）：${failures[0].error}`);
      return;
    }
    setExtractReview({ chapters: targets.length, items: agg, failures });
    // 新增和更新默认勾选，冲突项默认不勾选
    setExtractChecked(new Set(agg.map((x, i) => (x.item.relation === "conflict" ? -1 : i)).filter((i) => i >= 0)));
    setExtractOpen(false);
  }

  async function applyExtract() {
    if (!sloth || !project || !extractReview) return;
    setExtractApplying(true);
    setExtractError("");
    try {
      for (const [i, row] of extractReview.items.entries()) {
        if (!extractChecked.has(i)) continue;
        const it = row.item;
        await sloth.novels.stateUpsert(project.id, {
          type: it.entity.type,
          name: it.entity.name,
          data: it.entity.data,
          status: it.entity.status,
          ...(it.entity.source ? { source: it.entity.source } : {}),
          // 冲突项用户勾选应用 = 强制覆盖，旧值由主进程记入 conflict 备注
          ...(it.relation === "conflict" ? { force: true } : {})
        });
      }
      setExtractReview(null);
      setExtractMsg(`已应用 ${extractChecked.size} 条状态到结构化状态库`);
      await refreshState();
    } catch (err) {
      setExtractError(`应用失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setExtractApplying(false);
    }
  }

  async function openMemory() {
    if (!sloth || !project) return;
    setMemFiles(await sloth.novels.memoryList(project.id));
    setMemRel("");
    setMemContent("");
    setMemDirty(false);
    setMemMsg("");
    setMemTab("files");
    setStateEntities(await sloth.novels.stateList(project.id));
    setMemOpen(true);
  }

  // 从侧边栏「记忆管理」进入时自动打开记忆弹窗
  useEffect(() => {
    if (workbenchMemoryOpen && project) {
      setWorkbenchMemoryOpen(false);
      void openMemory();
    }
  }, [workbenchMemoryOpen, project?.id]);

  async function pickMemory(rel: string) {
    if (!sloth || !project) return;
    setMemRel(rel);
    setMemContent(await sloth.novels.memoryRead(project.id, rel));
    setMemDirty(false);
    setMemMsg("");
  }

  async function saveMemory() {
    if (!sloth || !project || !memRel) return;
    await sloth.novels.memoryWrite(project.id, memRel, memContent);
    setMemDirty(false);
    setMemMsg("已保存");
    setMemFiles(await sloth.novels.memoryList(project.id));
  }

  async function openHistory() {
    if (!sloth || !project || !memRel) return;
    setMemVersions(await sloth.novels.memoryHistory(project.id, memRel));
    setHistoryPreview(null);
    setHistoryOpen(true);
  }

  async function previewVersion(ts: number) {
    if (!sloth || !project || !memRel) return;
    setHistoryPreview({ ts, content: await sloth.novels.memoryReadVersion(project.id, memRel, ts) });
  }

  async function restoreVersion(ts: number) {
    if (!sloth || !project || !memRel) return;
    await sloth.novels.memoryRestore(project.id, memRel, ts);
    setMemContent(await sloth.novels.memoryRead(project.id, memRel));
    setMemDirty(false);
    setHistoryOpen(false);
    setMemMsg("已恢复到所选版本");
    setMemFiles(await sloth.novels.memoryList(project.id));
  }

  async function deleteMemory() {
    if (!sloth || !project || !memRel) return;
    await sloth.novels.memoryDelete(project.id, memRel);
    setMemDeleting(false);
    setMemRel("");
    setMemContent("");
    setMemDirty(false);
    setMemFiles(await sloth.novels.memoryList(project.id));
  }

  const actions = [
    { icon: BookMarked, title: "全书规划", desc: "设定 · 主线 · 伏笔", prefix: "WF01" },
    { icon: Layers, title: "规划新单元", desc: "主角 · 背景 · 章节拆分", prefix: "WF02" },
    { icon: PenLine, title: "创作章节", desc: "写作 · 评审 · 返修", prefix: "WF03" },
    { icon: FolderTree, title: "单元复盘", desc: "归档 · 记忆更新 · 交接", prefix: "WF04" }
  ];

  function actionWorkflowName(prefix: string): string {
    const slot = PREFIX_TO_SLOT[prefix];
    const slotWfId = slot ? project?.workflowSlots?.[slot] : undefined;
    const custom = slotWfId ? workflows.find((w) => w.id === slotWfId) : null;
    if (custom) return custom.name;
    return `${prefix}（内置）`;
  }

  return (
    <div className="workbench">
      {!project && (
        <div className="empty-feature">
          <div className="feature-icon"><BookMarked size={27} /></div>
          <h1>还没有小说项目</h1>
          <p>先到「章节编辑器」里新建一个项目，再回来使用创作工作台。</p>
        </div>
      )}

      {project && (
        <>
          <div className="wb-mode-row">
            <div className="segmented">
              <button className={wbMode === "pro" ? "active" : ""} onClick={() => setWbMode("pro")}>专业模式</button>
              <button className={wbMode === "simple" ? "active" : ""} onClick={() => setWbMode("simple")}>极简创作</button>
            </div>
          </div>
          <div className="wb-head">
            <div className="wb-proj">
              <div className="wb-proj-row">
                <strong className="wb-proj-title">{project.title}</strong>
                <span className="wb-local-badge">本地项目</span>
              </div>
              <div className="wb-proj-stats">
                <span>{project.units.length} 个单元</span>
                <span>{project.chapters.length} 章</span>
                <span>{project.chapters.reduce((sum, c) => sum + (c.words ?? 0), 0).toLocaleString()} 字</span>
              </div>
              {project.synopsis && <p className="wb-synopsis">{project.synopsis}</p>}
            </div>
            <div className="wb-stat">
              <span className="form-label">当前故事单元</span>
              <select className="text-input" value={unit?.id ?? ""} onChange={(e) => setUnitId(e.target.value)}>
                {project.units.map((u) => (
                  <option key={u.id} value={u.id}>{u.title}</option>
                ))}
              </select>
              <button className="ghost-button small wb-extract-btn" onClick={openExtract} title="从章节正文提取角色/伏笔/事件等结构化状态">
                <ScanSearch size={13} /> 提取章节记忆
              </button>
              {extractMsg && <small className="wb-extract-msg">{extractMsg}</small>}
            </div>
            <div className="wb-stat">
              <span className="form-label">本单元进度</span>
              <div className="wb-progress">
                <div className="wb-progress-bar" style={{ width: `${progress}%` }} />
              </div>
              <small>{doneChapters}/{unitChapters.length} 章已有正文 · {progress}%</small>
            </div>
          </div>

          {wbMode === "simple" && (
            <SimpleMode project={project} workflows={workflows} refreshProjects={refreshProjects} />
          )}

          {wbMode === "pro" && (
          <>
          <div className="wb-actions">{actions.map((a) => (
              <button key={a.prefix} className="wb-action" onClick={() => openRun(a.prefix)}>
                <span className="wb-action-icon"><a.icon size={18} /></span>
                <strong>{a.title}</strong>
                <small>{a.desc}</small>
                <small className="wb-action-wf">{actionWorkflowName(a.prefix)}</small>
                <ChevronRight size={15} className="wb-action-arrow" />
              </button>
            ))}
            <button className="wb-action" onClick={() => void openMemory()}>
              <span className="wb-action-icon"><Library size={18} /></span>
              <strong>管理共享记忆</strong>
              <small>查看 · 编辑 · 审核变更</small>
              <ChevronRight size={15} className="wb-action-arrow" />
            </button>
            <button className="wb-action" onClick={() => setCustomOpen(true)}>
              <span className="wb-action-icon"><Wand2 size={18} /></span>
              <strong>自定义创作流水线</strong>
              <small>描述风格 · 自动生成 Agent + 工作流</small>
              <ChevronRight size={15} className="wb-action-arrow" />
            </button>
          </div>

          <div className="wb-panels">
            <section className="wb-panel">
              <div className="wb-panel-head">
                <h3>待审核的记忆提案</h3>
                <button
                  className="ghost-button small"
                  onClick={() => {
                    void (async () => {
                      if (sloth && project && memFiles.length === 0) {
                        setMemFiles(await sloth.novels.memoryList(project.id));
                      }
                      setNewOpen(true);
                    })();
                  }}
                >
                  <Plus size={13} /> 新建提案
                </button>
              </div>
              {pendingProposals.length === 0 && (
                <div className="wb-empty">暂无待审核提案。</div>
              )}
              {pendingProposals.length > 0 && (
                <div className="prop-list">
                  {pendingProposals.map((p) => (
                    <button key={p.id} className="prop-item" onClick={() => void openProposal(p)}>
                      <div className="prop-main">
                        <strong>{p.summary}</strong>
                        <small>{p.targetFile} · {new Date(p.createdAt).toLocaleString()}</small>
                      </div>
                      <span className={`prop-status st-${p.status}`}>
                        {p.status === "pending" ? "待审核" : "有冲突"}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </section>
            <section className="wb-panel">
              <div className="wb-panel-head"><h3>最近工作流运行</h3></div>
              {runs.length === 0 && <div className="wb-empty">暂无运行记录。</div>}
              {runs.length > 0 && (
                <div className="prop-list">
                  {runs.slice(0, 8).map((r) => (
                    <button key={r.runId} className="run-record run-record-btn" onClick={() => setRunDetail(r)}>
                      {r.status === "done" ? (
                        <CheckCircle2 size={15} className="run-ok" />
                      ) : (
                        <XCircle size={15} className="run-fail" />
                      )}
                      <div className="prop-main">
                        <strong>{r.workflowName}</strong>
                        <small>
                          {r.status === "done" ? "运行完成" : r.status === "stopped" ? "已停止" : `失败：${r.error ?? ""}`}
                          {r.memoryRefs.length > 0 && ` · 读取记忆 ${r.memoryRefs.length} 份`}
                        </small>
                      </div>
                      <small className="run-time">{new Date(r.startedAt).toLocaleString()}</small>
                    </button>
                  ))}
                </div>
              )}
            </section>
          </div>
          </>
          )}
        </>
      )}

      {runWf && !runMinimized && (
        <Modal
          title={`运行：${runWf.name}`}
          onClose={() => (running ? setRunMinimized(true) : setRunWf(null))}
          width={560}
        >
          <label className="form-row">
            <span className="form-label">输入</span>
            <textarea
              className="text-input"
              rows={4}
              value={runInput}
              onChange={(e) => setRunInput(e.target.value)}
              placeholder={
                runWf.name.startsWith("WF01") ? "这本书的核心创意、题材、想要的风格……" :
                runWf.name.startsWith("WF02") ? "新单元的方向，例如：第二个世界换成都市背景……" :
                runWf.name.startsWith("WF03") ? "本章要写什么，例如：第 3 章，主角初次发现系统异常……" :
                "本单元最终正文或范围说明……"
              }
            />
          </label>
          {project && (project.workflowSlots?.chapter === runWf.id || runWf.name.includes("章节创作")) && (
            <div className="chain-row">
              <label className="chain-input">
                连写
                <input
                  className="text-input"
                  type="number"
                  min={1}
                  max={10}
                  value={chainCount}
                  disabled={running}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    if (Number.isFinite(n) && n >= 1) setChainCount(Math.min(10, Math.floor(n)));
                  }}
                />
                章
              </label>
              <small>连写时每章自动存入新章节并提取记忆</small>
            </div>
          )}
          {chainTotal > 1 && (running || chainIdx > 0) && (
            <p className="chain-progress">{running ? `连写进度：第 ${chainIdx} / ${chainTotal} 章` : ""}</p>
          )}
          {chainLog.length > 0 && (
            <div className="chain-log">
              {chainLog.map((l, i) => (
                <p key={i} className={`chain-log-line is-${l.kind}`}>{l.text}</p>
              ))}
            </div>
          )}
          <div className="ai-run-row">
            <button className="primary-button" disabled={running || !runInput.trim()} onClick={startRun}>
              {running ? <Loader2 size={14} className="spin" /> : <Play size={14} />}
              {running ? "运行中…" : "运行"}
            </button>
            {running && (
              <button className="ghost-button" onClick={stopRun}>
                <Square size={13} /> 停止
              </button>
            )}
            {running && (
              <button className="ghost-button" onClick={() => setRunMinimized(true)} title="关闭弹窗，工作流在后台继续运行">
                后台运行
              </button>
            )}
          </div>
          {runError && <p className="inline-msg err">{runError}</p>}
          {chainSummary && (
            <div className="chain-summary">
              <p className="inline-msg ok">{chainSummary.text}</p>
              {chainSummary.conflicts.length > 0 && (
                <div className="chain-conflicts">
                  {chainSummary.conflicts.map((c, i) => (
                    <span key={i} className="run-mem-ref">{STATE_TYPE_LABEL[c.type as StateEntityType] ?? c.type} · {c.name}</span>
                  ))}
                  <p className="chain-conflict-hint">请到「管理共享记忆 → 结构化状态」处理这些冲突。</p>
                </div>
              )}
            </div>
          )}
          {timeline.length > 0 && (
            <div className="wf-timeline">
              {timeline.map((item) => (
                <div className={`wf-event st-${item.status}`} key={item.key}>
                  <span className="wf-event-dot" />
                  <div className="wf-event-body">
                    <div className="wf-event-head">
                      <strong>{item.label}</strong>
                      <small>
                        {item.status === "running" && "进行中…"}
                        {item.status === "done" && "完成"}
                        {item.status === "error" && (item.error ?? "失败")}
                      </small>
                      {item.output && (
                        <button className="text-button" onClick={() => toggleExpand(item.key)}>
                          {expanded.has(item.key) ? "收起" : "查看全文"}
                        </button>
                      )}
                    </div>
                    {!expanded.has(item.key) && item.preview && <p className="wf-event-preview">{item.preview}</p>}
                    {expanded.has(item.key) && item.output && (
                      <>
                        <pre className="prop-diff-text wf-event-full">{item.output}</pre>
                        <CopyButton text={item.output} />
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
          {finalOutput && (
            <>
              <div className="output-head">
                <span className="form-label">最终输出</span>
                <CopyButton text={finalOutput} />
              </div>
              <div className="ai-output">{finalOutput}</div>
              {propMsg && <p className={`inline-msg ${propMsg.kind}`}>{propMsg.text}</p>}
              {chapterMsg && <p className="inline-msg ok">{chapterMsg}</p>}
              <div className="output-actions">
                {(project?.workflowSlots?.chapter === runWf.id || runWf.name.includes("章节创作")) && (
                  <button className="ghost-button small" onClick={() => void saveAsChapter(finalOutput).then((c) => c && setChapterMsg(`已存入新章节《${c.title}》（当前单元）`))}>
                    存入新章节
                  </button>
                )}
              </div>
            </>
          )}
        </Modal>
      )}

      {runWf && runMinimized && (
        <button className="run-float" onClick={() => setRunMinimized(false)} title="点击查看运行详情">
          {running ? (
            <Loader2 size={13} className="spin" />
          ) : runError ? (
            <XCircle size={13} className="run-fail" />
          ) : (
            <CheckCircle2 size={13} className="run-ok" />
          )}
          {runWf.name} · {running ? "后台运行中" : runError ? "运行失败" : "已完成，点击查看"}
        </button>
      )}

      {memOpen && project && (
        <Modal title={`共享记忆 · ${project.title}`} onClose={() => setMemOpen(false)} width={860}>
          <div className="segmented mem-tabs">
            <button className={memTab === "files" ? "active" : ""} onClick={() => setMemTab("files")}>记忆文件</button>
            <button className={memTab === "state" ? "active" : ""} onClick={() => setMemTab("state")}>结构化状态</button>
          </div>
          {memTab === "state" ? (
            <div className="state-panel">
              {stateErr && <p className="inline-msg err">{stateErr}</p>}
              <div className="state-panel-head">
                <small>状态实体存于 memory/state.json，并自动物化为 state-characters.md 等文件，工作流可用 {"{{memory.state-characters}}"} 引用。</small>
                <button
                  className="ghost-button small"
                  onClick={() => setStateEdit({ type: "character", name: "", data: "" })}
                >
                  <Plus size={13} /> 新增实体
                </button>
              </div>
              {stateEntities.length === 0 && <div className="wb-empty">暂无状态实体。可通过「提取章节记忆」从章节正文自动提取，或手动新增。</div>}
              {STATE_TYPE_ORDER.map((type) => {
                const group = stateEntities.filter((e) => e.type === type);
                if (group.length === 0) return null;
                return (
                  <div key={type} className="state-group">
                    <div className="state-group-head">{STATE_TYPE_LABEL[type]}（{group.length}）</div>
                    {group.map((e) => (
                      <div key={e.id} className="state-item">
                        <div className="state-item-head">
                          <strong>{e.name}</strong>
                          <span className={`state-badge ${e.status === "confirmed" ? "is-confirmed" : "is-inferred"}`}>
                            {e.status === "confirmed" ? "已确认" : "推断"}
                          </span>
                          {e.source && <small className="state-source">来源：{e.source}</small>}
                          <span className="flex-spacer" />
                          <button className="icon-button tiny" title={e.locked ? "解锁（允许提取覆盖）" : "锁定（提取不得覆盖）"} onClick={() => void toggleStateLock(e)}>
                            {e.locked ? <Lock size={12} /> : <Unlock size={12} />}
                          </button>
                          <button className="icon-button tiny" title="编辑" onClick={() => setStateEdit({ id: e.id, type: e.type, name: e.name, data: e.data })}>
                            <Pencil size={12} />
                          </button>
                          <button className="icon-button tiny danger-text" title="删除" onClick={() => setStateDeleting(e)}>
                            <Trash2 size={12} />
                          </button>
                        </div>
                        <p className="state-data">{e.data}</p>
                        {e.conflict && <p className="state-conflict">【冲突】{e.conflict}</p>}
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          ) : (
          <div className="mem-layout">
            <div className="mem-list">
              {memFiles.map((f) => (
                <button key={f.rel} className={`mem-item ${f.rel === memRel ? "active" : ""}`} onClick={() => void pickMemory(f.rel)}>
                  <strong>{memoryLabel(f.rel)}</strong>
                  <small>{f.rel} · {f.size} B</small>
                </button>
              ))}
            </div>
            <div className="mem-editor">
              {!memRel && <div className="wb-empty">从左侧选择一个记忆文件查看或编辑。</div>}
              {memRel && (
                <>
                  <textarea
                    className="text-input mem-textarea"
                    value={memContent}
                    onChange={(e) => { setMemContent(e.target.value); setMemDirty(true); setMemMsg(""); }}
                  />
                  <div className="mem-actions">
                    {memMsg && <span className="inline-msg ok">{memMsg}</span>}
                    {memDirty && <span className="wf-save-state">有未保存修改</span>}
                    <span className="flex-spacer" />
                    <button className="ghost-button small danger-text" onClick={() => setMemDeleting(true)}>
                      删除
                    </button>
                    <button className="ghost-button small" onClick={() => void openHistory()}>
                      <History size={13} /> 历史版本
                    </button>
                    <button className="primary-button" disabled={!memDirty} onClick={() => void saveMemory()}>保存</button>
                  </div>
                </>
              )}
            </div>
          </div>
          )}
        </Modal>
      )}

      {extractOpen && project && (
        <Modal title="提取章节记忆" onClose={() => !extracting && setExtractOpen(false)} width={560}>
          <p className="prop-reason">从章节正文中批量提取角色、伏笔、事件等结构化状态，审阅确认后写入状态库。</p>
          <label className="form-row">
            <span className="form-label">故事单元</span>
            <select
              className="text-input"
              value={extractUnitId}
              disabled={extracting}
              onChange={(e) => {
                const uid = e.target.value;
                setExtractUnitId(uid);
                setExtractChapterIds(defaultCheckedFor(uid, extractLatestStateAt));
              }}
            >
              {project.units.map((u) => (
                <option key={u.id} value={u.id}>{u.title}</option>
              ))}
            </select>
          </label>
          <div className="form-row">
            <div className="extract-chapters-head">
              <span className="form-label">章节（默认勾选提取后有更新的）</span>
              <button className="text-button" disabled={extracting} onClick={() => setExtractChapterIds(new Set(extractChapters.map((c) => c.id)))}>
                全选
              </button>
              <button className="text-button" disabled={extracting} onClick={() => setExtractChapterIds(new Set())}>
                全不选
              </button>
            </div>
            <div className="extract-chapters">
              {extractChapters.length === 0 && <div className="wb-empty">该单元暂无章节</div>}
              {extractChapters.map((c) => (
                <label key={c.id} className="extract-chapter">
                  <input
                    type="checkbox"
                    checked={extractChapterIds.has(c.id)}
                    disabled={extracting}
                    onChange={() => toggleExtractChapter(c.id)}
                  />
                  <strong>{c.title}</strong>
                  <small>{c.words > 0 ? `${c.words} 字` : "空"}</small>
                  <small>{new Date(c.updatedAt).toLocaleString()}</small>
                  {c.words > 0 && c.updatedAt > extractLatestStateAt && <span className="state-badge rel-update">有更新</span>}
                </label>
              ))}
            </div>
          </div>
          {extractProgress && (
            <p className="inline-msg ok">
              <Loader2 size={12} className="spin" /> 正在提取 第 {extractProgress.i}/{extractProgress.n} 章《{extractProgress.title}》…
            </p>
          )}
          {extractError && <p className="inline-msg err">{extractError}</p>}
          <div className="modal-actions">
            <button className="ghost-button" disabled={extracting} onClick={() => setExtractOpen(false)}>取消</button>
            <button
              className="primary-button"
              disabled={extracting || extractChapters.length === 0 || extractChapterIds.size === 0}
              onClick={() => void runExtract()}
            >
              {extracting ? <Loader2 size={14} className="spin" /> : <ScanSearch size={14} />}
              {extracting ? "提取中…" : `开始提取（${extractChapterIds.size} 章）`}
            </button>
          </div>
        </Modal>
      )}

      {extractReview && project && (
        <Modal title={`提取结果 · ${extractReview.chapters} 章`} onClose={() => setExtractReview(null)} width={640}>
          {(() => {
            const n = { new: 0, update: 0, conflict: 0 };
            for (const r of extractReview.items) n[r.item.relation]++;
            return (
              <p className="prop-reason">
                共 {extractReview.chapters} 章，提取出 {extractReview.items.length} 条（新增 {n.new} / 更新 {n.update} / 冲突 {n.conflict}）；新增和更新已默认勾选，冲突项需手动确认（应用时会覆盖现有内容，旧值保留在冲突备注中）。
              </p>
            );
          })()}
          {extractReview.failures.length > 0 && (
            <p className="inline-msg warn">
              {extractReview.failures.length} 章提取失败：{extractReview.failures.map((f) => `《${f.title}》${f.error}`).join("；")}
            </p>
          )}
          {extractReview.items.length === 0 && <div className="wb-empty">所选章节没有提取到新增或变化的状态。</div>}
          {extractError && <p className="inline-msg err">{extractError}</p>}
          <div className="extract-list">
            {extractReview.items.map((row, i) => {
              const it = row.item;
              return (
              <label key={i} className={`extract-item rel-${it.relation}`}>
                <input
                  type="checkbox"
                  checked={extractChecked.has(i)}
                  onChange={() =>
                    setExtractChecked((s) => {
                      const next = new Set(s);
                      if (next.has(i)) next.delete(i);
                      else next.add(i);
                      return next;
                    })
                  }
                />
                <div className="extract-item-body">
                  <div className="extract-item-head">
                    <span className="state-badge neutral">{row.chapterTitle}</span>
                    <span className="state-badge neutral">{STATE_TYPE_LABEL[it.entity.type]}</span>
                    <strong>{it.entity.name}</strong>
                    <span className={`state-badge rel-${it.relation}`}>
                      {it.relation === "new" ? "新增" : it.relation === "update" ? "更新" : "冲突"}
                    </span>
                    <span className={`state-badge ${it.entity.status === "confirmed" ? "is-confirmed" : "is-inferred"}`}>
                      {it.entity.status === "confirmed" ? "已确认" : "推断"}
                    </span>
                    {it.entity.source && <small className="state-source">{it.entity.source}</small>}
                  </div>
                  <pre className="prop-diff-text extract-data">{it.entity.data}</pre>
                  {it.relation !== "new" && it.existingData !== undefined && (
                    <pre className="prop-diff-text extract-data is-existing">现有：{it.existingData}</pre>
                  )}
                </div>
              </label>
              );
            })}
          </div>
          <div className="modal-actions">
            <button className="ghost-button" onClick={() => setExtractReview(null)}>取消</button>
            <button
              className="primary-button"
              disabled={extractApplying || extractChecked.size === 0}
              onClick={() => void applyExtract()}
            >
              {extractApplying ? <Loader2 size={14} className="spin" /> : null}
              应用所选（{extractChecked.size}）
            </button>
          </div>
        </Modal>
      )}

      {stateEdit && (
        <Modal title={stateEdit.id ? "编辑状态实体" : "新增状态实体"} onClose={() => setStateEdit(null)} width={520}>
          {!stateEdit.id && (
            <label className="form-row">
              <span className="form-label">类型</span>
              <select
                className="text-input"
                value={stateEdit.type}
                onChange={(e) => setStateEdit({ ...stateEdit, type: e.target.value as StateEntityType })}
              >
                {STATE_TYPE_ORDER.map((t) => (
                  <option key={t} value={t}>{STATE_TYPE_LABEL[t]}</option>
                ))}
              </select>
            </label>
          )}
          <label className="form-row">
            <span className="form-label">名称</span>
            <input
              className="text-input"
              value={stateEdit.name}
              onChange={(e) => setStateEdit({ ...stateEdit, name: e.target.value })}
              placeholder="如：张三 / F01 神秘来信"
            />
          </label>
          <label className="form-row">
            <span className="form-label">状态描述（Markdown）</span>
            <textarea
              className="text-input"
              rows={8}
              value={stateEdit.data}
              onChange={(e) => setStateEdit({ ...stateEdit, data: e.target.value })}
            />
          </label>
          {stateEditErr && <p className="inline-msg err">{stateEditErr}</p>}
          <div className="modal-actions">
            <button className="ghost-button" onClick={() => setStateEdit(null)}>取消</button>
            <button className="primary-button" disabled={!stateEdit.name.trim()} onClick={() => void saveStateEntity()}>
              保存
            </button>
          </div>
        </Modal>
      )}

      {stateDeleting && (
        <ConfirmDialog
          title="删除状态实体"
          message={`确定删除「${stateDeleting.name}」（${STATE_TYPE_LABEL[stateDeleting.type]}）吗？删除后物化的状态文件将同步更新。`}
          onCancel={() => setStateDeleting(null)}
          onConfirm={() => void deleteStateEntity()}
        />
      )}

      {runGuard && (
        <ConfirmDialog
          title={runGuard.title}
          message={runGuard.message}
          blockConfirm={runGuard.block}
          confirmText="仍要继续"
          altText={runGuard.altText}
          onAlt={runGuard.altText ? () => {
            const fn = runGuard.onAlt;
            setRunGuard(null);
            fn?.();
          } : undefined}
          onCancel={() => setRunGuard(null)}
          onConfirm={() => {
            const fn = runGuard.onOk;
            setRunGuard(null);
            fn?.();
          }}
        />
      )}

      {runDetail && (
        <Modal title={`运行情况 · ${runDetail.workflowName}`} onClose={() => setRunDetail(null)} width={560}>
          <div className="prop-meta">
            <span className={`prop-status st-${runDetail.status === "done" ? "applied" : "conflict"}`}>
              {runDetail.status === "done" ? "运行完成" : runDetail.status === "stopped" ? "已停止" : "失败"}
            </span>
            <span>开始 {new Date(runDetail.startedAt).toLocaleString()}</span>
            <span>耗时 {Math.max(1, Math.round((runDetail.endedAt - runDetail.startedAt) / 1000))} 秒</span>
            <span>{runDetail.steps} 步</span>
            {runDetail.budgetExceeded && <span className="budget-exceeded">已超预算</span>}
            {runDetail.artifactPath && <span>产物：{runDetail.artifactPath}</span>}
            {(() => {
              const wfBudget = workflows.find((w) => w.id === runDetail.workflowId)?.budget;
              if (!wfBudget || !runDetail.usage) return null;
              const parts: string[] = [];
              if (wfBudget.maxCalls) parts.push(`调用 ${runDetail.usage.calls}/${wfBudget.maxCalls} 次`);
              if (wfBudget.maxTokens && !runDetail.usage.unknown) parts.push(`token ${runDetail.usage.totalTokens}/${wfBudget.maxTokens}`);
              if (parts.length === 0) return null;
              return <span>预算消耗：{parts.join(" · ")}</span>;
            })()}
          </div>
          {runDetail.error && <p className="inline-msg err">{runDetail.error}</p>}
          {runDetail.input && (
            <div className="form-row">
              <span className="form-label">运行输入</span>
              <pre className="prop-diff-text nr-text">{runDetail.input}</pre>
            </div>
          )}
          {runDetail.memoryRefs.length > 0 && (
            <div className="form-row">
              <span className="form-label">本次读取的记忆（{runDetail.memoryRefs.length} 份）</span>
              <div className="run-mem-refs">
                {runDetail.memoryRefs.map((m) => (
                  <span key={m} className="run-mem-ref">{memoryLabel(m)}</span>
                ))}
              </div>
            </div>
          )}
          {runDetail.nodeRuns && runDetail.nodeRuns.length > 0 && (
            <NodeRunsTimeline key={runDetail.runId} nodeRuns={runDetail.nodeRuns} usage={runDetail.usage} />
          )}
          {runDetail.finalOutput ? (
            <div className="form-row">
              <div className="output-head">
                <span className="form-label">最终输出</span>
                <CopyButton text={runDetail.finalOutput} />
              </div>
              <pre className="prop-diff-text run-final-output">{runDetail.finalOutput}</pre>
            </div>
          ) : (
            runDetail.outputPreview && (
              <div className="form-row">
                <span className="form-label">输出预览（旧记录仅保留前 200 字）</span>
                <pre className="prop-diff-text">{runDetail.outputPreview}</pre>
              </div>
            )
          )}
          <div className="modal-actions">
            {(runDetail.status === "error" || runDetail.status === "stopped") &&
              runDetail.nodeRuns?.some((n) => n.status === "succeeded") &&
              workflows.some((w) => w.id === runDetail.workflowId) && (
                <div className="resume-run">
                  <button className="primary-button" onClick={() => resumeRun(runDetail)}>
                    从断点继续
                  </button>
                  <small>已完成的节点将复用上次结果，不重复调用模型</small>
                </div>
              )}
            {runDetail.artifactPath && (
              <button
                className="ghost-button"
                onClick={() => void sloth?.novels.revealArtifact(runDetail.projectId, runDetail.artifactPath!)}
              >
                在 Finder 中显示产物文件
              </button>
            )}
            <span className="flex-spacer" />
            <button className="ghost-button" onClick={() => setRunDetail(null)}>关闭</button>
          </div>
        </Modal>
      )}

      {historyOpen && project && (        <Modal title={`历史版本 · ${memRel}`} onClose={() => setHistoryOpen(false)} width={720}>
          {memVersions.length === 0 && <div className="wb-empty">该文件还没有历史版本（每次保存/应用提案时自动留档，最多保留 10 份）。</div>}
          {memVersions.length > 0 && (
            <div className="mem-layout">
              <div className="mem-list">
                {memVersions.map((v) => (
                  <button
                    key={v.ts}
                    className={`mem-item ${historyPreview?.ts === v.ts ? "active" : ""}`}
                    onClick={() => void previewVersion(v.ts)}
                  >
                    <strong>{new Date(v.ts).toLocaleString()}</strong>
                    <small>{v.size} B</small>
                  </button>
                ))}
              </div>
              <div className="mem-editor">
                {!historyPreview && <div className="wb-empty">选择左侧版本查看内容。</div>}
                {historyPreview && (
                  <>
                    <pre className="prop-diff-text mem-history-preview">{historyPreview.content}</pre>
                    <div className="mem-actions">
                      <span className="flex-spacer" />
                      <button className="primary-button" onClick={() => void restoreVersion(historyPreview.ts)}>
                        恢复为此版本
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
        </Modal>
      )}

      {selected && (
        <Modal title={`提案：${selected.summary}`} onClose={() => setSelected(null)} width={860}>
          <div className="prop-meta">
            <span>目标文件：<strong>{selected.targetFile}</strong></span>
            <span>创建于 {new Date(selected.createdAt).toLocaleString()}</span>
            <span className={`prop-status st-${selected.status}`}>
              {selected.status === "pending" ? "待审核" : selected.status === "conflict" ? "有冲突" : selected.status}
            </span>
          </div>
          {selected.reason && <p className="prop-reason">理由：{selected.reason}</p>}
          {selected.status === "conflict" && (
            <p className="inline-msg err">
              提案创建后目标文件已被修改。左侧为当前文件内容，右侧为提案内容；「强制应用」将以提案覆盖当前内容。
            </p>
          )}
          <div className="prop-diff">
            <div className="prop-diff-col">
              <span className="form-label">{selected.status === "conflict" ? "当前内容" : "修改前"}</span>
              <pre className="prop-diff-text">{selected.status === "conflict" ? conflictCurrent : selected.beforeContent}</pre>
            </div>
            <div className="prop-diff-col">
              <span className="form-label">修改后（提案）</span>
              <pre className="prop-diff-text">{selected.proposedContent}</pre>
            </div>
          </div>
          <div className="modal-actions">
            <button className="ghost-button danger-text" onClick={() => void rejectProposal()}>拒绝</button>
            <span className="flex-spacer" />
            {selected.status === "conflict" && (
              <button className="ghost-button danger-text" onClick={() => void acceptProposal(true)}>强制应用</button>
            )}
            <button className="primary-button" onClick={() => void acceptProposal(false)}>
              {selected.status === "conflict" ? "重新尝试应用" : "接受并应用"}
            </button>
          </div>
        </Modal>
      )}

      {newOpen && project && (        <Modal title="新建记忆提案" onClose={() => setNewOpen(false)} width={640}>
          <label className="form-row">
            <span className="form-label">目标记忆文件</span>
            <select className="text-input" value={npTarget} onChange={(e) => setNpTarget(e.target.value)}>
              <option value="">选择文件…</option>
              {memFiles.map((f) => (
                <option key={f.rel} value={f.rel}>{f.rel}</option>
              ))}
            </select>
          </label>
          <label className="form-row">
            <span className="form-label">摘要</span>
            <input className="text-input" value={npSummary} onChange={(e) => setNpSummary(e.target.value)} placeholder="一句话说明这次变更" />
          </label>
          <label className="form-row">
            <span className="form-label">理由</span>
            <input className="text-input" value={npReason} onChange={(e) => setNpReason(e.target.value)} placeholder="为什么要改（可选）" />
          </label>
          <label className="form-row">
            <span className="form-label">修改后内容（完整 Markdown）</span>
            <textarea className="text-input" rows={10} value={npContent} onChange={(e) => setNpContent(e.target.value)} />
          </label>
          <div className="modal-actions">
            <button className="ghost-button" onClick={() => setNewOpen(false)}>取消</button>
            <button className="primary-button" disabled={!npTarget || !npSummary.trim() || !npContent.trim()} onClick={() => void createProposal()}>
              创建提案
            </button>
          </div>
        </Modal>
      )}

      {customOpen && project && (
        <CustomFlowModal projectId={project.id} projectTitle={project.title} onClose={() => setCustomOpen(false)} />
      )}

      {memDeleting && (
        <ConfirmDialog
          title="删除记忆文件"
          message={`确定删除「${memoryLabel(memRel)}」（${memRel}）吗？文件将从磁盘移除。`}
          onCancel={() => setMemDeleting(false)}
          onConfirm={() => void deleteMemory()}
        />
      )}
    </div>
  );
}
