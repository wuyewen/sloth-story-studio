import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FilePlus2, FileText, Pencil, Plus, Trash2 } from "lucide-react";
import { sloth } from "../../api";
import { useStudio } from "../../state/store";
import { ConfirmDialog, Modal } from "../components/Modal";
import AiPanel, { type InsertMode } from "./editor/AiPanel";
import { Markdown } from "./editor/Markdown";
import type { NovelProject } from "../../../shared/types";

function countWords(text: string) {
  return text.replace(/\s/g, "").length;
}

function fmtTime(ts: number) {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export default function EditorPage({ query }: { query: string }) {
  const projects = useStudio((s) => s.projects);
  const providers = useStudio((s) => s.providers);
  const agents = useStudio((s) => s.agents);
  const workflows = useStudio((s) => s.workflows);
  const refreshProjects = useStudio((s) => s.refreshProjects);

  const [projectId, setProjectId] = useState<string | null>(null);
  const [chapterId, setChapterId] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [view, setView] = useState<"edit" | "preview">("edit");
  const [saveState, setSaveState] = useState<"saved" | "pending" | "saving">("saved");

  const [createOpen, setCreateOpen] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newSynopsis, setNewSynopsis] = useState("");
  const [renaming, setRenaming] = useState<NovelProject | null>(null);
  const [renameTitle, setRenameTitle] = useState("");
  const [deletingProject, setDeletingProject] = useState<NovelProject | null>(null);
  const [deletingChapter, setDeletingChapter] = useState<{ id: string; title: string } | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const timerRef = useRef<number | undefined>(undefined);
  const pendingRef = useRef<{ pid: string; cid: string; text: string } | null>(null);
  const contentRef = useRef(content);
  contentRef.current = content;

  const project = projects.find((p) => p.id === projectId) ?? null;
  const chapter = project?.chapters.find((c) => c.id === chapterId) ?? null;

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
      await sloth.novels.writeChapter(p.pid, p.cid, p.text);
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
    if (!sloth || !projectId || !chapterId) return;
    void flushRef.current();
    void sloth.novels.readChapter(projectId, chapterId).then((text) => {
      if (!cancelled) {
        setContent(text);
        setView("edit");
        setSaveState("saved");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, chapterId]);

  function updateContent(next: string) {
    setContent(next);
    if (!projectId || !chapterId) return;
    pendingRef.current = { pid: projectId, cid: chapterId, text: next };
    setSaveState("pending");
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => void flushRef.current(), 800);
  }

  function selectProject(id: string) {
    if (id === projectId) return;
    void flushRef.current();
    setProjectId(id);
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

  async function addChapter() {
    if (!sloth || !projectId) return;
    const list = await sloth.novels.createChapter(projectId, `第 ${(project?.chapters.length ?? 0) + 1} 章`);
    await refreshProjects();
    const updated = list.find((p) => p.id === projectId);
    const last = updated?.chapters[updated.chapters.length - 1];
    if (last) setChapterId(last.id);
  }

  async function removeChapter() {
    if (!sloth || !projectId || !deletingChapter) return;
    await sloth.novels.deleteChapter(projectId, deletingChapter.id);
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
        if (!sloth || !projectId) return;
        const firstLine = text.split(/\r?\n/).find((l) => l.trim())?.trim() ?? "";
        const title = firstLine ? firstLine.slice(0, 12) : "AI 生成章节";
        const list = await sloth.novels.createChapter(projectId, title);
        const updated = list.find((p) => p.id === projectId);
        const last = updated?.chapters[updated.chapters.length - 1];
        if (last) {
          await sloth.novels.writeChapter(projectId, last.id, text);
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
          <span>项目</span>
          <button className="icon-button" title="新建项目" onClick={() => setCreateOpen(true)}>
            <Plus size={16} />
          </button>
        </div>
        <div className="proj-list">
          {shownProjects.map((p) => (
            <div key={p.id} className={`proj-item ${p.id === projectId ? "active" : ""}`} onClick={() => selectProject(p.id)}>
              <strong>{p.title}</strong>
              <small>
                {p.chapters.length} 章 · {fmtTime(p.updatedAt)}
              </small>
              <div className="proj-item-actions">
                <button
                  className="icon-button tiny"
                  title="重命名"
                  onClick={(e) => {
                    e.stopPropagation();
                    setRenaming(p);
                    setRenameTitle(p.title);
                  }}
                >
                  <Pencil size={13} />
                </button>
                <button
                  className="icon-button tiny danger-text"
                  title="删除"
                  onClick={(e) => {
                    e.stopPropagation();
                    setDeletingProject(p);
                  }}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          ))}
          {shownProjects.length === 0 && <p className="model-empty">{query ? "没有匹配的项目。" : "还没有项目，点击右上角新建。"}</p>}
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
            <div className="chapter-bar">
              <div className="chapter-tabs">
                {project.chapters.map((c) => (
                  <button
                    key={c.id}
                    className={`chapter-tab ${c.id === chapterId ? "active" : ""}`}
                    onClick={() => selectChapter(c.id)}
                    title={`${c.words} 字`}
                  >
                    {c.title}
                    <small>{c.words} 字</small>
                  </button>
                ))}
              </div>
              <button className="icon-button" title="新建章节" onClick={addChapter}>
                <FilePlus2 size={16} />
              </button>
              {chapter && (
                <button
                  className="icon-button danger-text"
                  title="删除章节"
                  onClick={() => setDeletingChapter({ id: chapter.id, title: chapter.title })}
                >
                  <Trash2 size={15} />
                </button>
              )}
            </div>

            {!chapter && (
              <div className="chapter-placeholder">
                <p>选择或新建一个章节。</p>
              </div>
            )}
            {chapter && (
              <>
                <div className="editor-toolbar">
                  <strong>{chapter.title}</strong>
                  <span className="flex-spacer" />
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
                  <span>{countWords(content)} 字</span>
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
          workflows={workflows}
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
    </div>
  );
}
