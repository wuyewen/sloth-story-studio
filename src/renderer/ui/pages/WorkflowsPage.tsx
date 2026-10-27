import { useState } from "react";
import { Eye, Loader2, Pencil, Plus, Search, Trash2, Wand2, Workflow } from "lucide-react";
import { sloth } from "../../api";
import { useStudio } from "../../state/store";
import { ConfirmDialog, Modal } from "../components/Modal";
import GroupBar from "../components/GroupBar";
import Canvas from "../workflow/Canvas";
import type { WorkflowDef, WorkflowInput, WorkflowNode } from "../../../shared/types";

function startEndNodes(): WorkflowNode[] {
  return [
    { id: crypto.randomUUID(), type: "start", position: { x: 40, y: 160 }, data: { kind: "start", label: "开始" } },
    { id: crypto.randomUUID(), type: "end", position: { x: 560, y: 160 }, data: { kind: "end", label: "结束" } }
  ];
}

function newest(list: WorkflowDef[]) {
  return list.reduce((a, b) => (a.createdAt > b.createdAt ? a : b));
}

export default function WorkflowsPage() {
  const workflows = useStudio((s) => s.workflows);
  const providers = useStudio((s) => s.providers);
  const refresh = useStudio((s) => s.refreshWorkflows);

  const [editing, setEditing] = useState<WorkflowDef | null>(null);
  const [deleting, setDeleting] = useState<WorkflowDef | null>(null);
  const [genOpen, setGenOpen] = useState(false);
  const [genDesc, setGenDesc] = useState("");
  const [genName, setGenName] = useState("");
  const [genProvider, setGenProvider] = useState("");
  const [genLoading, setGenLoading] = useState(false);
  const [genError, setGenError] = useState("");
  const groups = useStudio((s) => s.workflowGroups);
  const activeGroup = useStudio((s) => s.activeWorkflowGroup);
  const setActiveGroup = useStudio((s) => s.setActiveWorkflowGroup);
  const refreshGroups = useStudio((s) => s.refreshGroups);
  const [search, setSearch] = useState("");

  const usableProviders = providers.filter((p) => p.enabled);

  const shownWorkflows = workflows.filter((w) => {
    const q = search.trim().toLowerCase();
    if (q && !w.name.toLowerCase().includes(q) && !(w.description ?? "").toLowerCase().includes(q)) return false;
    if (activeGroup === null) return true;
    if (activeGroup === "default") return !w.groupId;
    return w.groupId === activeGroup;
  });

  async function dropToGroup(workflowId: string, groupId: string | null) {
    await sloth!.workflows.setGroup(workflowId, groupId);
    await refresh();
  }
  const effectiveProvider = usableProviders.find((p) => p.id === genProvider)?.id ?? usableProviders[0]?.id ?? "";

  async function createBlank() {
    if (!sloth) return;
    const input: WorkflowInput = { name: "未命名工作流", description: "", nodes: startEndNodes(), edges: [] };
    const list = await sloth.workflows.save(input);
    await refresh();
    setEditing(newest(list));
  }

  async function generate() {
    if (!sloth || !genDesc.trim() || !effectiveProvider) return;
    setGenLoading(true);
    setGenError("");
    try {
      const { nodes, edges } = await sloth.workflows.generate(genDesc.trim(), effectiveProvider);
      const withStartEnd = [...nodes];
      if (!withStartEnd.some((n) => n.data.kind === "start")) withStartEnd.unshift(startEndNodes()[0]);
      if (!withStartEnd.some((n) => n.data.kind === "end")) withStartEnd.push(startEndNodes()[1]);
      const input: WorkflowInput = {
        name: genName.trim() || genDesc.trim().slice(0, 16) || "AI 生成工作流",
        description: genDesc.trim(),
        nodes: withStartEnd,
        edges
      };
      const list = await sloth.workflows.save(input);
      await refresh();
      setGenOpen(false);
      setGenDesc("");
      setGenName("");
      setEditing(newest(list));
    } catch (e) {
      setGenError(`生成失败：${String(e)}`);
    } finally {
      setGenLoading(false);
    }
  }

  async function remove() {
    if (!sloth || !deleting) return;
    await sloth.workflows.remove(deleting.id);
    await refresh();
    setDeleting(null);
  }

  if (editing) {
    return <Canvas key={editing.id} workflow={editing} readOnly={Boolean(editing.builtin)} onBack={() => setEditing(null)} />;
  }

  return (
    <div className="agents-page">
      <div className="section-heading agents-head">
        <div>
          <h2>Workflows</h2>
          <p>把 Agent、Prompt 与条件判断连接成可执行的创作流水线。</p>
        </div>
        <div className="head-actions">
          <label className="search-box group-search">
            <Search size={14} />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索工作流…" />
          </label>
          <button className="ghost-button" onClick={() => setGenOpen(true)}>
            <Wand2 size={15} /> 从描述生成
          </button>
          <button className="primary-button" onClick={createBlank}>
            <Plus size={16} /> 新建空白工作流
          </button>
        </div>
      </div>

      <GroupBar
        groups={groups}
        active={activeGroup}
        onSelect={setActiveGroup}
        onCreate={async (name) => { await sloth!.workflows.createGroup(name); await refreshGroups(); }}
        onRename={async (id, name) => { await sloth!.workflows.renameGroup(id, name); await refreshGroups(); }}
        onDelete={async (id) => { await sloth!.workflows.deleteGroup(id); await refreshGroups(); await refresh(); }}
        onDropItem={dropToGroup}
      />

      <div className="agents-scroll">
      {workflows.length === 0 ? (
        <div className="empty-feature">
          <div className="feature-icon">
            <Workflow size={27} />
          </div>
          <div className="eyebrow">VISUAL WORKFLOW</div>
          <h1>让创作流程自动运转</h1>
          <p>从空白画布开始，或者用一句话描述你的流程，交给 AI 生成。</p>
        </div>
      ) : shownWorkflows.length === 0 ? (
        <div className="wb-empty">这个分组里还没有工作流，把卡片拖到上方分组标签即可归组。</div>
      ) : (
        <div className="agents-grid">
          {shownWorkflows.map((w) => (
            <div
              className="agent-card wf-card draggable"
              key={w.id}
              draggable
              onDragStart={(e) => e.dataTransfer.setData("text/plain", w.id)}
              title="可拖拽到上方分组标签归组"
            >
              <div className="agent-body">
                <div className="agent-title-row">
                  <h3>{w.name}</h3>
                  {w.builtin && <span className="badge-builtin">内置</span>}
                  <span className="badge-builtin neutral">{w.nodes.length} 节点</span>
                </div>
                <p className="agent-role">{w.description || "暂无描述"}</p>
                <div className="agent-actions">
                  <select
                    className="text-input wf-slot-select"
                    value={w.groupId ?? ""}
                    onChange={(e) => void dropToGroup(w.id, e.target.value || null)}
                    onClick={(e) => e.stopPropagation()}
                    title="选择分组"
                  >
                    <option value="">默认分组</option>
                    {groups.map((g) => (
                      <option key={g.id} value={g.id}>{g.name}</option>
                    ))}
                  </select>
                  <button className="ghost-button small" onClick={() => setEditing(w)}>
                    {w.builtin ? <Eye size={13} /> : <Pencil size={13} />}
                    {w.builtin ? " 查看" : " 编辑"}
                  </button>
                  {!w.builtin && (
                    <button className="ghost-button small danger-text" onClick={() => setDeleting(w)}>
                      <Trash2 size={13} /> 删除
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      </div>

      {genOpen && (
        <Modal title="从描述生成工作流" onClose={() => !genLoading && setGenOpen(false)} width={520}>
          <label className="form-row">
            <span className="form-label">名称（可选）</span>
            <input className="text-input" value={genName} onChange={(e) => setGenName(e.target.value)} placeholder="例如：章节生产线" />
          </label>
          <label className="form-row">
            <span className="form-label">需求描述</span>
            <textarea
              className="text-input"
              rows={5}
              value={genDesc}
              onChange={(e) => setGenDesc(e.target.value)}
              placeholder="例如：先出大纲→写手成章→审核，审核不通过回到写手重写"
            />
          </label>
          <label className="form-row">
            <span className="form-label">模型</span>
            <select className="text-input" value={effectiveProvider} onChange={(e) => setGenProvider(e.target.value)}>
              {usableProviders.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName}
                </option>
              ))}
            </select>
          </label>
          {usableProviders.length === 0 && (
            <p className="inline-msg err">还没有启用的大模型，请先在托盘「大模型配置」中添加。</p>
          )}
          {genError && <p className="inline-msg err">{genError}</p>}
          <div className="modal-actions">
            <button className="ghost-button" disabled={genLoading} onClick={() => setGenOpen(false)}>
              取消
            </button>
            <button className="primary-button" disabled={genLoading || !genDesc.trim() || !effectiveProvider} onClick={generate}>
              {genLoading ? <Loader2 size={15} className="spin" /> : <Wand2 size={15} />}
              {genLoading ? "生成中…" : "生成"}
            </button>
          </div>
        </Modal>
      )}

      {deleting && (
        <ConfirmDialog
          title="删除工作流"
          message={`确定删除工作流「${deleting.name}」吗？`}
          onCancel={() => setDeleting(null)}
          onConfirm={remove}
        />
      )}
    </div>
  );
}
