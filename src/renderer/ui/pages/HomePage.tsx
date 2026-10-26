import { useState } from "react";
import { BookOpen, Clock3, FileText, Plus, Sparkles, Trash2, Pencil, Workflow, ChevronRight } from "lucide-react";
import { sloth } from "../../api";
import { useStudio } from "../../state/store";
import { ConfirmDialog, Modal } from "../components/Modal";
import type { NovelProject } from "../../../shared/types";

function fmtTime(ts: number) {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export default function HomePage({ onOpenProject }: { onOpenProject: () => void }) {
  const projects = useStudio((s) => s.projects);
  const agents = useStudio((s) => s.agents);
  const workflows = useStudio((s) => s.workflows);
  const refreshProjects = useStudio((s) => s.refreshProjects);
  const setCurrentProject = useStudio((s) => s.setCurrentProject);

  const [createOpen, setCreateOpen] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newSynopsis, setNewSynopsis] = useState("");
  const [renaming, setRenaming] = useState<NovelProject | null>(null);
  const [renameTitle, setRenameTitle] = useState("");
  const [deleting, setDeleting] = useState<NovelProject | null>(null);

  async function createProject() {
    if (!sloth || !newTitle.trim()) return;
    const list = await sloth.novels.create(newTitle.trim(), newSynopsis.trim());
    await refreshProjects();
    setCreateOpen(false);
    setNewTitle("");
    setNewSynopsis("");
    const created = list.find((p) => p.title === newTitle.trim()) ?? list[0];
    if (created) setCurrentProject(created.id);
    onOpenProject();
  }

  async function doRename() {
    if (!sloth || !renaming || !renameTitle.trim()) return;
    await sloth.novels.rename(renaming.id, renameTitle.trim());
    await refreshProjects();
    setRenaming(null);
  }

  async function doDelete() {
    if (!sloth || !deleting) return;
    await sloth.novels.remove(deleting.id);
    await refreshProjects();
    setDeleting(null);
  }

  function openProject(id: string) {
    setCurrentProject(id);
    onOpenProject();
  }

  return (
    <div>
      <section className="welcome-banner">
        <div className="welcome-copy">
          <div className="eyebrow">
            <span className="eyebrow-dot" /> YOUR QUIET CREATIVE SPACE
          </div>
          <h1>
            让好故事
            <br />
            从这里开始
          </h1>
          <p>本地优先 · AI 赋能 · 流程驱动</p>
          <button className="primary-button" onClick={() => setCreateOpen(true)}>
            <Plus size={17} /> 新建项目
          </button>
        </div>
        <div className="hero-art">
          <div className="hero-glow" />
          <img src="assets/branding/app-icon-1024.png" alt="抱着故事书的树懒品牌插画" />
          <span className="sparkle sparkle-one">✦</span>
          <span className="sparkle sparkle-two">✧</span>
        </div>
        <div className="banner-footnote">
          <BookOpen size={14} /> 给灵感一处慢慢生长的地方
        </div>
      </section>

      <section className="section-heading">
        <div>
          <h2>我的项目</h2>
          <p>{projects.length} 个故事 · {agents.length} 位智能体 · {workflows.length} 条工作流</p>
        </div>
      </section>

      <div className="project-grid">
        {projects.map((p, i) => (
          <article className="project-card" key={p.id}>
            <button className={`project-cover ${["coral", "slate", "cream"][i % 3]}`} onClick={() => openProject(p.id)}>
              <div className="cover-top">
                <span>STORY / {String(i + 1).padStart(2, "0")}</span>
              </div>
              <div className="cover-symbol">
                <BookOpen size={26} strokeWidth={1.4} />
              </div>
              <span className="cover-index">A STORY IN PROGRESS</span>
            </button>
            <div className="project-info">
              <div className="project-title-row">
                <h3>{p.title}</h3>
                <span className="proj-actions">
                  <button
                    className="icon-button tiny"
                    title="重命名"
                    onClick={() => {
                      setRenaming(p);
                      setRenameTitle(p.title);
                    }}
                  >
                    <Pencil size={13} />
                  </button>
                  <button className="icon-button tiny danger-text" title="删除项目" onClick={() => setDeleting(p)}>
                    <Trash2 size={13} />
                  </button>
                </span>
              </div>
              <p>
                <Clock3 size={13} /> 更新于 {fmtTime(p.updatedAt)}
              </p>
              <div className="project-meta">
                <span>
                  <FileText size={13} /> {p.units.length} 单元 · {p.chapters.length} 章
                </span>
                <button className="text-button" onClick={() => openProject(p.id)}>
                  进入 <ChevronRight size={13} />
                </button>
              </div>
            </div>
          </article>
        ))}

        <button className="new-project-card" onClick={() => setCreateOpen(true)}>
          <span className="new-project-icon">
            <Plus size={22} />
          </span>
          <strong>开启一个新故事</strong>
          <small>每个故事，都从一个念头开始</small>
        </button>
      </div>

      {createOpen && (
        <Modal title="新建小说项目" onClose={() => setCreateOpen(false)} width={440}>
          <label className="form-row">
            <span className="form-label">书名</span>
            <input className="text-input" autoFocus value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="例如：星海之境" />
          </label>
          <label className="form-row">
            <span className="form-label">简介（可选）</span>
            <textarea className="text-input" rows={3} value={newSynopsis} onChange={(e) => setNewSynopsis(e.target.value)} placeholder="一句话介绍这个故事……" />
          </label>
          <div className="modal-actions">
            <button className="ghost-button" onClick={() => setCreateOpen(false)}>取消</button>
            <button className="primary-button" disabled={!newTitle.trim()} onClick={() => void createProject()}>创建</button>
          </div>
        </Modal>
      )}

      {renaming && (
        <Modal title="重命名项目" onClose={() => setRenaming(null)} width={400}>
          <label className="form-row">
            <span className="form-label">书名</span>
            <input className="text-input" autoFocus value={renameTitle} onChange={(e) => setRenameTitle(e.target.value)} />
          </label>
          <div className="modal-actions">
            <button className="ghost-button" onClick={() => setRenaming(null)}>取消</button>
            <button className="primary-button" disabled={!renameTitle.trim()} onClick={() => void doRename()}>保存</button>
          </div>
        </Modal>
      )}

      {deleting && (
        <ConfirmDialog
          title="删除项目"
          message={`确定删除「${deleting.title}」吗？项目目录及全部章节、记忆将从磁盘移除，无法恢复。`}
          onCancel={() => setDeleting(null)}
          onConfirm={doDelete}
        />
      )}
    </div>
  );
}
