import { useEffect, useState, type ReactNode } from "react";
import { Handle, Position, useReactFlow, type Node, type NodeProps } from "@xyflow/react";
import { ChevronDown, Database, Flag, ShieldCheck, StickyNote, TerminalSquare, UserRound, Wand2, X } from "lucide-react";
import { useStudio } from "../../state/store";
import { CONTEXT_DEFAULT_SOURCES, CONTEXT_SOURCES, REVIEW_DIMENSIONS, type WorkflowNodeData } from "../../../shared/types";

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

function MaxVisitsRow({ id, data, showAutoProposal = true }: { id: string; data: WorkflowNodeData; showAutoProposal?: boolean }) {
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
      {showAutoProposal && <AutoProposalToggle id={id} data={data} />}
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
  const { updateNodeData } = useReactFlow<WfNode>();
  return (
    <NodeShell className="end-node" showSource={false}>
      <Flag size={13} /> 结束
      <input
        className="nodrag wf-node-select wf-end-src"
        value={data.outputSource ?? ""}
        onChange={(e) => updateNodeData(id, { outputSource: e.target.value })}
        placeholder="输出来源（可选）：如 终修, 写作初稿"
        title="逗号分隔的节点名称，按顺序取第一个已有输出的节点作为最终输出；留空 = 直接上游"
      />
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

export function ReviewNode({ id, data }: NodeProps<WfNode>) {
  const { updateNodeData } = useReactFlow<WfNode>();
  const [dimEditing, setDimEditing] = useState(false);
  const [ctxEditing, setCtxEditing] = useState(false);
  const dims = Array.isArray(data.dimensions) && data.dimensions.length > 0
    ? data.dimensions
    : [...REVIEW_DIMENSIONS];
  const ctx = data.contextTemplate ?? "";

  function toggleDim(d: string) {
    const next = dims.includes(d) ? dims.filter((x) => x !== d) : [...dims, d];
    updateNodeData(id, { dimensions: next });
  }

  return (
    <NodeShell className="review-node" nodeId={id}>
      <div className="wf-node-head">
        <ShieldCheck size={13} />
        <EditableLabel id={id} label={data.label} />
      </div>
      {dimEditing ? (
        <div className="wf-dim-list nodrag nowheel" onMouseLeave={() => setDimEditing(false)}>
          {REVIEW_DIMENSIONS.map((d) => (
            <label key={d} className="wf-dim-item">
              <input type="checkbox" checked={dims.includes(d)} onChange={() => toggleDim(d)} />
              {d}
            </label>
          ))}
        </div>
      ) : (
        <p
          className="wf-node-ctx"
          onDoubleClick={() => setDimEditing(true)}
          title="双击编辑审核维度"
        >
          {dims.length >= REVIEW_DIMENSIONS.length ? "维度：全部 7 项（双击编辑）" : `维度：${dims.length}/7 项（双击编辑）`}
        </p>
      )}
      {ctxEditing ? (
        <textarea
          className="nodrag nowheel wf-node-textarea"
          rows={3}
          autoFocus
          value={ctx}
          onChange={(e) => updateNodeData(id, { contextTemplate: e.target.value })}
          onBlur={() => setCtxEditing(false)}
          placeholder={"自定义审核输入，如：\n{{nodes.写手稿.output}}"}
        />
      ) : (
        <p
          className="wf-node-ctx"
          onDoubleClick={() => setCtxEditing(true)}
          title="双击编辑审核输入模板，默认审核上游输出"
        >
          {ctx.trim() ? `审核输入：${ctx.slice(0, 40)}${ctx.length > 40 ? "…" : ""}` : "审核输入：上游输出（双击自定义）"}
        </p>
      )}
      <MaxVisitsRow id={id} data={data} showAutoProposal={false} />
    </NodeShell>
  );
}

export function PatchNode({ id, data }: NodeProps<WfNode>) {
  const { updateNodeData } = useReactFlow<WfNode>();

  return (
    <NodeShell className="patch-node" nodeId={id}>
      <div className="wf-node-head">
        <Wand2 size={13} />
        <EditableLabel id={id} label={data.label} />
      </div>
      <input
        className="nodrag wf-node-select"
        value={data.textSource ?? ""}
        onChange={(e) => updateNodeData(id, { textSource: e.target.value })}
        placeholder="被修订文本来源（默认：直接上游节点）"
        title="填节点名称，引用该节点的输出作为被修订文本"
      />
      <input
        className="nodrag wf-node-select wf-patch-src"
        value={data.reviewSource ?? ""}
        onChange={(e) => updateNodeData(id, { reviewSource: e.target.value })}
        placeholder="审核结果来源（默认：直接上游节点）"
        title="填节点名称，引用该节点的输出作为审核结果 JSON"
      />
      <MaxVisitsRow id={id} data={data} showAutoProposal={false} />
    </NodeShell>
  );
}

export function ContextNode({ id, data }: NodeProps<WfNode>) {
  const { updateNodeData } = useReactFlow<WfNode>();
  const [editing, setEditing] = useState(false);
  const sources =
    Array.isArray(data.contextSources) && data.contextSources.length > 0
      ? data.contextSources
      : [...CONTEXT_DEFAULT_SOURCES];
  const maxChars = typeof data.contextMaxChars === "number" && data.contextMaxChars > 0 ? data.contextMaxChars : 12000;
  const recentN =
    typeof data.contextRecentChapters === "number" && data.contextRecentChapters > 0 ? data.contextRecentChapters : 1;
  const chapterChars =
    typeof data.contextChapterChars === "number" && data.contextChapterChars > 0 ? data.contextChapterChars : 3000;

  function toggleSource(srcId: string) {
    // 展示顺序固定为 CONTEXT_SOURCES（即优先级顺序），勾选状态进 contextSources
    const next = CONTEXT_SOURCES.map((c) => c.id).filter(
      (cid) => (cid === srcId ? !sources.includes(cid) : sources.includes(cid))
    );
    updateNodeData(id, { contextSources: next });
  }

  const numInput = (
    label: string,
    value: number,
    key: "contextMaxChars" | "contextRecentChapters" | "contextChapterChars",
    min: number,
    max: number
  ) => (
    <label className="wf-node-limits">
      {label}
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n) && n >= min) updateNodeData(id, { [key]: Math.min(max, Math.floor(n)) });
        }}
      />
    </label>
  );

  return (
    <NodeShell className="context-node" nodeId={id}>
      <div className="wf-node-head">
        <Database size={13} />
        <EditableLabel id={id} label={data.label} />
      </div>
      {editing ? (
        <div className="nodrag nowheel" onMouseLeave={() => setEditing(false)}>
          <div className="wf-dim-list">
            {CONTEXT_SOURCES.map((c) => (
              <label key={c.id} className="wf-dim-item">
                <input type="checkbox" checked={sources.includes(c.id)} onChange={() => toggleSource(c.id)} />
                {c.label}
              </label>
            ))}
          </div>
          <div className="wf-ctx-nums">
            {numInput("预算字符", maxChars, "contextMaxChars", 500, 200000)}
            {numInput("最近章节", recentN, "contextRecentChapters", 1, 20)}
            {numInput("每章字符", chapterChars, "contextChapterChars", 200, 50000)}
          </div>
          <input
            className="wf-node-select wf-patch-src"
            value={data.contextMemoryFiles ?? ""}
            onChange={(e) => updateNodeData(id, { contextMemoryFiles: e.target.value })}
            placeholder="额外记忆文件，如：master-outline, style-guide"
            title="勾选「额外记忆文件」后生效；逗号分隔，可不带 .md"
          />
        </div>
      ) : (
        <p className="wf-node-ctx" onDoubleClick={() => setEditing(true)} title="双击编辑来源与预算">
          预算 {maxChars} 字符 · {sources.length} 个来源（双击编辑）
        </p>
      )}
      <MaxVisitsRow id={id} data={data} showAutoProposal={false} />
    </NodeShell>
  );
}

export const nodeTypes = {
  start: StartNode,
  end: EndNode,
  agent: AgentNode,
  prompt: PromptNode,
  note: NoteNode,
  review: ReviewNode,
  patch: PatchNode,
  context: ContextNode
};
