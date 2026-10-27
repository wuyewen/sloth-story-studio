import { useMemo, useState } from "react";
import { Plus, Trash2, Workflow } from "lucide-react";
import { sloth } from "../../api";
import { useStudio } from "../../state/store";
import { Modal } from "../components/Modal";
import type { WorkflowSlot } from "../../../shared/types";

const SLOT_OPTIONS: { value: WorkflowSlot | ""; label: string }[] = [
  { value: "", label: "未指定用途" },
  { value: "planning", label: "全书规划" },
  { value: "unit", label: "单元规划" },
  { value: "chapter", label: "章节创作" },
  { value: "review", label: "单元复盘" }
];

export default function ProjectWorkflowsPage() {
  const projects = useStudio((s) => s.projects);
  const workflows = useStudio((s) => s.workflows);
  const workflowGroups = useStudio((s) => s.workflowGroups);
  const currentProjectId = useStudio((s) => s.currentProjectId);
  const refreshProjects = useStudio((s) => s.refreshProjects);
  const [addOpen, setAddOpen] = useState(false);
  const [addGroup, setAddGroup] = useState<string | null>(null); // 弹窗内分组筛选

  const project = projects.find((p) => p.id === currentProjectId) ?? projects[0] ?? null;

  const assigned = useMemo(() => {
    if (!project) return [];
    return (project.workflowIds ?? [])
      .map((id) => workflows.find((w) => w.id === id))
      .filter((w): w is NonNullable<typeof w> => Boolean(w));
  }, [project, workflows]);

  const assignable = useMemo(() => {
    if (!project) return [];
    const used = new Set(project.workflowIds ?? []);
    return workflows.filter((w) => {
      if (used.has(w.id)) return false;
      if (addGroup === null) return true;
      if (addGroup === "default") return !w.groupId;
      return w.groupId === addGroup;
    });
  }, [project, workflows, addGroup]);

  if (!project) {
    return (
      <div className="empty-feature">
        <h1>没有选中的项目</h1>
        <p>先在左侧「首页」里选择一本书。</p>
      </div>
    );
  }

  async function add(workflowId: string) {
    if (!sloth || !project) return;
    await sloth.novels.assignWorkflow(project.id, workflowId);
    await refreshProjects();
  }

  async function removeAt(workflowId: string) {
    if (!sloth || !project) return;
    await sloth.novels.unassignWorkflow(project.id, workflowId);
    await refreshProjects();
  }

  async function setSlot(slot: string, workflowId: string | null) {
    if (!sloth || !project) return;
    await sloth.novels.setWorkflowSlot(project.id, slot as WorkflowSlot, workflowId);
    await refreshProjects();
  }

  function slotOf(workflowId: string): string {
    const slots = project?.workflowSlots ?? {};
    for (const [slot, id] of Object.entries(slots)) {
      if (id === workflowId) return slot;
    }
    return "";
  }

  return (
    <div>
      <div className="section-heading agents-head">
        <div>
          <h2>工作流管理 · {project.title}</h2>
          <p>这本书使用的工作流。从全局工作流库中添加，移除不会影响全局。</p>
        </div>
        <button className="primary-button" onClick={() => setAddOpen(true)}>
          <Plus size={16} /> 添加工作流
        </button>
      </div>

      {assigned.length === 0 ? (
        <div className="empty-feature">
          <div className="feature-icon"><Workflow size={27} /></div>
          <h1>还没有关联工作流</h1>
          <p>点击「添加工作流」，从全局工作流中为这本书挑选。</p>
        </div>
      ) : (
        <div className="agents-grid">
          {assigned.map((w) => (
            <div className="agent-card wf-card" key={w.id}>
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
                    value={slotOf(w.id)}
                    onChange={(e) => void setSlot(e.target.value, e.target.value ? w.id : null)}
                    title="指定后，创作工作台对应操作将使用此工作流"
                  >
                    {SLOT_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                  <button className="ghost-button small danger-text" onClick={() => void removeAt(w.id)}>
                    <Trash2 size={13} /> 移除
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {addOpen && (
        <Modal title="添加工作流到此项目" onClose={() => setAddOpen(false)} width={520}>
          <label className="form-row">
            <span className="form-label">分组筛选</span>
            <select className="text-input" value={addGroup ?? ""} onChange={(e) => setAddGroup(e.target.value || null)}>
              <option value="">全部分组</option>
              <option value="default">默认分组</option>
              {workflowGroups.map((g) => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
          </label>
          {assignable.length === 0 && <p className="model-empty">没有更多可添加的工作流了。</p>}
          <div className="prop-list">
            {assignable.map((w) => (
              <button
                key={w.id}
                className="prop-item"
                onClick={() => {
                  void add(w.id);
                  if (assignable.length === 1) setAddOpen(false);
                }}
              >
                <div className="prop-main">
                  <strong>{w.name}</strong>
                  <small>
                    {w.description || `${w.nodes.length} 节点`}
                    {w.groupId && ` · ${workflowGroups.find((g) => g.id === w.groupId)?.name ?? "分组"}`}
                  </small>
                </div>
                <Plus size={15} />
              </button>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}
