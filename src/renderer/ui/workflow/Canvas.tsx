import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  addEdge,
  Background,
  Controls,
  MarkerType,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type IsValidConnection,
  type ReactFlowInstance
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { ArrowLeft, Loader2, Network, Play, Save, Sparkles, Square, Trash2 } from "lucide-react";
import { sloth } from "../../api";
import { useStudio } from "../../state/store";
import { Modal } from "../components/Modal";
import { nodeTypes, type WfNode } from "./nodes";
import { edgeTypes } from "./edges";
import { EDGE_COLORS, LINE_OPTIONS, lineToRfType } from "./edgeUtils";
import type {
  WorkflowDef,
  WorkflowEdgeLine,
  WorkflowInput,
  WorkflowNodeKind,
  WorkflowRunEvent
} from "../../../shared/types";

type WfEdge = Edge<{ line?: WorkflowEdgeLine; color?: string; conditionExpr?: string }>;

type NodeStatus = "running" | "done" | "error";

const ADDABLE: { kind: WorkflowNodeKind; label: string }[] = [
  { kind: "agent", label: "Agent" },
  { kind: "prompt", label: "Prompt" },
  { kind: "note", label: "备注" }
];

function defaultData(kind: WorkflowNodeKind) {
  if (kind === "agent") return { kind, label: "Agent", agentId: null };
  if (kind === "prompt") return { kind, label: "Prompt", template: "{{input}}" };
  return { kind, label: "备注" };
}

export default function Canvas({
  workflow,
  onBack,
  readOnly = false
}: {
  workflow: WorkflowDef;
  onBack: () => void;
  readOnly?: boolean;
}) {
  const refreshWorkflows = useStudio((s) => s.refreshWorkflows);

  const [name, setName] = useState(workflow.name);
  const [description, setDescription] = useState(workflow.description);
  const [wfProviderId, setWfProviderId] = useState(workflow.providerId ?? "");
  const [nodes, setNodes, onNodesChange] = useNodesState<WfNode>(
    workflow.nodes.map((n) => ({
      ...n,
      deletable: n.data.kind !== "start" && n.data.kind !== "end"
    })) as WfNode[]
  );
  const [edges, setEdges, onEdgesChange] = useEdgesState<WfEdge>(workflow.edges as WfEdge[]);
  const [saveState, setSaveState] = useState<"saved" | "dirty" | "saving">("saved");

  const [runOpen, setRunOpen] = useState(false);
  const [runInput, setRunInput] = useState("");
  const [running, setRunning] = useState(false);
  const [nodeStatus, setNodeStatus] = useState<Record<string, NodeStatus>>({});
  const [finalOutput, setFinalOutput] = useState("");
  const [runError, setRunError] = useState("");

  const providers = useStudio((s) => s.providers);
  const enabledProviders = providers.filter((p) => p.enabled);
  const [optOpen, setOptOpen] = useState(false);
  const [optText, setOptText] = useState("");
  const [optProvider, setOptProvider] = useState("");
  const [optimizing, setOptimizing] = useState(false);
  const [optError, setOptError] = useState("");

  async function runOptimize() {
    if (!sloth || !optText.trim()) return;
    const providerId = optProvider || enabledProviders[0]?.id || "";
    if (!providerId) {
      setOptError("还没有启用的大模型，请先在托盘「大模型配置」中添加。");
      return;
    }
    setOptimizing(true);
    setOptError("");
    try {
      const result = await sloth.workflows.optimize(
        {
          nodes: nodes.map((n) => ({ id: n.id, type: n.type ?? "agent", position: n.position, data: n.data })),
          edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target, label: typeof e.label === "string" ? e.label : undefined, data: e.data }))
        },
        optText.trim(),
        providerId
      );
      setNodes(
        result.nodes.map((n) => ({
          ...n,
          deletable: n.data.kind !== "start" && n.data.kind !== "end"
        })) as WfNode[]
      );
      setEdges(result.edges as WfEdge[]);
      setOptOpen(false);
      setOptText("");
    } catch (err) {
      setOptError(err instanceof Error ? err.message : String(err));
    } finally {
      setOptimizing(false);
    }
  }

  const viewportRef = useRef(workflow.viewport);
  const runIdRef = useRef<string | null>(null);
  const cleanups = useRef<(() => void)[]>([]);
  const rfRef = useRef<Pick<ReactFlowInstance, "screenToFlowPosition"> | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const subs = cleanups.current;
    return () => subs.forEach((f) => f());
  }, []);

  const save = useCallback(async () => {
    if (!sloth || readOnly) return;
    setSaveState("saving");
    const input: WorkflowInput = {
      id: workflow.id,
      name: name.trim() || "未命名工作流",
      description,
      providerId: wfProviderId || null,
      nodes: nodes.map((n) => ({ id: n.id, type: n.type ?? "agent", position: n.position, data: n.data })),
      edges: edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        type: e.type,
        label: typeof e.label === "string" ? e.label : undefined,
        animated: e.animated,
        style: e.style as Record<string, unknown> | undefined,
        data: e.data
      })),
      viewport: viewportRef.current
    };
    await sloth.workflows.save(input);
    await refreshWorkflows();
    setSaveState("saved");
  }, [workflow.id, name, description, wfProviderId, nodes, edges, refreshWorkflows, readOnly]);

  const saveRef = useRef(save);
  saveRef.current = save;

  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    setSaveState("dirty");
    const t = window.setTimeout(() => void saveRef.current(), 1500);
    return () => window.clearTimeout(t);
  }, [nodes, edges, name, description, wfProviderId]);

  const onConnect = useCallback(
    (conn: Connection) =>
      setEdges((eds) =>
        addEdge<WfEdge>({ ...conn, type: "default", data: { line: "bezier", color: "#7D8796" } }, eds)
      ),
    [setEdges]
  );

  const isValidConnection: IsValidConnection<WfEdge> = useCallback(
    (conn) => {
      if (!conn.source || !conn.target || conn.source === conn.target) return false;
      const source = nodes.find((n) => n.id === conn.source);
      const target = nodes.find((n) => n.id === conn.target);
      if (!source || !target) return false;
      return source.data.kind !== "end" && target.data.kind !== "start";
    },
    [nodes]
  );

  function addNode(kind: WorkflowNodeKind) {
    const id = crypto.randomUUID();
    let position = { x: 240, y: 120 };
    const rf = rfRef.current;
    const wrap = wrapRef.current;
    if (rf && wrap) {
      const rect = wrap.getBoundingClientRect();
      const center = rf.screenToFlowPosition({
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2
      });
      const jitter = (nodes.length % 3) * 24 - 24;
      position = { x: center.x - 90 + jitter, y: center.y - 30 + jitter };
    }
    setNodes((ns) => [...ns, { id, type: kind, position, data: defaultData(kind) }]);
  }

  function autoLayout() {
    const depth = new Map<string, number>();
    const queue: string[] = [];
    for (const n of nodes) {
      if (n.data.kind === "start") {
        depth.set(n.id, 0);
        queue.push(n.id);
      }
    }
    if (queue.length === 0) {
      const hasIncoming = new Set(edges.map((e) => e.target));
      for (const n of nodes) {
        if (n.data.kind !== "note" && !hasIncoming.has(n.id)) {
          depth.set(n.id, 0);
          queue.push(n.id);
        }
      }
    }
    while (queue.length) {
      const id = queue.shift()!;
      const d = depth.get(id)!;
      for (const e of edges) {
        if (e.source === id && !depth.has(e.target)) {
          depth.set(e.target, d + 1);
          queue.push(e.target);
        }
      }
    }
    let maxDepth = 0;
    for (const d of depth.values()) maxDepth = Math.max(maxDepth, d);

    // 列间距：默认 280，若相邻层之间的边带文字（标签/条件），按「节点宽 + 文字宽 + 边距」加宽，保证文字完整展示
    const textWidth = (t: string): number =>
      [...t].reduce((w, c) => w + (c.charCodeAt(0) > 255 ? 12 : 7), 0);
    const edgeText = (e: WfEdge): string =>
      (typeof e.label === "string" && e.label) ||
      (e.data?.conditionExpr ? `如果 ${e.data.conditionExpr}` : "");
    const xPos: number[] = [60];
    for (let d = 0; d <= maxDepth + 1; d++) {
      let gap = 280;
      for (const e of edges) {
        if (depth.get(e.source) === d && depth.get(e.target) === d + 1) {
          gap = Math.max(gap, 260 + textWidth(edgeText(e)));
        }
      }
      xPos[d + 1] = xPos[d] + gap;
    }

    const layerCount = new Map<number, number>();
    let orphanCount = 0;
    let noteCount = 0;
    const positioned = nodes.map((n) => {
      if (n.data.kind === "note") {
        const y = 80 + noteCount * 150;
        noteCount++;
        return { ...n, position: { x: xPos[maxDepth + 1], y } };
      }
      const d = depth.get(n.id);
      if (d === undefined) {
        const y = 80 + (layerCount.get(maxDepth) ?? 0) * 150 + orphanCount * 150;
        orphanCount++;
        return { ...n, position: { x: xPos[maxDepth], y } };
      }
      const idx = layerCount.get(d) ?? 0;
      layerCount.set(d, idx + 1);
      return { ...n, position: { x: xPos[d], y: 80 + idx * 150 } };
    });
    setNodes(() => positioned);

    // 回退边（指向同层或更前层的循环线）：走节点上方的通道，琥珀色虚线，与主流程区分
    const minY = positioned.reduce((m, n) => Math.min(m, n.position.y), Infinity);
    const loopY = (Number.isFinite(minY) ? minY : 80) - 64;
    setEdges((es) =>
      es.map((e) => {
        const sd = depth.get(e.source);
        const td = depth.get(e.target);
        const isBack = sd !== undefined && td !== undefined && td <= sd;
        if (!isBack) return e;
        return {
          ...e,
          type: "loopback",
          animated: true,
          style: { ...e.style, stroke: "#E0A458", strokeDasharray: "6 4" },
          data: { ...e.data, line: "step" as WorkflowEdgeLine, color: "#E0A458", loopY }
        };
      })
    );
  }

  const selectedEdge = edges.find((e) => e.selected) ?? null;

  function insertNodeOnEdge(edgeId: string, kind: WorkflowNodeKind) {
    const edge = edges.find((e) => e.id === edgeId);
    if (!edge) return;
    const source = nodes.find((n) => n.id === edge.source);
    const target = nodes.find((n) => n.id === edge.target);
    const mid = source && target
      ? { x: (source.position.x + target.position.x) / 2, y: (source.position.y + target.position.y) / 2 }
      : { x: 300, y: 200 };
    const id = crypto.randomUUID();
    setNodes((ns) => [...ns, { id, type: kind, position: mid, data: defaultData(kind) }]);
    setEdges((es) => {
      const old = es.find((e) => e.id === edgeId);
      if (!old) return es;
      const rest = es.filter((e) => e.id !== edgeId);
      return [
        ...rest,
        { ...old, id: crypto.randomUUID(), target: id },
        {
          id: crypto.randomUUID(),
          source: id,
          target: old.target,
          type: old.type,
          style: old.style,
          data: { line: old.data?.line ?? "bezier", color: old.data?.color }
        }
      ];
    });
  }

  function patchEdge(
    id: string,
    patch: { line?: WorkflowEdgeLine; color?: string; label?: string; conditionExpr?: string }
  ) {
    setEdges((es) =>
      es.map((e) => {
        if (e.id !== id) return e;
        const data = {
          line: patch.line ?? e.data?.line ?? "bezier",
          color: patch.color ?? e.data?.color,
          conditionExpr: patch.conditionExpr ?? e.data?.conditionExpr
        };
        return {
          ...e,
          data,
          label: patch.label ?? e.label,
          type: lineToRfType(data.line),
          style: { ...e.style, stroke: data.color }
        };
      })
    );
  }

  const shownNodes = useMemo(
    () =>
      nodes.map((n) => ({
        ...n,
        className: nodeStatus[n.id] ? `st-${nodeStatus[n.id]}` : ""
      })),
    [nodes, nodeStatus]
  );

  const shownEdges = useMemo(
    () =>
      edges.map((e) => ({
        ...e,
        label: e.label ?? (e.data?.conditionExpr ? `如果 ${e.data.conditionExpr}` : undefined),
        labelStyle: { fontSize: 10, whiteSpace: "nowrap" as const },
        labelBgStyle: { fill: "#fffefa", fillOpacity: 0.92 },
        labelBgPadding: [6, 3] as [number, number],
        labelBgBorderRadius: 4,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 16,
          height: 16,
          color: (e.style?.stroke as string) ?? "#7D8796"
        }
      })),
    [edges]
  );

  function startRun() {
    if (!sloth) return;
    const runId = crypto.randomUUID();
    runIdRef.current = runId;
    setNodeStatus({});
    setFinalOutput("");
    setRunError("");
    setRunning(true);
    const off = sloth.workflows.onEvent((ev: WorkflowRunEvent) => {
      if (ev.runId !== runId) return;
      if (ev.type === "node-start" && ev.nodeId) {
        setNodeStatus((s) => ({ ...s, [ev.nodeId!]: "running" }));
      } else if (ev.type === "node-done" && ev.nodeId) {
        setNodeStatus((s) => ({ ...s, [ev.nodeId!]: "done" }));
      } else if (ev.type === "node-error" && ev.nodeId) {
        setNodeStatus((s) => ({ ...s, [ev.nodeId!]: "error" }));
      } else if (ev.type === "run-done") {
        setFinalOutput(ev.finalOutput ?? "");
        setRunning(false);
      } else if (ev.type === "run-error") {
        setRunError(ev.error ?? "运行失败");
        setRunning(false);
      }
    });
    cleanups.current.push(off);
    void (async () => {
      try {
        await saveRef.current();
        const res = await sloth!.workflows.run(runId, workflow.id, runInput.trim());
        if (res?.error) {
          setRunError(res.error);
          setRunning(false);
        }
        if (res?.finalOutput) {
          setFinalOutput(res.finalOutput);
          setRunning(false);
        }
      } catch {
        setRunning(false);
      } finally {
        off();
      }
    })();
  }

  function stopRun() {
    if (sloth && runIdRef.current) void sloth.workflows.stop(runIdRef.current);
  }

  return (
    <div className="wf-edit">
      <div className="wf-toolbar">
        <button className="ghost-button small" onClick={onBack}>
          <ArrowLeft size={14} /> 返回
        </button>
        <input
          className="text-input wf-name"
          value={name}
          readOnly={readOnly}
          onChange={(e) => setName(e.target.value)}
          placeholder="工作流名称"
        />
        <input
          className="text-input wf-desc"
          value={description}
          readOnly={readOnly}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="描述（可选）"
        />
        <select
          className="text-input wf-provider"
          value={wfProviderId}
          disabled={readOnly}
          onChange={(e) => setWfProviderId(e.target.value)}
          title="工作流级大模型：设置后优先于 Agent 绑定的模型"
        >
          <option value="">模型：跟随 Agent</option>
          {providers.filter((p) => p.enabled).map((p) => (
            <option key={p.id} value={p.id}>模型：{p.displayName}</option>
          ))}
        </select>
        {readOnly ? (
          <span className="badge-builtin wf-readonly-badge">内置 · 只读</span>
        ) : (
          <>
            <select className="text-input wf-add" value="" onChange={(e) => e.target.value && addNode(e.target.value as WorkflowNodeKind)}>
              <option value="">添加节点…</option>
              {ADDABLE.map((a) => (
                <option key={a.kind} value={a.kind}>
                  {a.label}
                </option>
              ))}
            </select>
            <span className="wf-save-state">{saveState === "saved" ? "已保存" : saveState === "saving" ? "保存中…" : "有未保存修改"}</span>
            <button className="ghost-button small" onClick={autoLayout} title="按数据流自动分层排列节点">
              <Network size={14} /> 自动整理
            </button>
            <button className="ghost-button small" onClick={() => setOptOpen(true)} title="用一句话描述需求，让 AI 调整当前工作流">
              <Sparkles size={14} /> 优化
            </button>
            <button className="ghost-button small" onClick={() => void saveRef.current()}>
              <Save size={14} /> 保存
            </button>
          </>
        )}
        <button className="primary-button" onClick={() => setRunOpen(true)}>
          <Play size={14} /> 运行测试
        </button>
      </div>

      <div className="wf-canvas-wrap" ref={wrapRef}>
        <ReactFlow
          nodes={shownNodes}
          edges={shownEdges}
          nodeTypes={nodeTypes}
          onInit={(inst) => (rfRef.current = inst)}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          isValidConnection={isValidConnection}
          edgeTypes={edgeTypes}
          defaultViewport={workflow.viewport}
          onMoveEnd={(_, vp) => (viewportRef.current = vp)}
          fitView={!workflow.viewport}
          deleteKeyCode={readOnly ? null : ["Backspace", "Delete"]}
          connectionRadius={60}
          nodesDraggable={!readOnly}
          nodesConnectable={!readOnly}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={18} />
          <Controls />
        </ReactFlow>

        {selectedEdge && (
          <div className="wf-edge-panel">
            <div className="wf-edge-panel-head">
              <strong>边设置</strong>
              <button
                className="icon-button tiny danger-text"
                title="删除边"
                onClick={() => setEdges((es) => es.filter((e) => e.id !== selectedEdge.id))}
              >
                <Trash2 size={13} />
              </button>
            </div>
            <span className="form-label">插入节点</span>
            <div className="wf-insert-row">
              <button className="ghost-button small" onClick={() => insertNodeOnEdge(selectedEdge.id, "agent")}>
                + Agent
              </button>
              <button className="ghost-button small" onClick={() => insertNodeOnEdge(selectedEdge.id, "prompt")}>
                + Prompt
              </button>
            </div>
            <span className="form-label">线型</span>
            <div className="segmented small">
              {LINE_OPTIONS.map((o) => (
                <button
                  key={o.value}
                  className={(selectedEdge.data?.line ?? "bezier") === o.value ? "active" : ""}
                  onClick={() => patchEdge(selectedEdge.id, { line: o.value })}
                >
                  {o.label}
                </button>
              ))}
            </div>
            <span className="form-label">颜色</span>
            <div className="color-swatches">
              {EDGE_COLORS.map((c) => (
                <button
                  key={c}
                  className={`swatch ${selectedEdge.data?.color === c ? "active" : ""}`}
                  style={{ background: c }}
                  onClick={() => patchEdge(selectedEdge.id, { color: c })}
                  aria-label={c}
                />
              ))}
              <input
                type="color"
                className="color-input"
                value={selectedEdge.data?.color ?? "#7D8796"}
                onChange={(e) => patchEdge(selectedEdge.id, { color: e.target.value })}
              />
            </div>
            <label className="form-row">
              <span className="form-label">标签</span>
              <input
                className="text-input"
                value={typeof selectedEdge.label === "string" ? selectedEdge.label : ""}
                onChange={(e) => patchEdge(selectedEdge.id, { label: e.target.value })}
                placeholder="边标签"
              />
            </label>
            <label className="form-row">
              <span className="form-label">条件表达式</span>
              <textarea
                className="text-input"
                rows={3}
                value={selectedEdge.data?.conditionExpr ?? ""}
                onChange={(e) => patchEdge(selectedEdge.id, { conditionExpr: e.target.value })}
                placeholder="output.includes('通过')"
              />
            </label>
          </div>
        )}
      </div>

      {optOpen && (
        <Modal title="根据描述优化工作流" onClose={() => !optimizing && setOptOpen(false)} width={520}>
          <label className="form-row">
            <span className="form-label">优化需求</span>
            <textarea
              className="text-input"
              rows={4}
              value={optText}
              onChange={(e) => setOptText(e.target.value)}
              placeholder="例如：在审核后面加一个读者反馈环节；把写手节点改成两个不同风格的写手并行……"
            />
          </label>
          <label className="form-row">
            <span className="form-label">模型</span>
            <select className="text-input" value={optProvider || enabledProviders[0]?.id || ""} onChange={(e) => setOptProvider(e.target.value)}>
              {enabledProviders.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName}
                </option>
              ))}
            </select>
          </label>
          {enabledProviders.length === 0 && (
            <p className="inline-msg err">还没有启用的大模型，请先在托盘「大模型配置」中添加。</p>
          )}
          {optError && <p className="inline-msg err">{optError}</p>}
          <div className="modal-actions">
            <button className="ghost-button" disabled={optimizing} onClick={() => setOptOpen(false)}>
              取消
            </button>
            <button className="primary-button" disabled={optimizing || !optText.trim() || enabledProviders.length === 0} onClick={() => void runOptimize()}>
              {optimizing ? <Loader2 size={15} className="spin" /> : <Sparkles size={15} />}
              {optimizing ? "优化中…" : "开始优化"}
            </button>
          </div>
        </Modal>
      )}

      {runOpen && (        <Modal title="运行测试" onClose={() => setRunOpen(false)} width={520}>
          <label className="form-row">
            <span className="form-label">输入</span>
            <textarea
              className="text-input"
              rows={4}
              value={runInput}
              onChange={(e) => setRunInput(e.target.value)}
              placeholder="例如：写一段主角在雨夜抵达小镇的开场……"
            />
          </label>
          <div className="ai-run-row">
            <button className="primary-button" disabled={running || !runInput.trim()} onClick={startRun}>
              {running ? <Loader2 size={14} className="spin" /> : <Play size={14} />}
              {running ? "运行中…" : "运行"}
            </button>
            {running && (
              <button className="ghost-button" onClick={stopRun}>
                <Square size={13} /> 停止
              </button>
            )}
          </div>
          {runError && <p className="inline-msg err">{runError}</p>}
          {(running || finalOutput) && (
            <div className="wf-run-output">
              <span className="form-label">最终输出</span>
              <div className="ai-output">{finalOutput || "等待工作流完成…"}</div>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
