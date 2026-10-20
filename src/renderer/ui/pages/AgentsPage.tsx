import { useState } from "react";
import { Plus, Pencil, Trash2, Sparkles } from "lucide-react";
import { sloth } from "../../api";
import { providerName, useStudio } from "../../state/store";
import { ConfirmDialog, Modal } from "../components/Modal";
import type { AgentProfile } from "../../../shared/types";

const COLORS = ["#C85B4E", "#7D8796", "#E0A458", "#80A78A", "#5B7EC8", "#8A6FC8"];

const PRESETS = [
  { name: "大纲设计师", role: "拆解故事结构，产出章节大纲" },
  { name: "写手", role: "根据大纲完成章节正文" },
  { name: "审核", role: "检查逻辑、节奏与一致性" },
  { name: "润色", role: "打磨文字，统一文风" }
];

interface FormState {
  name: string;
  role: string;
  systemPrompt: string;
  providerId: string;
  temperature: number;
  color: string;
}

const blank: FormState = {
  name: "",
  role: "",
  systemPrompt: "",
  providerId: "",
  temperature: 0.7,
  color: COLORS[0]
};

export default function AgentsPage() {
  const agents = useStudio((s) => s.agents);
  const providers = useStudio((s) => s.providers);
  const workflows = useStudio((s) => s.workflows);
  const refresh = useStudio((s) => s.refreshAgents);

  const [editing, setEditing] = useState<AgentProfile | "new" | null>(null);
  const [form, setForm] = useState<FormState>(blank);
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState<AgentProfile | null>(null);

  const usable = providers.filter((p) => p.enabled);

  function openNew() {
    setForm({ ...blank, providerId: usable[0]?.id ?? "" });
    setError("");
    setEditing("new");
  }

  function openEdit(a: AgentProfile) {
    setForm({
      name: a.name,
      role: a.role,
      systemPrompt: a.systemPrompt,
      providerId: a.providerId ?? "",
      temperature: a.temperature,
      color: a.color
    });
    setError("");
    setEditing(a);
  }

  function patch(p: Partial<FormState>) {
    setForm((f) => ({ ...f, ...p }));
  }

  async function save() {
    if (!form.name.trim() || !form.role.trim()) {
      setError("请填写名称与职责角色。");
      return;
    }
    await sloth!.agents.save({
      id: editing === "new" ? undefined : (editing as AgentProfile).id,
      name: form.name.trim(),
      role: form.role.trim(),
      systemPrompt: form.systemPrompt,
      providerId: form.providerId || null,
      temperature: form.temperature,
      color: form.color
    });
    await refresh();
    setEditing(null);
  }

  async function remove() {
    if (!deleting) return;
    await sloth!.agents.remove(deleting.id);
    await refresh();
    setDeleting(null);
  }

  return (
    <div className="agents-page">
      <div className="section-heading agents-head">
        <div>
          <h2>Agents</h2>
          <p>为创作流程配置不同职责的 AI 角色。</p>
        </div>
        <button className="primary-button" onClick={openNew}>
          <Plus size={16} /> 新建 Agent
        </button>
      </div>

      <div className="agents-scroll">
      {agents.length === 0 ? (
        <div className="agents-grid">
          {PRESETS.map((p) => (
            <div className="agent-card preset" key={p.name}>
              <div className="agent-colorbar" style={{ background: "#dcd6c8" }} />
              <div className="agent-body">
                <h3>{p.name}</h3>
                <p className="agent-role">{p.role}</p>
                <p className="agent-sub">主进程已自动播种内置 Agent，重启应用后可见。</p>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="agents-grid">
          {agents.map((a) => (
            <div className="agent-card" key={a.id}>
              <div className="agent-colorbar" style={{ background: a.color }} />
              <div className="agent-body">
                <div className="agent-title-row">
                  <h3>{a.name}</h3>
                  {a.builtin && <span className="badge-builtin">内置</span>}
                </div>
                <p className="agent-role">{a.role}</p>
                <div className="agent-meta">
                  <span>{providerName(providers, a.providerId)}</span>
                  <span>temperature {a.temperature.toFixed(1)}</span>
                </div>
                <div className="agent-actions">
                  <button className="ghost-button small" onClick={() => openEdit(a)}>
                    <Pencil size={13} /> 编辑
                  </button>
                  <button
                    className="ghost-button small danger-text"
                    disabled={a.builtin}
                    title={a.builtin ? "内置 Agent 不可删除" : undefined}
                    onClick={() => setDeleting(a)}
                  >
                    <Trash2 size={13} /> 删除
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      </div>

      {editing && (
        <Modal title={editing === "new" ? "新建 Agent" : `编辑 ${(editing as AgentProfile).name}`} onClose={() => setEditing(null)} width={520}>
          <div className="form-grid">
            <label className="form-row">
              <span className="form-label">名称</span>
              <input className="text-input" value={form.name} onChange={(e) => patch({ name: e.target.value })} placeholder="例如：大纲设计师" />
            </label>
            <label className="form-row">
              <span className="form-label">职责角色</span>
              <input className="text-input" value={form.role} onChange={(e) => patch({ role: e.target.value })} placeholder="例如：拆解故事结构，产出章节大纲" />
            </label>
          </div>
          <label className="form-row">
            <span className="form-label">System Prompt</span>
            <textarea
              className="text-input"
              rows={6}
              value={form.systemPrompt}
              onChange={(e) => patch({ systemPrompt: e.target.value })}
              placeholder="你是一位……"
            />
          </label>
          <div className="form-grid">
            <label className="form-row">
              <span className="form-label">绑定大模型</span>
              <select className="text-input" value={form.providerId} onChange={(e) => patch({ providerId: e.target.value })}>
                <option value="">未绑定</option>
                {usable.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.displayName}
                  </option>
                ))}
              </select>
            </label>
            <div className="form-row">
              <span className="form-label">temperature：{form.temperature.toFixed(1)}</span>
              <input
                type="range"
                min={0}
                max={2}
                step={0.1}
                value={form.temperature}
                onChange={(e) => patch({ temperature: Number(e.target.value) })}
              />
            </div>
          </div>
          <div className="form-row">
            <span className="form-label">颜色</span>
            <div className="color-swatches">
              {COLORS.map((c) => (
                <button
                  key={c}
                  className={`swatch ${form.color === c ? "active" : ""}`}
                  style={{ background: c }}
                  onClick={() => patch({ color: c })}
                  aria-label={c}
                />
              ))}
            </div>
          </div>
          {error && <p className="inline-msg err">{error}</p>}
          <div className="modal-actions">
            <button className="ghost-button" onClick={() => setEditing(null)}>
              取消
            </button>
            <button className="primary-button" onClick={save}>
              保存
            </button>
          </div>
        </Modal>
      )}

      {deleting &&
        (() => {
          const usedBy = workflows.filter((w) =>
            w.nodes.some((n) => n.data.kind === "agent" && n.data.agentId === deleting.id)
          );
          const message =
            usedBy.length > 0
              ? `「${deleting.name}」正被 ${usedBy.length} 个工作流使用：${usedBy.map((w) => `《${w.name}》`).join("、")}，无法删除。请先在相关工作流中解绑或删除引用它的节点。`
              : `确定删除「${deleting.name}」吗？当前没有工作流使用它。`;
          return (
            <ConfirmDialog
              title="删除 Agent"
              message={message}
              blockConfirm={usedBy.length > 0}
              onCancel={() => setDeleting(null)}
              onConfirm={remove}
            />
          );
        })()}

      {agents.length === 0 && (
        <div className="empty-note">
          <Sparkles size={14} /> 首次启动时主进程会自动创建 4 个内置 Agent。
        </div>
      )}
    </div>
  );
}
