import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FilePlus2, FileText, FolderPlus, History, Pencil, Plus, Trash2 } from "lucide-react";
import { sloth } from "../../api";
import { useStudio } from "../../state/store";
import { ConfirmDialog, Modal } from "../components/Modal";
import AiPanel, { type InsertMode } from "./editor/AiPanel";
import { Markdown } from "./editor/Markdown";
import type { ChapterVersion, NovelProject } from "../../../shared/types";

function countWords(text: string) {
  return text.replace(/\s/g, "").length;
}

function fmtTime(ts: number) {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// ---- 行级 LCS diff（自实现，无外部依赖）----

type DiffOp = { type: "same" | "add" | "del"; text: string };
type DiffLine = DiffOp | { type: "fold"; count: number };

function lcsOps(a: string[], b: string[]): DiffOp[] {
  const m = a.length;
  const n = b.length;
  const w = n + 1;
  const dp = new Uint32Array((m + 1) * w);
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i * w + j] =
        a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      ops.push({ type: "same", text: a[i] });
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
      ops.push({ type: "del", text: a[i] });
      i++;
    } else {
      ops.push({ type: "add", text: b[j] });
      j++;
    }
  }
  while (i < m) ops.push({ type: "del", text: a[i++] });
  while (j < n) ops.push({ type: "add", text: b[j++] });
  return ops;
}

const DIFF_MAX_CELLS = 4_000_000; // 超出则不做对齐，避免大章节卡顿

function lineDiff(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  // 公共前缀/后缀裁剪
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const aMid = a.slice(pre, a.length - suf);
  const bMid = b.slice(pre, b.length - suf);
  const same = (text: string): DiffOp => ({ type: "same", text });
  let midOps: DiffOp[];
  if (aMid.length * bMid.length <= DIFF_MAX_CELLS) {
    midOps = lcsOps(aMid, bMid);
  } else {
    midOps = [...aMid.map((t): DiffOp => ({ type: "del", text: t })), ...bMid.map((t): DiffOp => ({ type: "add", text: t }))];
  }
  const all: DiffOp[] = [...a.slice(0, pre).map(same), ...midOps, ...a.slice(a.length - suf).map(same)];
  // 折叠：相同行只保留变更附近 3 行上下文
  const out: DiffLine[] = [];
  let i = 0;
  while (i < all.length) {
    if (all[i].type !== "same") {
      out.push(all[i]);
      i++;
      continue;
    }
    let j = i;
    while (j < all.length && all[j].type === "same") j++;
    const len = j - i;
    const isEdge = i === 0 || j === all.length;
    const keep = isEdge ? 3 : 6; // 段首/段尾 3 行，中间段前后各 3 行
    if (len <= keep + 1) {
      for (let k = i; k < j; k++) out.push(all[k]);
    } else if (i === 0) {
      out.push({ type: "fold", count: len - 3 });
      for (let k = j - 3; k < j; k++) out.push(all[k]);
    } else if (j === all.length) {
      for (let k = i; k < i + 3; k++) out.push(all[k]);
      out.push({ type: "fold", count: len - 3 });
    } else {
      for (let k = i; k < i + 3; k++) out.push(all[k]);
      out.push({ type: "fold", count: len - 6 });
      for (let k = j - 3; k < j; k++) out.push(all[k]);
    }
    i = j;
  }
  return out;
}

const SOURCE_LABEL: Record<string, string> = {
  manual: "手动",
  workflow: "工作流",
  rollback: "回滚",
  unknown: "未知"
};

export default function EditorPage({ query }: { query: string }) {
  const projects = useStudio((s) => s.projects);
  const providers = useStudio((s) => s.providers);
  const agents = useStudio((s) => s.agents);
  const workflows = useStudio((s) => s.workflows);
  const refreshProjects = useStudio((s) => s.refreshProjects);
  const currentProjectId = useStudio((s) => s.currentProjectId);
  const setCurrentProject = useStudio((s) => s.setCurrentProject);

  const [projectId, setProjectId] = useState<string | null>(null);
  const [chapterId, setChapterId] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [view, setView] = useState<"edit" | "preview">("edit");
  const [saveState, setSaveState] = useState<"saved" | "pending" | "saving">("saved");

  const [createOpen, setCreateOpen] = useState(false);
  const [unitOpen, setUnitOpen] = useState(false);
  const [unitTitle, setUnitTitle] = useState("");
  const [renamingUnit, setRenamingUnit] = useState<string | null>(null);
  const [unitRenameTitle, setUnitRenameTitle] = useState("");
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; kind: "unit" | "chapter"; id: string; title: string } | null>(null);
  const [renamingChapter, setRenamingChapter] = useState<{ id: string; title: string } | null>(null);
  const [chapterRenameTitle, setChapterRenameTitle] = useState("");
  const [deletingUnit, setDeletingUnit] = useState<{ id: string; title: string } | null>(null);

  async function confirmDeleteUnit() {
    if (!sloth || !activePid || !deletingUnit) return;
    await sloth.novels.deleteUnit(activePid, deletingUnit.id);
    await refreshProjects();
    if (unitSel === deletingUnit.id) setUnitSel("");
    setDeletingUnit(null);
  }

  async function confirmRenameChapter() {
    if (!sloth || !activePid || !renamingChapter || !chapterRenameTitle.trim()) {
      setRenamingChapter(null);
      return;
    }
    await sloth.novels.renameChapter(activePid, renamingChapter.id, chapterRenameTitle.trim());
    await refreshProjects();
    setRenamingChapter(null);
  }

  async function confirmRenameUnit() {
    if (!sloth || !activePid || !renamingUnit || !unitRenameTitle.trim()) {
      setRenamingUnit(null);
      return;
    }
    await sloth.novels.renameUnit(activePid, renamingUnit, unitRenameTitle.trim());
    await refreshProjects();
    setRenamingUnit(null);
  }
  const [newTitle, setNewTitle] = useState("");
  const [newSynopsis, setNewSynopsis] = useState("");
  const [renaming, setRenaming] = useState<NovelProject | null>(null);
  const [renameTitle, setRenameTitle] = useState("");
  const [deletingProject, setDeletingProject] = useState<NovelProject | null>(null);
  const [deletingChapter, setDeletingChapter] = useState<{ id: string; title: string } | null>(null);

  // ---- 章节版本历史（FR-08）----
  const [histOpen, setHistOpen] = useState(false);
  const [histVersions, setHistVersions] = useState<ChapterVersion[]>([]);
  const [histSel, setHistSel] = useState<number | null>(null); // ts；null = 当前
  const [histContent, setHistContent] = useState("");
  const [histTab, setHistTab] = useState<"content" | "diff">("content");
  const [histMsg, setHistMsg] = useState("");
  const [rollbackTarget, setRollbackTarget] = useState<number | null>(null);

  async function openChapterHistory() {
    if (!sloth || !activePid || !chapterId) return;
    await flushRef.current(); // 先落盘，保证「当前」与磁盘一致
    setHistVersions(await sloth.novels.chapterVersions(activePid, chapterId));
    setHistSel(null);
    setHistContent(contentRef.current);
    setHistTab("content");
    setHistMsg("");
    setHistOpen(true);
  }

  async function selectVersion(ts: number | null) {
    if (!sloth || !activePid || !chapterId) return;
    setHistSel(ts);
    setHistMsg("");
    if (ts === null) {
      setHistContent(contentRef.current);
      return;
    }
    try {
      setHistContent(await sloth.novels.chapterVersionRead(activePid, chapterId, ts));
    } catch (err) {
      setHistContent("");
      setHistMsg(err instanceof Error ? err.message : String(err));
    }
  }

  const diffLines = useMemo(
    () => (histOpen && histTab === "diff" ? lineDiff(histContent, contentRef.current) : []),
    [histOpen, histTab, histContent, content]
  );

  async function confirmRollback() {
    if (!sloth || !activePid || !chapterId || rollbackTarget === null) return;
    const ts = rollbackTarget;
    setRollbackTarget(null);
    await sloth.novels.chapterRollback(activePid, chapterId, ts);
    const text = await sloth.novels.readChapter(activePid, chapterId);
    setContent(text);
    contentRef.current = text;
    pendingRef.current = null;
    setSaveState("saved");
    setHistVersions(await sloth.novels.chapterVersions(activePid, chapterId));
    setHistSel(null);
    setHistContent(text);
    setHistMsg("已回滚，原内容已自动存为新快照");
    await refreshProjects();
  }

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const timerRef = useRef<number | undefined>(undefined);
  const pendingRef = useRef<{ pid: string; cid: string; text: string } | null>(null);
  const contentRef = useRef(content);
  contentRef.current = content;

  const project = projects.find((p) => p.id === (projectId ?? currentProjectId)) ?? projects[0] ?? null;
  const activePid = project?.id ?? null; // 实际生效的项目 id（本地选择或侧边栏全局选择）
  const chapter = project?.chapters.find((c) => c.id === chapterId) ?? null;

  // 左栏单元选择：默认最新单元
  const [unitSel, setUnitSel] = useState<string>("");
  const effectiveUnitSel = unitSel || (project?.units[project.units.length - 1]?.id ?? "");
  const visibleChapters = useMemo(() => {
    if (!project) return [];
    const u = project.units.find((x) => x.id === effectiveUnitSel);
    if (!u) return [];
    return u.chapterIds
      .map((id) => project.chapters.find((c) => c.id === id))
      .filter((c): c is NonNullable<typeof c> => Boolean(c));
  }, [project, effectiveUnitSel]);

  const shownProjects = useMemo(
    () => projects.filter((p) => p.title.toLowerCase().includes(query.toLowerCase())),
    [projects, query]
  );

  const flush = useCallback(async () => {
    window.clearTimeout(timerRef.current);
    const p = pendingRef.current;
    if (!p || !sloth) return;
    pendingRef.current = null;
    setSaveState("saving");
    try {
      await sloth.novels.writeChapter(p.pid, p.cid, p.text, "manual");
      await refreshProjects();
      setSaveState("saved");
    } catch {
      setSaveState("pending");
    }
  }, [refreshProjects]);

  const flushRef = useRef(flush);
  flushRef.current = flush;

  useEffect(() => {
    return () => {
      void flushRef.current();
    };
  }, []);

  useEffect(() => {
    if (projectId && !projects.some((p) => p.id === projectId)) {
      setProjectId(null);
      setChapterId(null);
      setContent("");
    }
  }, [projects, projectId]);

  useEffect(() => {
    let cancelled = false;
    if (!sloth || !activePid || !chapterId) return;
    void flushRef.current();
    void sloth.novels.readChapter(activePid, chapterId).then((text) => {
      if (!cancelled) {
        setContent(text);
        setView("edit");
        setSaveState("saved");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [activePid, chapterId]);

  function updateContent(next: string) {
    setContent(next);
    if (!activePid || !chapterId) return;
    pendingRef.current = { pid: activePid, cid: chapterId, text: next };
    setSaveState("pending");
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => void flushRef.current(), 800);
  }

  function selectProject(id: string) {
    if (id === activePid) return;
    void flushRef.current();
    setProjectId(id);
    setCurrentProject(id);
    setChapterId(null);
    setContent("");
  }

  function selectChapter(id: string) {
    if (id === chapterId) return;
    setChapterId(id);
  }

  async function createProject() {
    if (!sloth || !newTitle.trim()) return;
    await sloth.novels.create(newTitle.trim(), newSynopsis.trim());
    await refreshProjects();
    setCreateOpen(false);
    setNewTitle("");
    setNewSynopsis("");
  }

  async function renameProject() {
    if (!sloth || !renaming || !renameTitle.trim()) return;
    await sloth.novels.rename(renaming.id, renameTitle.trim());
    await refreshProjects();
    setRenaming(null);
  }

  async function removeProject() {
    if (!sloth || !deletingProject) return;
    await sloth.novels.remove(deletingProject.id);
    await refreshProjects();
    setDeletingProject(null);
  }

  async function addUnit() {
    // 按现有最大编号+1（改名/删除后不重号）：第1单元、第3单元 → 新的是第4单元
    const nums = (project?.units ?? [])
      .map((u) => /第\s*(\d+)\s*单元/.exec(u.title)?.[1])
      .filter((n): n is string => Boolean(n))
      .map(Number);
    const next = nums.length > 0 ? Math.max(...nums) + 1 : 1; // 序章这类改名单元不占编号
    setUnitTitle(`第 ${next} 单元`);
    setUnitOpen(true);
  }

  async function confirmAddUnit() {
    if (!sloth || !activePid || !unitTitle.trim()) return;
    await sloth.novels.createUnit(activePid, unitTitle.trim());
    await refreshProjects();
    setUnitOpen(false);
  }

  async function addChapter() {
    if (!sloth || !activePid) return;
    const list = await sloth.novels.createChapter(activePid, `第 ${(project?.chapters.length ?? 0) + 1} 章`, effectiveUnitSel || undefined);
    await refreshProjects();
    const updated = list.find((p) => p.id === activePid);
    const last = updated?.chapters[updated.chapters.length - 1];
    if (last) setChapterId(last.id);
  }

  async function removeChapter() {
    if (!sloth || !activePid || !deletingChapter) return;
    await sloth.novels.deleteChapter(activePid, deletingChapter.id);
    if (chapterId === deletingChapter.id) {
      setChapterId(null);
      setContent("");
    }
    await refreshProjects();
    setDeletingChapter(null);
  }

  function handleInsert(text: string, mode: InsertMode) {
    if (mode === "chapter") {
      void (async () => {
        if (!sloth || !activePid) return;
        const firstLine = text.split(/\r?\n/).find((l) => l.trim())?.trim() ?? "";
        const title = firstLine ? firstLine.slice(0, 12) : "AI 生成章节";
        const list = await sloth.novels.createChapter(activePid, title);
        const updated = list.find((p) => p.id === activePid);
        const last = updated?.chapters[updated.chapters.length - 1];
        if (last) {
          await sloth.novels.writeChapter(activePid, last.id, text, "manual");
          await refreshProjects();
          setChapterId(last.id);
        }
      })();
      return;
    }
    if (!chapterId) return;
    if (mode === "append") {
      const base = contentRef.current;
      updateContent(base ? `${base.replace(/\s+$/, "")}\n\n${text}\n` : text);
      return;
    }
    const ta = textareaRef.current;
    const base = contentRef.current;
    const s = ta?.selectionStart ?? base.length;
    const e = ta?.selectionEnd ?? s;
    updateContent(base.slice(0, s) + text + base.slice(e));
    setView("edit");
    requestAnimationFrame(() => {
      if (ta) {
        ta.focus();
        ta.setSelectionRange(s + text.length, s + text.length);
      }
    });
  }

  return (
    <div className="editor-grid">
      <div className="editor-col proj-col">
        <div className="col-head">
          <span>{project ? `${project.title} · 单元` : "单元"}</span>
          {project && (
            <button className="icon-button" title="新建单元" onClick={addUnit}>
              <FolderPlus size={16} />
            </button>
          )}
        </div>
        <div className="proj-list">
          {!project && <p className="model-empty">先在左侧导航选择一本书。</p>}
          {project && (
            <>
              {project.units.map((u) => {
                const count = u.chapterIds.filter((id) => project.chapters.some((c) => c.id === id)).length;
                return (
                  <div
                    key={u.id}
                    className={`proj-item ${u.id === effectiveUnitSel ? "active" : ""}`}
                    onClick={() => setUnitSel(u.id)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setCtxMenu({ x: e.clientX, y: e.clientY, kind: "unit", id: u.id, title: u.title });
                    }}
                  >
                    {renamingUnit === u.id ? (
                      <input
                        className="text-input unit-rename-input"
                        autoFocus
                        value={unitRenameTitle}
                        onChange={(e) => setUnitRenameTitle(e.target.value)}
                        onBlur={() => void confirmRenameUnit()}
                        onKeyDown={(e) => e.key === "Enter" && void confirmRenameUnit()}
                        onClick={(e) => e.stopPropagation()}
                      />
                    ) : (
                      <strong onDoubleClick={(e) => { e.stopPropagation(); setRenamingUnit(u.id); setUnitRenameTitle(u.title); }} title="双击重命名">{u.title}</strong>
                    )}
                    <small>{count} 章</small>
                  </div>
                );
              })}
            </>
          )}
        </div>
      </div>

      <div className="editor-col chapter-list-col">
        <div className="col-head">
          <span>{project ? `${project.units.find((u) => u.id === effectiveUnitSel)?.title ?? ""} · 章节` : "章节"}</span>
          {project && (
            <button className="icon-button" title="新建章节" onClick={addChapter}>
              <FilePlus2 size={16} />
            </button>
          )}
        </div>
        <div className="proj-list">
          {project && visibleChapters.map((c) => (
            <div
              key={c.id}
              className={`proj-item ${c.id === chapterId ? "active" : ""}`}
              onClick={() => selectChapter(c.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                setCtxMenu({ x: e.clientX, y: e.clientY, kind: "chapter", id: c.id, title: c.title });
              }}
            >
              <strong>{c.title}</strong>
              <small>{c.words} 字</small>
            </div>
          ))}
          {project && visibleChapters.length === 0 && (
            <div className="unit-empty">本单元暂无章节</div>
          )}
        </div>
      </div>

      <div className="editor-col chapter-col">
        {!project && (
          <div className="chapter-placeholder">
            <FileText size={26} />
            <p>从左侧选择一个项目开始写作。</p>
          </div>
        )}
        {project && (
          <>
            {!chapter && (
              <div className="chapter-placeholder">
                <p>选择或新建一个章节。</p>
              </div>
            )}
            {chapter && (
              <>
                <div className="editor-toolbar">
                  <strong>{chapter.title}</strong>
                  <small className="editor-toolbar-words">{countWords(content)} 字</small>
                  <span className="flex-spacer" />
                  <button
                    className="icon-button danger-text"
                    title="删除章节"
                    onClick={() => setDeletingChapter({ id: chapter.id, title: chapter.title })}
                  >
                    <Trash2 size={15} />
                  </button>
                  <button className="ghost-button small" onClick={() => void openChapterHistory()} title="版本历史：查看、对比、回滚">
                    <History size={13} /> 历史
                  </button>
                  <div className="segmented small">
                    <button className={view === "edit" ? "active" : ""} onClick={() => setView("edit")}>
                      编辑
                    </button>
                    <button className={view === "preview" ? "active" : ""} onClick={() => setView("preview")}>
                      预览
                    </button>
                  </div>
                </div>
                {view === "edit" ? (
                  <textarea
                    ref={textareaRef}
                    className="editor-textarea"
                    value={content}
                    onChange={(e) => updateContent(e.target.value)}
                    placeholder="从这里开始你的故事……"
                  />
                ) : (
                  <div className="editor-preview">
                    <Markdown text={content} />
                  </div>
                )}
                <div className="editor-statusbar">
                  <span>{saveState === "saved" ? "已保存" : saveState === "saving" ? "保存中…" : "等待保存…"}</span>
                </div>
              </>
            )}
          </>
        )}
      </div>

      <div className="editor-col ai-col">
        <AiPanel
          providers={providers}
          agents={agents}
          workflows={project ? workflows.filter((w) => (project.workflowIds ?? []).includes(w.id)) : []}
          projectId={project?.id ?? null}
          canEditChapter={!!chapter}
          onInsert={handleInsert}
        />
      </div>

      {createOpen && (
        <Modal title="新建项目" onClose={() => setCreateOpen(false)} width={420}>
          <label className="form-row">
            <span className="form-label">标题</span>
            <input className="text-input" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="给新小说起个名字" autoFocus />
          </label>
          <label className="form-row">
            <span className="form-label">简介</span>
            <textarea className="text-input" rows={4} value={newSynopsis} onChange={(e) => setNewSynopsis(e.target.value)} placeholder="一句话介绍这个故事（可选）" />
          </label>
          <div className="modal-actions">
            <button className="ghost-button" onClick={() => setCreateOpen(false)}>
              取消
            </button>
            <button className="primary-button" disabled={!newTitle.trim()} onClick={createProject}>
              创建
            </button>
          </div>
        </Modal>
      )}

      {renaming && (
        <Modal title="重命名项目" onClose={() => setRenaming(null)} width={380}>
          <label className="form-row">
            <span className="form-label">标题</span>
            <input className="text-input" value={renameTitle} onChange={(e) => setRenameTitle(e.target.value)} autoFocus />
          </label>
          <div className="modal-actions">
            <button className="ghost-button" onClick={() => setRenaming(null)}>
              取消
            </button>
            <button className="primary-button" disabled={!renameTitle.trim()} onClick={renameProject}>
              保存
            </button>
          </div>
        </Modal>
      )}

      {deletingProject && (
        <ConfirmDialog
          title="删除项目"
          message={`确定删除「${deletingProject.title}」吗？项目目录及其全部章节将从磁盘移除，无法恢复。`}
          onCancel={() => setDeletingProject(null)}
          onConfirm={removeProject}
        />
      )}

      {deletingChapter && (
        <ConfirmDialog
          title="删除章节"
          message={`确定删除章节「${deletingChapter.title}」吗？`}
          onCancel={() => setDeletingChapter(null)}
          onConfirm={removeChapter}
        />
      )}

      {unitOpen && (
        <Modal title="新建单元" onClose={() => setUnitOpen(false)} width={400}>
          <label className="form-row">
            <span className="form-label">单元名称</span>
            <input
              className="text-input"
              autoFocus
              value={unitTitle}
              onChange={(e) => setUnitTitle(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void confirmAddUnit()}
              placeholder="如：第 2 单元 · 修仙篇"
            />
          </label>
          <div className="modal-actions">
            <button className="ghost-button" onClick={() => setUnitOpen(false)}>取消</button>
            <button className="primary-button" disabled={!unitTitle.trim()} onClick={() => void confirmAddUnit()}>创建</button>
          </div>
        </Modal>
      )}

      {ctxMenu && (
        <>
          <div className="ctx-mask" onClick={() => setCtxMenu(null)} onContextMenu={(e) => { e.preventDefault(); setCtxMenu(null); }} />
          <div
            className="ctx-menu"
            style={{
              left: Math.min(ctxMenu.x, window.innerWidth - 140),
              top: Math.min(ctxMenu.y, window.innerHeight - 130)
            }}
          >
            {ctxMenu.kind === "unit" ? (
              <>
                <button
                  className="ctx-item"
                  onClick={() => {
                    setRenamingUnit(ctxMenu.id);
                    setUnitRenameTitle(ctxMenu.title);
                    setCtxMenu(null);
                  }}
                >
                  重命名
                </button>
                <button
                  className="ctx-item danger"
                  onClick={() => {
                    setDeletingUnit({ id: ctxMenu.id, title: ctxMenu.title });
                    setCtxMenu(null);
                  }}
                >
                  删除单元
                </button>
              </>
            ) : (
              <>
                <button
                  className="ctx-item"
                  onClick={() => {
                    setRenamingChapter({ id: ctxMenu.id, title: ctxMenu.title });
                    setChapterRenameTitle(ctxMenu.title);
                    setCtxMenu(null);
                  }}
                >
                  重命名
                </button>
                <button
                  className="ctx-item danger"
                  onClick={() => {
                    setDeletingChapter({ id: ctxMenu.id, title: ctxMenu.title });
                    setCtxMenu(null);
                  }}
                >
                  删除章节
                </button>
              </>
            )}
          </div>
        </>
      )}

      {deletingUnit && (
        <ConfirmDialog
          title="删除单元"
          message={`确定删除单元「${deletingUnit.title}」吗？单元内的章节不会被删除，会移到「单元外」。`}
          onCancel={() => setDeletingUnit(null)}
          onConfirm={() => void confirmDeleteUnit()}
        />
      )}

      {renamingChapter && (
        <Modal title="重命名章节" onClose={() => setRenamingChapter(null)} width={400}>
          <label className="form-row">
            <span className="form-label">章节名</span>
            <input
              className="text-input"
              autoFocus
              value={chapterRenameTitle}
              onChange={(e) => setChapterRenameTitle(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void confirmRenameChapter()}
            />
          </label>
          <div className="modal-actions">
            <button className="ghost-button" onClick={() => setRenamingChapter(null)}>取消</button>
            <button className="primary-button" disabled={!chapterRenameTitle.trim()} onClick={() => void confirmRenameChapter()}>保存</button>
          </div>
        </Modal>
      )}

      {histOpen && chapter && activePid && (
        <Modal title={`版本历史 · ${chapter.title}`} onClose={() => setHistOpen(false)} width={860}>
          <div className="mem-layout">
            <div className="mem-list">
              <button
                className={`mem-item ${histSel === null ? "active" : ""}`}
                onClick={() => void selectVersion(null)}
              >
                <strong>当前（正在编辑）</strong>
                <small>{countWords(contentRef.current)} 字</small>
              </button>
              {histVersions.map((v) => (
                <button
                  key={v.ts}
                  className={`mem-item ${histSel === v.ts ? "active" : ""}`}
                  onClick={() => void selectVersion(v.ts)}
                >
                  <strong>
                    {new Date(v.ts).toLocaleString()}
                    <span className={`chv-badge src-${v.source in SOURCE_LABEL ? v.source : "unknown"}`}>
                      {SOURCE_LABEL[v.source] ?? v.source}
                    </span>
                  </strong>
                  <small>{v.size} B</small>
                </button>
              ))}
              {histVersions.length === 0 && <div className="wb-empty">还没有历史版本（每次内容变化并保存时自动留档，最多 30 份）。</div>}
            </div>
            <div className="mem-editor">
              <div className="segmented small chv-tabs">
                <button className={histTab === "content" ? "active" : ""} onClick={() => setHistTab("content")}>内容</button>
                <button className={histTab === "diff" ? "active" : ""} onClick={() => setHistTab("diff")}>与当前对比</button>
              </div>
              {histTab === "content" ? (
                <pre className="prop-diff-text mem-history-preview">{histContent || "（空）"}</pre>
              ) : (
                <div className="chv-diff prop-diff-text mem-history-preview">
                  {histSel === null && <div className="wb-empty">当前版本与自身无差异，选择左侧历史版本进行对比。</div>}
                  {histSel !== null && diffLines.length === 0 && <div className="wb-empty">两个版本内容完全一致。</div>}
                  {histSel !== null &&
                    diffLines.map((l, i) =>
                      l.type === "fold" ? (
                        <div key={i} className="chv-fold">… {l.count} 行未变 …</div>
                      ) : (
                        <div key={i} className={`chv-line is-${l.type}`}>
                          {l.type === "add" ? "+ " : l.type === "del" ? "- " : "  "}
                          {l.text}
                        </div>
                      )
                    )}
                </div>
              )}
              {histMsg && <span className="inline-msg ok">{histMsg}</span>}
              <div className="mem-actions">
                <span className="flex-spacer" />
                <button
                  className="primary-button"
                  disabled={histSel === null}
                  title={histSel === null ? "当前版本不可回滚自身" : "把该版本内容写回正文（当前内容会先自动存为新快照）"}
                  onClick={() => histSel !== null && setRollbackTarget(histSel)}
                >
                  回滚到此版本
                </button>
              </div>
            </div>
          </div>
        </Modal>
      )}

      {rollbackTarget !== null && chapter && (
        <ConfirmDialog
          title="回滚章节"
          message={`确定把「${chapter.title}」回滚到 ${new Date(rollbackTarget).toLocaleString()} 的版本吗？当前内容会先自动存为新快照，可随时再回滚回来。`}
          onCancel={() => setRollbackTarget(null)}
          onConfirm={() => void confirmRollback()}
        />
      )}
    </div>
  );
}
