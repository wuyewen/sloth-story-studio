import { useEffect, useMemo, useRef, useState } from "react";
import {
  BookMarked, FolderTree, Layers, PenLine, Library, Loader2, Play, Square, ChevronRight, Plus,
  CheckCircle2, XCircle, History
} from "lucide-react";
import { sloth } from "../../api";
import { useStudio } from "../../state/store";
import { Modal, ConfirmDialog } from "../components/Modal";
import type { MemoryFileInfo, MemoryProposal, MemoryVersion, WorkflowRunEvent, WorkflowRunRecord } from "../../../shared/types";

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
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

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

  function openRun(prefix: string) {
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
  }

  function startRun() {
    if (!sloth || !runWf || !project) return;
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
        setRunning(false);
      } else if (ev.type === "run-error") {
        setRunError(ev.error ?? "运行失败");
        setRunning(false);
      }
    });
    cleanups.current.push(off);
    void sloth.workflows
      .run(runId, runWf.id, runInput.trim(), project.id)
      .then((res) => {
        if (res?.error) setRunError(res.error);
        if (res?.finalOutput) setFinalOutput(res.finalOutput);
        if (res?.proposalsCreated) setPropMsg({ kind: "ok", text: `已自动创建 ${res.proposalsCreated} 条记忆提案，请到「待审核的记忆提案」查看并确认。` });
        if (res?.proposalsError) setPropMsg({ kind: "err", text: `提案解析失败：${res.proposalsError}（节点输出需为 JSON 数组）` });
        setRunning(false);
        void refreshRuns();
        void refreshProposals();
      })
      .catch((e) => {
        setRunError(String(e));
        setRunning(false);
      })
      .finally(() => off());
  }

  function stopRun() {
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

  useEffect(() => {
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

  async function openMemory() {
    if (!sloth || !project) return;
    setMemFiles(await sloth.novels.memoryList(project.id));
    setMemRel("");
    setMemContent("");
    setMemDirty(false);
    setMemMsg("");
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
    { icon: PenLine, title: "创作下一章", desc: "写作 · 评审 · 返修", prefix: "WF03" },
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
          <div className="wb-head">
            <div className="wb-proj">
              <div className="wb-proj-row">
                <select className="text-input wb-proj-select" value={project.id} onChange={(e) => { setProjectId(e.target.value); setCurrentProject(e.target.value); setUnitId(""); }}>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>{p.title}</option>
                  ))}
                </select>
                <span className="wb-local-badge">本地项目</span>
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
            </div>
            <div className="wb-stat">
              <span className="form-label">本单元进度</span>
              <div className="wb-progress">
                <div className="wb-progress-bar" style={{ width: `${progress}%` }} />
              </div>
              <small>{doneChapters}/{unitChapters.length} 章已有正文 · {progress}%</small>
            </div>
          </div>

          <div className="wb-actions">
            {actions.map((a) => (
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
        </Modal>
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
            {runDetail.artifactPath && <span>产物：{runDetail.artifactPath}</span>}
          </div>
          {runDetail.error && <p className="inline-msg err">{runDetail.error}</p>}
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
