import { useEffect, useState } from "react";
import { Save } from "lucide-react";
import { sloth } from "../../api";
import { useStudio } from "../../state/store";

export default function ProjectSettingsPage() {
  const projects = useStudio((s) => s.projects);
  const currentProjectId = useStudio((s) => s.currentProjectId);
  const refreshProjects = useStudio((s) => s.refreshProjects);

  const project = projects.find((p) => p.id === currentProjectId) ?? projects[0] ?? null;

  const [title, setTitle] = useState("");
  const [synopsis, setSynopsis] = useState("");
  const [msg, setMsg] = useState("");

  useEffect(() => {
    if (project) {
      setTitle(project.title);
      setSynopsis(project.synopsis);
      setMsg("");
    }
  }, [project?.id, projects]);

  if (!project) {
    return (
      <div className="empty-feature">
        <h1>没有选中的项目</h1>
        <p>先在左侧「小说项目」里选择一本书。</p>
      </div>
    );
  }

  async function save() {
    if (!sloth || !project) return;
    await sloth.novels.updateMeta(project.id, { title: title.trim(), synopsis: synopsis.trim() });
    await refreshProjects();
    setMsg("已保存");
  }

  return (
    <div className="settings-page">
      <div className="eyebrow">PROJECT</div>
      <h1>项目设置</h1>
      <p>当前项目的基本信息。</p>

      <label className="form-row">
        <span className="form-label">书名</span>
        <input className="text-input" value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="form-row">
        <span className="form-label">简介</span>
        <textarea className="text-input" rows={4} value={synopsis} onChange={(e) => setSynopsis(e.target.value)} placeholder="一句话介绍这本书……" />
      </label>
      <div className="setting-row">
        <div>
          <strong>存储目录</strong>
          <small>项目文件夹名（位于小说文本目录下）</small>
        </div>
        <span className="setting-value">{project.id}</span>
      </div>
      <div className="setting-row">
        <div>
          <strong>规模</strong>
          <small>单元与章节数量</small>
        </div>
        <span className="setting-value">{project.units.length} 单元 · {project.chapters.length} 章</span>
      </div>
      <div className="modal-actions" style={{ marginTop: 16 }}>
        {msg && <span className="inline-msg ok">{msg}</span>}
        <span className="flex-spacer" />
        <button className="primary-button" onClick={() => void save()}>
          <Save size={14} /> 保存
        </button>
      </div>
    </div>
  );
}
