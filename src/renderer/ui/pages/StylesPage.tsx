import { useState } from "react";
import { Copy, History, Loader2, Palette, Pencil, Plus, Trash2 } from "lucide-react";
import { sloth } from "../../api";
import { useStudio } from "../../state/store";
import { Modal, ConfirmDialog } from "../components/Modal";
import type { StyleProfile, StyleProfileVersion } from "../../../shared/types";

interface StyleForm {
  id?: string;
  name: string;
  genre: string; // 逗号分隔
  tone: string;
  pacing: string;
  pointOfView: string;
  tense: string;
  proseRules: string; // 每行一条
  dialogueRules: string;
  avoidRules: string;
  referenceExample: string;
}

const EMPTY_FORM: StyleForm = {
  name: "",
  genre: "",
  tone: "",
  pacing: "",
  pointOfView: "",
  tense: "",
  proseRules: "",
  dialogueRules: "",
  avoidRules: "",
  referenceExample: ""
};

function toForm(s: StyleProfile): StyleForm {
  return {
    id: s.id,
    name: s.name,
    genre: s.genre.join("，"),
    tone: s.tone.join("，"),
    pacing: s.pacing ?? "",
    pointOfView: s.pointOfView ?? "",
    tense: s.tense ?? "",
    proseRules: s.proseRules.join("\n"),
    dialogueRules: s.dialogueRules.join("\n"),
    avoidRules: s.avoidRules.join("\n"),
    referenceExample: s.referenceExample ?? ""
  };
}

const splitCsv = (s: string): string[] => s.split(/[,，、]/).map((x) => x.trim()).filter(Boolean);

function formToInput(f: StyleForm) {
  return {
    name: f.name,
    genre: splitCsv(f.genre),
    tone: splitCsv(f.tone),
    pacing: f.pacing,
    pointOfView: f.pointOfView,
    tense: f.tense,
    proseRules: f.proseRules.split("\n").map((x) => x.trim()).filter(Boolean),
    dialogueRules: f.dialogueRules.split("\n").map((x) => x.trim()).filter(Boolean),
    avoidRules: f.avoidRules.split("\n").map((x) => x.trim()).filter(Boolean),
    referenceExample: f.referenceExample
  };
}

export default function StylesPage() {
  const projects = useStudio((s) => s.projects);
  const styles = useStudio((s) => s.styles);
  const refreshStyles = useStudio((s) => s.refreshStyles);
  const [edit, setEdit] = useState<StyleForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<StyleProfile | null>(null);
  const [historyFor, setHistoryFor] = useState<StyleProfile | null>(null);
  const [history, setHistory] = useState<StyleProfileVersion[]>([]);
  const [viewing, setViewing] = useState<StyleProfileVersion | null>(null);

  // styles 由全局 store 统一维护（挂载与窗口聚焦时自动刷新）
  async function refresh() {
    await refreshStyles();
  }

  async function save() {
    if (!sloth || !edit || !edit.name.trim()) return;
    setSaving(true);
    try {
      const input = formToInput(edit);
      if (edit.id) await sloth.styles.update(edit.id, input);
      else await sloth.styles.create(input);
      setEdit(null);
      await refresh();
    } finally {
      setSaving(false);
    }
  }

  async function duplicate(id: string) {
    if (!sloth) return;
    await sloth.styles.duplicate(id);
    await refresh();
  }

  async function remove() {
    if (!sloth || !deleting) return;
    await sloth.styles.remove(deleting.id);
    setDeleting(null);
    await refresh();
  }

  async function openHistory(s: StyleProfile) {
    if (!sloth) return;
    setHistoryFor(s);
    setViewing(null);
    setHistory(await sloth.styles.listHistory(s.id));
  }

  async function restore(version: number) {
    if (!sloth || !historyFor) return;
    await sloth.styles.restoreVersion(historyFor.id, version);
    setHistoryFor(null);
    await refresh();
  }

  const usedBy = (id: string) => projects.filter((p) => p.styleId === id).map((p) => p.title);

  return (
    <div className="settings-page styles-page">
      <div className="eyebrow">STYLE</div>
      <div className="section-heading styles-head">
        <div>
          <h1>风格模板</h1>
          <p>定义题材、基调、行文规则与禁忌；在项目设置中绑定后，工作流可用 {"{{style.full}}"} 等插值注入，审核节点也会以其为准。</p>
        </div>
        <button className="primary-button" onClick={() => setEdit({ ...EMPTY_FORM })}>
          <Plus size={14} /> 新建模板
        </button>
      </div>

      {styles.length === 0 && (
        <div className="empty-note">
          <Palette size={16} /> 还没有风格模板，点击「新建模板」创建第一个。
        </div>
      )}
      <div className="agents-grid">
        {styles.map((s) => {
          const users = usedBy(s.id);
          return (
            <div key={s.id} className="agent-card">
              <div className="agent-body">
                <div className="agent-title-row">
                  <h3>{s.name}</h3>
                  <span className="badge-builtin neutral">v{s.version}</span>
                </div>
                <div className="style-tags">
                  {s.genre.map((g) => (
                    <span key={g} className="style-tag">{g}</span>
                  ))}
                  {s.tone.map((t) => (
                    <span key={t} className="style-tag is-tone">{t}</span>
                  ))}
                </div>
                {users.length > 0 && <p className="agent-sub">正在使用：{users.join("、")}</p>}
                <div className="agent-meta">
                  <span>更新于 {new Date(s.updatedAt).toLocaleString()}</span>
                  <span>{s.proseRules.length + s.dialogueRules.length + s.avoidRules.length} 条规则</span>
                </div>
                <div className="agent-actions">
                  <button className="ghost-button small" onClick={() => setEdit(toForm(s))}>
                    <Pencil size={12} /> 编辑
                  </button>
                  <button className="ghost-button small" onClick={() => void duplicate(s.id)}>
                    <Copy size={12} /> 复制
                  </button>
                  <button className="ghost-button small" onClick={() => void openHistory(s)}>
                    <History size={12} /> 历史
                  </button>
                  <button className="ghost-button small danger-text" onClick={() => setDeleting(s)}>
                    <Trash2 size={12} /> 删除
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {edit && (
        <Modal title={edit.id ? "编辑风格模板" : "新建风格模板"} onClose={() => !saving && setEdit(null)} width={640}>
          <div className="form-grid">
            <label className="form-row">
              <span className="form-label">名称</span>
              <input className="text-input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder="如：轻松系统流" />
            </label>
            <label className="form-row">
              <span className="form-label">题材（逗号分隔）</span>
              <input className="text-input" value={edit.genre} onChange={(e) => setEdit({ ...edit, genre: e.target.value })} placeholder="系统流，玄幻，反诈" />
            </label>
            <label className="form-row">
              <span className="form-label">基调（逗号分隔）</span>
              <input className="text-input" value={edit.tone} onChange={(e) => setEdit({ ...edit, tone: e.target.value })} placeholder="轻松，吐槽向" />
            </label>
            <label className="form-row">
              <span className="form-label">节奏</span>
              <input className="text-input" value={edit.pacing} onChange={(e) => setEdit({ ...edit, pacing: e.target.value })} placeholder="如：快节奏，三章一个小高潮" />
            </label>
            <label className="form-row">
              <span className="form-label">叙事视角</span>
              <input className="text-input" value={edit.pointOfView} onChange={(e) => setEdit({ ...edit, pointOfView: e.target.value })} placeholder="如：第三人称限制视角" />
            </label>
            <label className="form-row">
              <span className="form-label">时态</span>
              <input className="text-input" value={edit.tense} onChange={(e) => setEdit({ ...edit, tense: e.target.value })} placeholder="如：过去时叙述" />
            </label>
          </div>
          <label className="form-row">
            <span className="form-label">行文规则（每行一条）</span>
            <textarea className="text-input" rows={4} value={edit.proseRules} onChange={(e) => setEdit({ ...edit, proseRules: e.target.value })} placeholder={"短句为主，段落不超过四行\n动作描写优先于心理描写"} />
          </label>
          <label className="form-row">
            <span className="form-label">对话规则（每行一条）</span>
            <textarea className="text-input" rows={3} value={edit.dialogueRules} onChange={(e) => setEdit({ ...edit, dialogueRules: e.target.value })} placeholder={"对话口语化，允许插科打诨\n系统提示用【】包裹"} />
          </label>
          <label className="form-row">
            <span className="form-label">禁忌（每行一条，避免出现的写法）</span>
            <textarea className="text-input" rows={3} value={edit.avoidRules} onChange={(e) => setEdit({ ...edit, avoidRules: e.target.value })} placeholder={"不说教\n不滥用“了”字结尾"} />
          </label>
          <label className="form-row">
            <span className="form-label">参考示例（作者认可的原创段落，用于校准文风）</span>
            <textarea className="text-input" rows={5} value={edit.referenceExample} onChange={(e) => setEdit({ ...edit, referenceExample: e.target.value })} placeholder="粘贴一段你认可的正文段落……" />
          </label>
          <div className="modal-actions">
            <button className="ghost-button" disabled={saving} onClick={() => setEdit(null)}>取消</button>
            <button className="primary-button" disabled={saving || !edit.name.trim()} onClick={() => void save()}>
              {saving && <Loader2 size={14} className="spin" />} 保存（版本 +1）
            </button>
          </div>
        </Modal>
      )}

      {historyFor && (
        <Modal title={`版本历史 · ${historyFor.name}`} onClose={() => setHistoryFor(null)} width={640}>
          {history.length === 0 && <div className="wb-empty">还没有历史版本（每次保存自动生成快照，最多保留 20 版）。</div>}
          {history.length > 0 && (
            <div className="mem-layout">
              <div className="mem-list">
                {history.map((v) => (
                  <button
                    key={v.version}
                    className={`mem-item ${viewing?.version === v.version ? "active" : ""}`}
                    onClick={() => setViewing(v)}
                  >
                    <strong>v{v.version} · {v.snapshot.name}</strong>
                    <small>{new Date(v.savedAt).toLocaleString()}</small>
                  </button>
                ))}
              </div>
              <div className="mem-editor">
                {!viewing && <div className="wb-empty">选择左侧版本查看内容。</div>}
                {viewing && (
                  <>
                    <pre className="prop-diff-text mem-history-preview">{JSON.stringify(viewing.snapshot, null, 2)}</pre>
                    <div className="mem-actions">
                      <span className="flex-spacer" />
                      <button className="primary-button" onClick={() => void restore(viewing.version)}>
                        恢复此版本
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
        </Modal>
      )}

      {deleting && (
        <ConfirmDialog
          title="删除风格模板"
          message={`确定删除「${deleting.name}」吗？绑定了它的项目将自动视为不绑定（项目本身不受影响）。`}
          onCancel={() => setDeleting(null)}
          onConfirm={() => void remove()}
        />
      )}
    </div>
  );
}
