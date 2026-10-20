import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Loader2, Play, Square, Wand2 } from "lucide-react";
import { sloth } from "../../../api";
import type {
  AgentProfile,
  AgentRunEvent,
  ModelProviderInfo,
  WorkflowDef,
  WorkflowRunEvent
} from "../../../../shared/types";

export type InsertMode = "cursor" | "append" | "chapter";

interface Props {
  providers: ModelProviderInfo[];
  agents: AgentProfile[];
  workflows: WorkflowDef[];
  canEditChapter: boolean;
  onInsert: (text: string, mode: InsertMode) => void;
}

type Mode = "direct" | "agents" | "workflow";

interface AgentRecord {
  id: string;
  name: string;
  status: "pending" | "running" | "done" | "error";
  output?: string;
  error?: string;
}

interface TimelineItem {
  key: number;
  nodeId?: string;
  label: string;
  status: "running" | "done" | "error";
  preview?: string;
  error?: string;
}

function InsertBar({
  text,
  canEditChapter,
  onInsert
}: {
  text: string;
  canEditChapter: boolean;
  onInsert: (text: string, mode: InsertMode) => void;
}) {
  if (!text.trim()) return null;
  return (
    <div className="insert-bar">
      <button className="ghost-button small" disabled={!canEditChapter} onClick={() => onInsert(text, "cursor")}>
        插入光标处
      </button>
      <button className="ghost-button small" disabled={!canEditChapter} onClick={() => onInsert(text, "append")}>
        追加到章节末尾
      </button>
      <button className="ghost-button small" onClick={() => onInsert(text, "chapter")}>
        另存为新章节
      </button>
    </div>
  );
}

export default function AiPanel({ providers, agents, workflows, canEditChapter, onInsert }: Props) {
  const [mode, setMode] = useState<Mode>("direct");
  const cleanups = useRef<(() => void)[]>([]);

  useEffect(() => {
    const subs = cleanups.current;
    return () => subs.forEach((f) => f());
  }, []);

  // ---- 直接写 ----
  const [providerId, setProviderId] = useState("");
  const [directPrompt, setDirectPrompt] = useState("");
  const [directOutput, setDirectOutput] = useState("");
  const [directRunning, setDirectRunning] = useState(false);
  const [directError, setDirectError] = useState("");
  const directReqId = useRef<string | null>(null);

  // ---- 多 Agent ----
  const [picked, setPicked] = useState<string[]>([]);
  const [agentsPrompt, setAgentsPrompt] = useState("");
  const [records, setRecords] = useState<AgentRecord[]>([]);
  const [agentsRunning, setAgentsRunning] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const agentsRunId = useRef<string | null>(null);

  // ---- 工作流 ----
  const [workflowId, setWorkflowId] = useState("");
  const [wfInput, setWfInput] = useState("");
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [wfRunning, setWfRunning] = useState(false);
  const [wfFinal, setWfFinal] = useState("");
  const [wfError, setWfError] = useState("");
  const wfRunId = useRef<string | null>(null);
  const seq = useRef(0);

  const usableProviders = useMemo(() => providers.filter((p) => p.enabled), [providers]);
  const effectiveProvider = usableProviders.find((p) => p.id === providerId)?.id ?? usableProviders[0]?.id ?? "";
  const effectiveWorkflow = workflows.find((w) => w.id === workflowId)?.id ?? workflows[0]?.id ?? "";

  const agentsFinal = useMemo(
    () =>
      records
        .filter((r) => r.status === "done" && r.output)
        .map((r) => r.output!)
        .join("\n\n"),
    [records]
  );

  if (usableProviders.length === 0) {
    return (
      <div className="ai-panel">
        <div className="ai-empty">
          <Wand2 size={22} />
          <p>还没有可用的大模型。</p>
          <small>请先在系统托盘的「大模型配置」中添加并启用一个模型，然后回到这里开始 AI 写作。</small>
        </div>
      </div>
    );
  }

  function track(off: () => void) {
    cleanups.current.push(off);
  }

  function runDirect() {
    if (!sloth || !directPrompt.trim() || !effectiveProvider) return;
    const requestId = crypto.randomUUID();
    directReqId.current = requestId;
    setDirectOutput("");
    setDirectError("");
    setDirectRunning(true);
    const offChunk = sloth.llm.onChunk((id, delta) => {
      if (id === requestId) setDirectOutput((o) => o + delta);
    });
    const offDone = sloth.llm.onDone((id) => {
      if (id === requestId) {
        setDirectRunning(false);
        offChunk();
        offDone();
        offErr();
      }
    });
    const offErr = sloth.llm.onError((id, error) => {
      if (id === requestId) {
        setDirectError(error);
        setDirectRunning(false);
        offChunk();
        offDone();
        offErr();
      }
    });
    track(offChunk);
    track(offDone);
    track(offErr);
    void sloth.llm.chatStream(requestId, {
      providerId: effectiveProvider,
      messages: [{ role: "user", content: directPrompt.trim() }]
    });
  }

  function toggleAgent(id: string) {
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  }

  function toggleCollapse(id: string) {
    setCollapsed((c) => {
      const next = new Set(c);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function runAgents() {
    if (!sloth || !agentsPrompt.trim() || picked.length === 0) return;
    const runId = crypto.randomUUID();
    agentsRunId.current = runId;
    setRecords(picked.map((id) => ({ id, name: agents.find((a) => a.id === id)?.name ?? id, status: "pending" })));
    setAgentsRunning(true);
    const off = sloth.llm.onAgentEvent((ev: AgentRunEvent) => {
      if (ev.runId !== runId) return;
      setRecords((rs) =>
        rs.map((r) =>
          r.id === ev.agentId
            ? {
                ...r,
                status: ev.status === "start" ? "running" : ev.status,
                output: ev.output ?? r.output,
                error: ev.error
              }
            : r
        )
      );
    });
    track(off);
    void sloth.llm
      .runAgents(runId, picked, agentsPrompt.trim())
      .catch((e) => {
        setAgentsRunning(false);
        off();
      })
      .then(() => {
        setAgentsRunning(false);
        off();
      });
  }

  function runWorkflow() {
    if (!sloth || !wfInput.trim() || !effectiveWorkflow) return;
    const runId = crypto.randomUUID();
    wfRunId.current = runId;
    setTimeline([]);
    setWfFinal("");
    setWfError("");
    setWfRunning(true);
    const off = sloth.workflows.onEvent((ev: WorkflowRunEvent) => {
      if (ev.runId !== runId) return;
      if (ev.type === "node-start") {
        seq.current += 1;
        setTimeline((t) => [...t, { key: seq.current, nodeId: ev.nodeId, label: ev.label ?? ev.nodeId ?? "节点", status: "running" }]);
      } else if (ev.type === "node-done" || ev.type === "node-error") {
        setTimeline((t) =>
          t.map((item) =>
            item.nodeId === ev.nodeId && item.status === "running"
              ? { ...item, status: ev.type === "node-done" ? "done" : "error", preview: ev.outputPreview, error: ev.error }
              : item
          )
        );
      } else if (ev.type === "run-done") {
        setWfFinal(ev.finalOutput ?? "");
        setWfRunning(false);
      } else if (ev.type === "run-error") {
        setWfError(ev.error ?? "运行失败");
        setWfRunning(false);
      }
    });
    track(off);
    void sloth.workflows
      .run(runId, effectiveWorkflow, wfInput.trim())
      .then((res) => {
        // 以返回值为最终完成依据，事件丢失也不会卡在运行中
        if (res?.error) setWfError(res.error);
        if (res?.finalOutput) setWfFinal(res.finalOutput);
        setWfRunning(false);
      })
      .catch(() => setWfRunning(false))
      .finally(() => off());
  }

  function stopWorkflow() {
    if (sloth && wfRunId.current) void sloth.workflows.stop(wfRunId.current);
  }

  return (
    <div className="ai-panel">
      <div className="segmented">
        {(
          [
            ["direct", "直接写"],
            ["agents", "多 Agent"],
            ["workflow", "工作流"]
          ] as [Mode, string][]
        ).map(([id, label]) => (
          <button key={id} className={mode === id ? "active" : ""} onClick={() => setMode(id)}>
            {label}
          </button>
        ))}
      </div>

      {mode === "direct" && (
        <div className="ai-body">
          <label className="form-row">
            <span className="form-label">大模型</span>
            <select className="text-input" value={effectiveProvider} onChange={(e) => setProviderId(e.target.value)}>
              {usableProviders.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName}
                </option>
              ))}
            </select>
          </label>
          <textarea
            className="text-input ai-prompt"
            rows={4}
            value={directPrompt}
            onChange={(e) => setDirectPrompt(e.target.value)}
            placeholder="描述你想让 AI 写的内容，例如：续写主角在雨夜抵达小镇的场景……"
          />
          <div className="ai-run-row">
            <button className="primary-button ai-run" disabled={directRunning || !directPrompt.trim()} onClick={runDirect}>
              {directRunning ? <Loader2 size={15} className="spin" /> : <Play size={15} />}
              {directRunning ? "生成中…" : "开始生成"}
            </button>
            {directRunning && (
              <button
                className="ghost-button"
                onClick={() => directReqId.current && sloth && void sloth.llm.stop(directReqId.current)}
              >
                <Square size={13} /> 停止
              </button>
            )}
          </div>
          {directError && <p className="inline-msg err">{directError}</p>}
          {(directOutput || directRunning) && (
            <>
              <div className="ai-output">{directOutput || "…"}</div>
              <InsertBar text={directOutput} canEditChapter={canEditChapter} onInsert={onInsert} />
            </>
          )}
        </div>
      )}

      {mode === "agents" && (
        <div className="ai-body">
          <span className="form-label">选择 Agent（按选择顺序执行）</span>
          <div className="agent-pick-list">
            {agents.map((a) => (
              <label key={a.id} className="agent-pick">
                <input type="checkbox" checked={picked.includes(a.id)} onChange={() => toggleAgent(a.id)} />
                <span className="agent-pick-dot" style={{ background: a.color }} />
                <strong>{a.name}</strong>
                <small>{picked.includes(a.id) ? `第 ${picked.indexOf(a.id) + 1} 步` : a.role}</small>
              </label>
            ))}
            {agents.length === 0 && <p className="model-empty">还没有 Agent，请到 Agents 页创建。</p>}
          </div>
          <textarea
            className="text-input ai-prompt"
            rows={3}
            value={agentsPrompt}
            onChange={(e) => setAgentsPrompt(e.target.value)}
            placeholder="描述任务，例如：为第三章设计大纲并写出初稿……"
          />
          <div className="ai-run-row">
            <button className="primary-button ai-run" disabled={agentsRunning || picked.length === 0 || !agentsPrompt.trim()} onClick={runAgents}>
              {agentsRunning ? <Loader2 size={15} className="spin" /> : <Play size={15} />}
              {agentsRunning ? "运行中…" : "运行"}
            </button>
            {agentsRunning && (
              <button
                className="ghost-button"
                onClick={() => agentsRunId.current && sloth && void sloth.llm.stopAgents(agentsRunId.current)}
              >
                <Square size={13} /> 停止
              </button>
            )}
          </div>
          {records.length > 0 && (
            <div className="run-list">
              {records.map((r) => (
                <div className="run-item" key={r.id}>
                  <button className="run-item-head" onClick={() => toggleCollapse(r.id)}>
                    {collapsed.has(r.id) ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                    <strong>{r.name}</strong>
                    <span className={`run-status st-${r.status}`}>
                      {r.status === "running" && <Loader2 size={12} className="spin" />}
                      {r.status === "pending" && "等待"}
                      {r.status === "running" && "进行中"}
                      {r.status === "done" && "完成"}
                      {r.status === "error" && "失败"}
                    </span>
                  </button>
                  {!collapsed.has(r.id) && (r.output || r.error) && (
                    <div className={`run-output ${r.status === "error" ? "is-error" : ""}`}>{r.error ?? r.output}</div>
                  )}
                </div>
              ))}
            </div>
          )}
          <InsertBar text={agentsFinal} canEditChapter={canEditChapter} onInsert={onInsert} />
        </div>
      )}

      {mode === "workflow" && (
        <div className="ai-body">
          <label className="form-row">
            <span className="form-label">工作流</span>
            <select className="text-input" value={effectiveWorkflow} onChange={(e) => setWorkflowId(e.target.value)}>
              {workflows.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>
          {workflows.length === 0 && <p className="model-empty">还没有工作流，请到 Workflows 页创建。</p>}
          <textarea
            className="text-input ai-prompt"
            rows={3}
            value={wfInput}
            onChange={(e) => setWfInput(e.target.value)}
            placeholder="输入描述，例如：写一段主角与旧友重逢的对话……"
          />
          <div className="ai-run-row">
            <button className="primary-button ai-run" disabled={wfRunning || !effectiveWorkflow || !wfInput.trim()} onClick={runWorkflow}>
              {wfRunning ? <Loader2 size={15} className="spin" /> : <Play size={15} />}
              {wfRunning ? "运行中…" : "运行"}
            </button>
            {wfRunning && (
              <button className="ghost-button" onClick={stopWorkflow}>
                <Square size={13} /> 停止
              </button>
            )}
          </div>
          {wfError && <p className="inline-msg err">{wfError}</p>}
          {timeline.length > 0 && (
            <div className="wf-timeline">
              {timeline.map((item) => (
                <div className={`wf-event st-${item.status}`} key={item.key}>
                  <span className="wf-event-dot" />
                  <div className="wf-event-body">
                    <strong>{item.label}</strong>
                    <small>
                      {item.status === "running" && "进行中…"}
                      {item.status === "done" && "完成"}
                      {item.status === "error" && (item.error ?? "失败")}
                    </small>
                    {item.preview && <p className="wf-event-preview">{item.preview}</p>}
                  </div>
                </div>
              ))}
            </div>
          )}
          {wfFinal && (
            <>
              <div className="ai-output">{wfFinal}</div>
              <InsertBar text={wfFinal} canEditChapter={canEditChapter} onInsert={onInsert} />
            </>
          )}
        </div>
      )}
    </div>
  );
}
