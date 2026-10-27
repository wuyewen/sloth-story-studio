import { useEffect, useState, type ReactNode } from "react";
import { Handle, Position, useReactFlow, type Node, type NodeProps } from "@xyflow/react";
import { ChevronDown, Flag, StickyNote, TerminalSquare, UserRound, X } from "lucide-react";
import { useStudio } from "../../state/store";
import type { WorkflowNodeData } from "../../../shared/types";

export type WfNode = Node<WorkflowNodeData, string>;

function NodeShell({
  children,
  className = "",
  showTarget = true,
  showSource = true,
  nodeId
}: {
  children: ReactNode;
  className?: string;
  showTarget?: boolean;
  showSource?: boolean;
  nodeId?: string; // 传入则显示悬浮删除按钮（start/end 不传）
}) {
  const { deleteElements } = useReactFlow();
  return (
    <div className={`wf-node ${className}`}>
      {showTarget && <Handle type="target" position={Position.Left} />}
      {nodeId && (
        <button
          className="wf-node-del nodrag"
          title="删除节点"
          onClick={() => void deleteElements({ nodes: [{ id: nodeId }] })}
        >
          <X size={11} />
        </button>
      )}
      {children}
      {showSource && <Handle type="source" position={Position.Right} />}
    </div>
  );
}

function AutoProposalToggle({ id, data }: { id: string; data: WorkflowNodeData }) {
  const { updateNodeData } = useReactFlow<WfNode>();
  const [warn, setWarn] = useState(false);
  const tpl = String(data.template ?? data.contextTemplate ?? "");
  const hasJsonSpec = /targetFile/.test(tpl);
  return (
    <div className="wf-ap-wrap nodrag">
      <label
        className="wf-node-limits"
        title="开启后：本节点输出若为提案 JSON 数组，将自动创建到「待审核的记忆提案」（不自动应用）"
      >
        <input
          type="checkbox"
          checked={Boolean(data.autoProposal)}
          onChange={(e) => {
            const on = e.target.checked;
            updateNodeData(id, { autoProposal: on });
            setWarn(on && !hasJsonSpec);
          }}
        />
        自动转提案
      </label>
      {data.autoProposal && (warn || !hasJsonSpec) && (
        <p className="wf-ap-warn">⚠ 模板里没检测到 targetFile 等 JSON 提案格式要求，运行时可能解析失败</p>
      )}
    </div>
  );
}

function MaxVisitsRow({ id, data }: { id: string; data: WorkflowNodeData }) {
  const { updateNodeData } = useReactFlow<WfNode>();
  const value = typeof data.maxVisits === "number" && data.maxVisits > 0 ? data.maxVisits : 3;
  return (
    <div className="wf-node-bottom nodrag">
      <label className="wf-node-limits" title="循环返回该节点时，单次运行最多执行的次数">
        最多执行
        <input
          type="number"
          min={1}
          max={20}
          value={value}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (Number.isFinite(n) && n >= 1) updateNodeData(id, { maxVisits: Math.min(20, Math.floor(n)) });
          }}
        />
        次
      </label>
      <AutoProposalToggle id={id} data={data} />
    </div>
  );
}

function EditableLabel({ id, label }: { id: string; label: string }) {
  const { updateNodeData } = useReactFlow<WfNode>();
  const [editing, setEditing] = useState(false);
  return editing ? (
    <input
      className="nodrag wf-label-input"
      autoFocus
      value={label}
      onChange={(e) => updateNodeData(id, { label: e.target.value })}
      onBlur={() => setEditing(false)}
      onKeyDown={(e) => e.key === "Enter" && setEditing(false)}
    />
  ) : (
    <span
      className="wf-label"
      onDoubleClick={() => setEditing(true)}
      title="双击重命名（其他节点可用 {{nodes.名称.output}} 引用它的输出）"
    >
      {label}
    </span>
  );
}

export function StartNode() {
  return (
    <NodeShell className="start-node" showTarget={false}>
      <Flag size={13} /> 开始
    </NodeShell>
  );
}

export function EndNode({ id, data }: NodeProps<WfNode>) {
  return (
    <NodeShell className="end-node" showSource={false}>
      <Flag size={13} /> 结束
      <AutoProposalToggle id={id} data={data} />
    </NodeShell>
  );
}

export function AgentNode({ id, data }: NodeProps<WfNode>) {
  const agents = useStudio((s) => s.agents);
  const agentGroups = useStudio((s) => s.agentGroups);
  const { updateNodeData } = useReactFlow<WfNode>();
  const agent = agents.find((a) => a.id === data.agentId) ?? null;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [ctxEditing, setCtxEditing] = useState(false);
  const [groupFilter, setGroupFilter] = useState<string | null>(null); // null=全部 "default"=默认分组
  const canvasGroup = useStudio((s) => s.canvasAgentGroup);
  // 画布工具条选了分组时，下拉默认只显示该组（本地 chip 仍可临时切换）
  useEffect(() => {
    setGroupFilter(canvasGroup);
  }, [canvasGroup]);
  const filtered = agents.filter((a) => {
    const q = query.trim().toLowerCase();
    if (q && !a.name.toLowerCase().includes(q)) return false;
    if (groupFilter === null) return true;
    if (groupFilter === "default") return !a.groupId;
    return a.groupId === groupFilter;
  });

  function choose(agentId: string | null) {
    updateNodeData(id, { agentId });
    setOpen(false);
    setQuery("");
  }

  const ctx = data.contextTemplate ?? "";

  return (
    <NodeShell className="agent-node" nodeId={id}>
      <div className="wf-node-head">
        <UserRound size={13} />
        <EditableLabel id={id} label={data.label} />
        {agent && <i className="agent-dot" style={{ background: agent.color }} />}
      </div>
      <div className="wf-combo nodrag">
        <input
          className="wf-node-select wf-combo-input"
          value={open ? query : (agent?.name ?? "")}
          placeholder="输入字母筛选 Agent…"
          onFocus={() => {
            setQuery("");
            setOpen(true);
          }}
          onBlur={() => window.setTimeout(() => setOpen(false), 120)}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
        />
        <ChevronDown size={12} className="wf-combo-chevron" />
        {open && (
          <div className="wf-combo-list nodrag nowheel">
            {agentGroups.length > 0 && (
              <div className="wf-combo-groups nodrag nowheel">
                {[{ id: null as string | null, label: "全部" }, { id: "default" as string | null, label: "默认" }, ...agentGroups.map((g) => ({ id: g.id as string | null, label: g.name }))].map((g) => (
                  <button
                    key={g.id ?? "all"}
                    className={`wf-combo-gchip ${groupFilter === g.id ? "active" : ""}`}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      setGroupFilter(g.id);
                    }}
                  >
                    {g.label}
                  </button>
                ))}
              </div>
            )}
            <button className="wf-combo-item muted" onMouseDown={() => choose(null)}>
              不绑定
            </button>
            {filtered.map((a) => (
              <button key={a.id} className="wf-combo-item" onMouseDown={() => choose(a.id)}>
                <i className="agent-dot" style={{ background: a.color }} />
                {a.name}
              </button>
            ))}
            {filtered.length === 0 && <div className="wf-combo-empty">无匹配</div>}
          </div>
        )}
      </div>
      {agent && <small className="wf-node-sub">{agent.role}</small>}
      {ctxEditing ? (
        <textarea
          className="nodrag nowheel wf-node-textarea"
          rows={3}
          autoFocus
          value={ctx}
          onChange={(e) => updateNodeData(id, { contextTemplate: e.target.value })}
          onBlur={() => setCtxEditing(false)}
          placeholder={"自定义上下文，如：\n初稿：\n{{nodes.写手稿.output}}\n\n审核意见：\n{{nodes.审核.output}}"}
        />
      ) : (
        <p
          className="wf-node-ctx"
          onDoubleClick={() => setCtxEditing(true)}
          title="双击编辑上下文模板，可用 {{input}} 与 {{nodes.<节点id>.output}} 引用前序节点输出"
        >
          {ctx.trim() ? `上下文：${ctx.slice(0, 40)}${ctx.length > 40 ? "…" : ""}` : "上下文：上游输出（双击自定义）"}
        </p>
      )}
      <MaxVisitsRow id={id} data={data} />
    </NodeShell>
  );
}

export function PromptNode({ id, data }: NodeProps<WfNode>) {
  const { updateNodeData } = useReactFlow<WfNode>();
  const [editing, setEditing] = useState(false);
  const template = data.template ?? "";

  return (
    <NodeShell className="prompt-node" nodeId={id}>
      <div className="wf-node-head">
        <TerminalSquare size={13} />
        <EditableLabel id={id} label={data.label} />
      </div>
      {editing ? (
        <textarea
          className="nodrag nowheel wf-node-textarea"
          rows={4}
          autoFocus
          value={template}
          onChange={(e) => updateNodeData(id, { template: e.target.value })}
          onBlur={() => setEditing(false)}
          placeholder="支持 {{input}} 与 {{nodes.<id>.output}} 插值"
        />
      ) : (
        <p className="wf-node-summary" onDoubleClick={() => setEditing(true)} title="双击编辑模板">
          {template.trim() ? template : "双击编辑模板…"}
        </p>
      )}
      <MaxVisitsRow id={id} data={data} />
    </NodeShell>
  );
}

export function NoteNode({ id, data }: NodeProps<WfNode>) {
  const { updateNodeData } = useReactFlow<WfNode>();
  const [editing, setEditing] = useState(false);

  return (
    <NodeShell className="note-node" nodeId={id}>
      <div className="wf-node-head">
        <StickyNote size={13} />
        <span>备注</span>
      </div>
      {editing ? (
        <textarea
          className="nodrag nowheel wf-node-textarea"
          rows={3}
          autoFocus
          value={data.label}
          onChange={(e) => updateNodeData(id, { label: e.target.value })}
          onBlur={() => setEditing(false)}
        />
      ) : (
        <p className="wf-node-summary" onDoubleClick={() => setEditing(true)} title="双击编辑备注">
          {data.label.trim() ? data.label : "双击写备注…"}
        </p>
      )}
    </NodeShell>
  );
}

export const nodeTypes = {
  start: StartNode,
  end: EndNode,
  agent: AgentNode,
  prompt: PromptNode,
  note: NoteNode
};
