import type { WebContents } from "electron";
import type {
  AgentProfile,
  AgentRunEvent,
  ChatMessage,
  ModelProvider,
  WorkflowDef,
  WorkflowEdge,
  WorkflowNode,
  WorkflowRunEvent
} from "../../shared/types.js";
import { chat } from "./llmClient.js";

export type GetKey = (providerId: string) => string;

const MAX_STEPS = 50;

const running = new Map<string, { stopped: boolean; controller: AbortController | null }>();

export function stopRun(runId: string): void {
  const entry = running.get(runId);
  if (entry) {
    entry.stopped = true;
    entry.controller?.abort();
  }
}

function sendEvent(webContents: WebContents, ev: WorkflowRunEvent): void {
  if (!webContents.isDestroyed()) {
    webContents.send("workflow:event", ev);
  }
}

function evalCondition(expr: string, output: string, context: Record<string, unknown>): boolean {
  try {
    const fn = new Function("output", "context", `return (${expr});`) as (
      o: string,
      c: Record<string, unknown>
    ) => unknown;
    return Boolean(fn(output, context));
  } catch {
    return false;
  }
}

function interpolate(
  template: string,
  input: string,
  outputs: Map<string, string>,
  labelToId?: Map<string, string>
): string {
  return template
    .replace(/\{\{\s*input\s*\}\}/g, input)
    .replace(/\{\{\s*nodes\.([^.]+?)\.output\s*\}\}/g, (_m, key: string) => {
      const k = key.trim();
      return outputs.get(k) ?? outputs.get(labelToId?.get(k) ?? "") ?? "";
    });
}

function pickProvider(providers: ModelProvider[], preferredId?: string | null): ModelProvider {
  if (preferredId) {
    const found = providers.find((p) => p.id === preferredId);
    if (found) return found;
  }
  const enabled = providers.find((p) => p.enabled);
  if (!enabled) throw new Error("没有可用的大模型配置，请先在设置中启用一个模型");
  return enabled;
}

export async function run(
  webContents: WebContents,
  runId: string,
  workflow: WorkflowDef,
  agents: AgentProfile[],
  providers: ModelProvider[],
  getKey: GetKey,
  input: string
): Promise<{ finalOutput?: string; error?: string }> {
  const state = { stopped: false, controller: null as AbortController | null };
  running.set(runId, state);

  // 每次 LLM 调用都可被 stopRun 中断
  const callChat = (
    provider: ModelProvider,
    messages: ChatMessage[],
    opts: { temperature?: number } = {}
  ): Promise<string> => {
    const controller = new AbortController();
    state.controller = controller;
    return chat(provider, getKey(provider.id), messages, { ...opts, signal: controller.signal }).finally(() => {
      if (state.controller === controller) state.controller = null;
    });
  };

  const nodeById = new Map<string, WorkflowNode>(workflow.nodes.map((n) => [n.id, n]));
  const outEdges = new Map<string, WorkflowEdge[]>();
  for (const edge of workflow.edges) {
    const list = outEdges.get(edge.source) ?? [];
    list.push(edge);
    outEdges.set(edge.source, list);
  }

  const outputs = new Map<string, string>();
  const visits = new Map<string, number>();
  const labelToId = new Map<string, string>();
  for (const n of workflow.nodes) {
    if (n.data.label && !labelToId.has(n.data.label)) labelToId.set(n.data.label, n.id);
  }
  const context: Record<string, unknown> = { input, outputs };
  let steps = 0;
  let endOutput: string | undefined;

  const emit = (ev: Omit<WorkflowRunEvent, "runId">): void => sendEvent(webContents, { runId, ...ev });

  const runNode = async (node: WorkflowNode, upstreamOutput: string): Promise<void> => {
    if (state.stopped) return;
    if (++steps > MAX_STEPS) {
      throw new Error(`工作流执行超过 ${MAX_STEPS} 步上限，可能存在循环`);
    }

    const kind = node.data.kind;
    if (kind === "agent" || kind === "prompt") {
      const maxVisits =
        typeof node.data.maxVisits === "number" && node.data.maxVisits > 0 ? node.data.maxVisits : 3;
      const seen = (visits.get(node.id) ?? 0) + 1;
      visits.set(node.id, seen);
      if (seen > maxVisits) {
        throw new Error(
          `节点「${node.data.label}」已执行 ${maxVisits} 次（达到重试上限），流程终止。可在节点上调整「最多执行次数」。`
        );
      }
    }
    emit({ type: "node-start", nodeId: node.id, label: node.data.label });

    let output = "";
    try {
      if (kind === "note") {
        emit({ type: "node-done", nodeId: node.id, label: node.data.label, outputPreview: "" });
        return;
      } else if (kind === "start") {
        output = input;
      } else if (kind === "agent") {
        const agent = agents.find((a) => a.id === node.data.agentId);
        if (!agent) throw new Error(`节点「${node.data.label}」未绑定有效的 Agent`);
        const provider = pickProvider(providers, agent.providerId);
        const custom = node.data.contextTemplate?.trim();
        const userContent = custom
          ? interpolate(custom, input, outputs, labelToId)
          : upstreamOutput || input;
        const messages: ChatMessage[] = [
          { role: "system", content: agent.systemPrompt },
          { role: "user", content: userContent }
        ];
        output = await callChat(provider, messages, { temperature: agent.temperature });
      } else if (kind === "prompt") {
        const provider = pickProvider(providers, null);
        const text = interpolate(node.data.template ?? "", input, outputs, labelToId);
        output = await callChat(provider, [{ role: "user", content: text }]);
      } else if (kind === "end") {
        output = upstreamOutput;
        outputs.set(node.id, output);
        endOutput = output;
        emit({
          type: "node-done",
          nodeId: node.id,
          label: node.data.label,
          outputPreview: output.slice(0, 200)
        });
        return;
      } else {
        output = upstreamOutput;
      }
    } catch (err) {
      if (state.stopped) return;
      const message = err instanceof Error ? err.message : String(err);
      emit({ type: "node-error", nodeId: node.id, label: node.data.label, error: message });
      throw err;
    }

    outputs.set(node.id, output);
    emit({
      type: "node-done",
      nodeId: node.id,
      label: node.data.label,
      outputPreview: output.slice(0, 200)
    });

    const edges = outEdges.get(node.id) ?? [];
    const nexts: WorkflowNode[] = [];
    const seenTargets = new Set<string>();
    for (const edge of edges) {
      const expr = edge.data?.conditionExpr;
      if (expr) {
        if (!evalCondition(expr, output, context)) continue;
      }
      if (seenTargets.has(edge.target)) continue;
      seenTargets.add(edge.target);
      const target = nodeById.get(edge.target);
      if (target) nexts.push(target);
    }
    if (nexts.length === 1) {
      await runNode(nexts[0], output);
    } else if (nexts.length > 1) {
      // 分支并行：多个下游同时执行，全部结束后才继续汇合；任一分支失败则整体失败
      const results = await Promise.allSettled(nexts.map((n) => runNode(n, output)));
      const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
      if (failed) throw failed.reason;
    }
  };

  try {
    const start = workflow.nodes.find((n) => n.data.kind === "start");
    if (!start) throw new Error("工作流缺少 start 节点");
    await runNode(start, input);
    if (state.stopped) {
      emit({ type: "run-error", error: "已手动停止" });
      return { error: "已手动停止" };
    }
    const finalOutput = endOutput ?? [...outputs.values()].pop() ?? "";
    emit({ type: "run-done", finalOutput });
    return { finalOutput };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    emit({ type: "run-error", error });
    return { error };
  } finally {
    running.delete(runId);
  }
}

// ---- AI 生成工作流 ----

interface GeneratedWorkflow {
  nodes?: Array<Partial<WorkflowNode>>;
  edges?: Array<Partial<WorkflowEdge>>;
}

const GENERATE_SYSTEM_PROMPT = `你是一个工作流设计助手。根据用户的需求描述，设计一个节点工作流，并且只输出一个 JSON 对象，不要输出任何其他文字或解释。

JSON 格式：
{"nodes":[{"id":"字符串","type":"start|agent|prompt|end|note","position":{"x":数字,"y":数字},"data":{"kind":"start|agent|prompt|end|note","label":"节点名称","agentId":null,"template":"prompt 节点的模板文本，可使用 {{input}} 与 {{nodes.<节点id>.output}} 插值"}}],"edges":[{"id":"字符串","source":"源节点id","target":"目标节点id","data":{"line":"bezier|step|straight","color":"#颜色","conditionExpr":"可选，以 output/context 求值的 JS 表达式"},"label":"可选"}]}

规则：
- 必须恰好有一个 start 节点和至少一个 end 节点。
- agent 节点的 data.agentId 一律填 null，由用户在画布上指定。
- type 与 data.kind 必须一致。
- 节点 data.label 应起有意义的名称（如「写手」「审核」），其他节点可用 {{nodes.名称.output}} 引用它的输出。
- agent 节点可通过 data.contextTemplate 自定义上下文（支持 {{input}} 与 {{nodes.名称.output}} 插值），用于把非直接上游的内容带进来；不需要时省略该字段。
- 只输出 JSON，不要 markdown 代码围栏。`;

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1] : trimmed;
}

function parseGenerated(raw: string): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } {
  let parsed: GeneratedWorkflow;
  try {
    parsed = JSON.parse(stripCodeFence(raw)) as GeneratedWorkflow;
  } catch {
    throw new Error("LLM 返回的内容不是有效的 JSON，无法生成工作流");
  }
  if (!Array.isArray(parsed.nodes) || parsed.nodes.length === 0) {
    throw new Error("LLM 返回的 JSON 缺少 nodes 数组");
  }

  const nodes: WorkflowNode[] = parsed.nodes.map((n, i) => {
    const kind = (n.data?.kind ?? n.type ?? "note") as WorkflowNode["data"]["kind"];
    return {
      id: n.id ?? `node-${i + 1}`,
      type: n.type ?? kind,
      position:
        n.position && typeof n.position.x === "number" && typeof n.position.y === "number"
          ? n.position
          : { x: 0, y: 0 },
      data: {
        ...(n.data ?? {}),
        kind,
        label: n.data?.label ?? `节点 ${i + 1}`
      }
    };
  });

  // 缺省布局：按拓扑层级 x=列*260, y=行*140
  const needsLayout = nodes.some(
    (n) => n.position.x === 0 && n.position.y === 0 && n.data.kind !== "start"
  );
  if (needsLayout) {
    const edgesRaw = parsed.edges ?? [];
    const indegree = new Map<string, number>(nodes.map((n) => [n.id, 0]));
    const adj = new Map<string, string[]>();
    for (const e of edgesRaw) {
      if (!e.source || !e.target) continue;
      adj.set(e.source, [...(adj.get(e.source) ?? []), e.target]);
      indegree.set(e.target, (indegree.get(e.target) ?? 0) + 1);
    }
    const level = new Map<string, number>();
    const queue: string[] = nodes.filter((n) => (indegree.get(n.id) ?? 0) === 0).map((n) => n.id);
    for (const id of queue) level.set(id, 0);
    while (queue.length > 0) {
      const id = queue.shift() as string;
      for (const next of adj.get(id) ?? []) {
        const lv = Math.max(level.get(next) ?? 0, (level.get(id) ?? 0) + 1);
        level.set(next, lv);
        indegree.set(next, (indegree.get(next) ?? 1) - 1);
        if ((indegree.get(next) ?? 0) === 0) queue.push(next);
      }
    }
    const rowCount = new Map<number, number>();
    for (const node of nodes) {
      const lv = level.get(node.id) ?? 0;
      const row = rowCount.get(lv) ?? 0;
      rowCount.set(lv, row + 1);
      node.position = { x: 80 + lv * 260, y: 80 + row * 140 };
    }
  }

  const edges: WorkflowEdge[] = (parsed.edges ?? [])
    .filter((e): e is Partial<WorkflowEdge> & { source: string; target: string } =>
      Boolean(e.source && e.target)
    )
    .map((e, i) => ({
      id: e.id ?? `edge-${i + 1}`,
      source: e.source,
      target: e.target,
      ...(e.type ? { type: e.type } : {}),
      ...(e.label ? { label: e.label } : {}),
      ...(e.animated !== undefined ? { animated: e.animated } : {}),
      ...(e.style ? { style: e.style } : {}),
      ...(e.data ? { data: e.data } : {})
    }));

  return { nodes, edges };
}

export async function generate(
  provider: ModelProvider,
  getKey: GetKey,
  description: string
): Promise<{ nodes: WorkflowNode[]; edges: WorkflowEdge[] }> {
  const raw = await chat(
    provider,
    getKey(provider.id),
    [
      { role: "system", content: GENERATE_SYSTEM_PROMPT },
      { role: "user", content: description }
    ],
    { temperature: 0.4 }
  );
  return parseGenerated(raw);
}

// ---- AI 优化现有工作流 ----

const OPTIMIZE_SYSTEM_PROMPT = `你是一个工作流优化助手。用户会给你一个已有的工作流 JSON 和一段优化需求。请在理解现有结构的基础上输出调整后的完整工作流 JSON，不要输出任何其他文字或解释。

JSON 格式与输入一致：
{"nodes":[{"id":"字符串","type":"start|agent|prompt|end|note","position":{"x":数字,"y":数字},"data":{"kind":"...","label":"节点名称","agentId":"保持原值","template":"...","maxVisits":数字}}],"edges":[{"id":"字符串","source":"源节点id","target":"目标节点id","data":{"line":"bezier|step|straight","color":"#颜色","conditionExpr":"可选，以 output/context 求值的 JS 表达式"},"label":"可选"}]}

规则：
- 保留用户已有的节点 id、agent 节点的 data.agentId 绑定和 maxVisits 设置，除非用户明确要求修改。
- 必须保留恰好一个 start 节点和至少一个 end 节点。
- type 与 data.kind 必须一致。
- 节点 data.label 应起有意义的名称（如「写手」「审核」），其他节点可用 {{nodes.名称.output}} 引用它的输出。
- agent 节点可通过 data.contextTemplate 自定义上下文（支持 {{input}} 与 {{nodes.名称.output}} 插值），用于把非直接上游的内容带进来；不需要时省略该字段。
- 新增节点可以使用新的 id；position 可以复用或微调现有值。
- 只输出 JSON，不要 markdown 代码围栏。`;

export async function optimize(
  provider: ModelProvider,
  getKey: GetKey,
  current: { nodes: WorkflowNode[]; edges: WorkflowEdge[] },
  instruction: string
): Promise<{ nodes: WorkflowNode[]; edges: WorkflowEdge[] }> {
  const slim = {
    nodes: current.nodes.map((n) => ({ id: n.id, type: n.type, position: n.position, data: n.data })),
    edges: current.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      label: e.label,
      data: e.data
    }))
  };
  const raw = await chat(
    provider,
    getKey(provider.id),
    [
      { role: "system", content: OPTIMIZE_SYSTEM_PROMPT },
      {
        role: "user",
        content: `当前工作流：\n${JSON.stringify(slim, null, 2)}\n\n优化需求：${instruction}`
      }
    ],
    { temperature: 0.4 }
  );
  return parseGenerated(raw);
}

// ---- 多 Agent 顺序执行 ----

function sendAgentEvent(webContents: WebContents, ev: AgentRunEvent): void {
  if (!webContents.isDestroyed()) {
    webContents.send("llm:agentEvent", ev);
  }
}

export async function runAgents(
  webContents: WebContents,
  runId: string,
  agentIds: string[],
  agents: AgentProfile[],
  providers: ModelProvider[],
  getKey: GetKey,
  input: string
): Promise<void> {
  const state = { stopped: false, controller: null as AbortController | null };
  running.set(runId, state);
  const priorOutputs: Array<{ name: string; output: string }> = [];

  try {
    for (const agentId of agentIds) {
      if (state.stopped) break;
      const agent = agents.find((a) => a.id === agentId);
      if (!agent) {
        sendAgentEvent(webContents, {
          runId,
          agentId,
          agentName: agentId,
          status: "error",
          error: "Agent 不存在"
        });
        continue;
      }
      sendAgentEvent(webContents, { runId, agentId, agentName: agent.name, status: "start" });
      try {
        const provider = pickProvider(providers, agent.providerId);
        const summary = priorOutputs
          .map((p) => `【${p.name} 的输出】\n${p.output}`)
          .join("\n\n");
        const userContent = summary ? `${input}\n\n前序参考：\n${summary}` : input;
        const controller = new AbortController();
        state.controller = controller;
        const output = await chat(
          provider,
          getKey(provider.id),
          [
            { role: "system", content: agent.systemPrompt },
            { role: "user", content: userContent }
          ],
          { temperature: agent.temperature, signal: controller.signal }
        ).finally(() => {
          if (state.controller === controller) state.controller = null;
        });
        priorOutputs.push({ name: agent.name, output });
        sendAgentEvent(webContents, { runId, agentId, agentName: agent.name, status: "done", output });
      } catch (err) {
        if (state.stopped) break;
        sendAgentEvent(webContents, {
          runId,
          agentId,
          agentName: agent.name,
          status: "error",
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }
  } finally {
    running.delete(runId);
  }
}
