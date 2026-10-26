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
import * as novelFs from "./novelFs.js";
import * as proposals from "./proposals.js";

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
  labelToId?: Map<string, string>,
  memory?: Map<string, string>
): string {
  return template
    .replace(/\{\{\s*input\s*\}\}/g, input)
    .replace(/\{\{\s*nodes\.([^.]+?)\.output\s*\}\}/g, (_m, key: string) => {
      const k = key.trim();
      return outputs.get(k) ?? outputs.get(labelToId?.get(k) ?? "") ?? "";
    })
    .replace(/\{\{\s*memory\.(.+?)\s*\}\}/g, (_m, key: string) => memory?.get(key.trim()) ?? "");
}

// 扫描模板中的 {{memory.xxx}} 引用（xxx 为 memory/ 下的相对路径，可不带 .md）
const MEMORY_REF_RE = /\{\{\s*memory\.(.+?)\s*\}\}/g;

// 解析 autoProposal 节点的输出为结构化提案并创建到待审核（不自动应用）
interface RawProposal {
  targetFile?: string;
  summary?: string;
  reason?: string;
  content?: string;
  proposedContent?: string;
}

function createProposalsFromOutput(projectId: string, output: string): { created: number; error?: string } {
  const trimmed = output.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  let text = fenced ? fenced[1] : trimmed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // 宽容提取：从混合文本中截取第一个 [ 到最后一个 ] 再解析
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start >= 0 && end > start) {
      try {
        parsed = JSON.parse(text.slice(start, end + 1));
      } catch {
        return { created: 0, error: "提案节点输出不是可解析的 JSON 数组" };
      }
    } else {
      return { created: 0, error: "提案节点输出不是可解析的 JSON 数组" };
    }
  }
  const items: RawProposal[] = Array.isArray(parsed)
    ? (parsed as RawProposal[])
    : Array.isArray((parsed as { proposals?: RawProposal[] }).proposals)
      ? (parsed as { proposals: RawProposal[] }).proposals
      : [];
  if (items.length === 0) return { created: 0, error: "提案 JSON 为空或结构不符" };
  let created = 0;
  for (const item of items) {
    if (!item || typeof item.targetFile !== "string") continue;
    const content = item.proposedContent ?? item.content;
    if (typeof content !== "string" || !content.trim()) continue;
    const targetFile = item.targetFile.endsWith(".md") ? item.targetFile : `${item.targetFile}.md`;
    try {
      proposals.create(projectId, {
        targetFile,
        summary: (item.summary ?? "工作流记忆更新提案").slice(0, 120),
        reason: (item.reason ?? "").slice(0, 500),
        proposedContent: content
      });
      created++;
    } catch {
      // 单条失败不阻塞其余提案
    }
  }
  return created > 0 ? { created } : { created: 0, error: "提案条目缺少 targetFile 或 content" };
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
  input: string,
  projectId?: string
): Promise<{ finalOutput?: string; error?: string; proposalsCreated?: number }> {
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
  const inEdges = new Map<string, string[]>();
  for (const edge of workflow.edges) {
    const list = outEdges.get(edge.source) ?? [];
    list.push(edge);
    outEdges.set(edge.source, list);
    const ins = inEdges.get(edge.target) ?? [];
    ins.push(edge.source);
    inEdges.set(edge.target, ins);
  }

  // 每个节点的下游可达集合（用于识别循环回边：目标能到达的父节点 = 环上的父节点，汇合等待时不算它）
  const reachableCache = new Map<string, Set<string>>();
  const reachableFrom = (id: string): Set<string> => {
    const cached = reachableCache.get(id);
    if (cached) return cached;
    const seen = new Set<string>();
    const stack = [...(outEdges.get(id) ?? []).map((e) => e.target)];
    while (stack.length) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const e of outEdges.get(cur) ?? []) stack.push(e.target);
    }
    reachableCache.set(id, seen);
    return seen;
  };

  // 汇合（join）语义：多入边节点等所有非循环父节点「结算」（完成或条件不满足）后才执行一次
  const settledBy = new Map<string, Set<string>>();
  const markSettled = (targetId: string, parentId: string): void => {
    const s = settledBy.get(targetId) ?? new Set<string>();
    s.add(parentId);
    settledBy.set(targetId, s);
  };
  // 正在执行中的节点：并行分支未跑完时，汇合点要等待，不能提前触发
  const inFlight = new Set<string>();

  const outputs = new Map<string, string>();
  const visits = new Map<string, number>();
  const labelToId = new Map<string, string>();
  for (const n of workflow.nodes) {
    if (n.data.label && !labelToId.has(n.data.label)) labelToId.set(n.data.label, n.id);
  }
  // 兜底：agent 节点也可用所绑 Agent 的名字引用（如 {{nodes.小说写手.output}}）
  for (const n of workflow.nodes) {
    if (n.data.kind !== "agent" || !n.data.agentId) continue;
    const agent = agents.find((a) => a.id === n.data.agentId);
    if (agent && !labelToId.has(agent.name)) labelToId.set(agent.name, n.id);
  }
  const context: Record<string, unknown> = { input, outputs };
  const visitsCtx: Record<string, number> = {}; // 节点执行次数（按 id 和 label 双键），条件表达式可用 context.visits['节点名']
  context.visits = visitsCtx;
  let steps = 0;
  let endOutput: string | undefined;
  let proposalsCreated = 0;
  let proposalsError: string | undefined;
  const startedAt = Date.now();
  const memoryRefs: string[] = [];

  // 记忆快照：运行前扫描所有节点模板里的 {{memory.xxx}}，一次性从项目目录读入
  const memory = new Map<string, string>();
  if (projectId) {
    const refs = new Set<string>();
    for (const n of workflow.nodes) {
      for (const tpl of [n.data.template, n.data.contextTemplate]) {
        if (!tpl) continue;
        for (const m of tpl.matchAll(MEMORY_REF_RE)) refs.add(m[1].trim());
      }
    }
    for (const ref of refs) {
      const rel = ref.endsWith(".md") ? ref : `${ref}.md`;
      try {
        memory.set(ref, novelFs.memoryRead(projectId, rel));
        memoryRefs.push(rel);
      } catch {
        memory.set(ref, "");
      }
    }
  }

  // 项目内运行时落盘运行记录（不含任何密钥信息）
  const writeRecord = (status: "done" | "error" | "stopped", error?: string): void => {
    if (!projectId) return;
    const final = endOutput ?? [...outputs.values()].pop() ?? "";
    const artifactRel = novelFs.writeRunArtifact(projectId, workflow.name, startedAt, final, status, error);
    novelFs.writeRunRecord(projectId, {
      runId,
      workflowId: workflow.id,
      workflowName: workflow.name,
      projectId,
      startedAt,
      endedAt: Date.now(),
      status,
      ...(error ? { error } : {}),
      steps,
      memoryRefs,
      outputPreview: final.slice(0, 200),
      finalOutput: final,
      ...(artifactRel ? { artifactPath: artifactRel } : {})
    });
  };

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
      visitsCtx[node.id] = seen;
      if (node.data.label) visitsCtx[node.data.label] = seen;
      if (seen > maxVisits) {
        throw new Error(
          `节点「${node.data.label}」已执行 ${maxVisits} 次（达到重试上限），流程终止。可在节点上调整「最多执行次数」。`
        );
      }
    }
    emit({ type: "node-start", nodeId: node.id, label: node.data.label });
    inFlight.add(node.id);

    let output = "";
    try {
      if (kind === "note") {
        inFlight.delete(node.id);
        emit({ type: "node-done", nodeId: node.id, label: node.data.label, outputPreview: "" });
        return;
      } else if (kind === "start") {
        output = input;
      } else if (kind === "agent") {
        const agent = agents.find((a) => a.id === node.data.agentId);
        if (!agent) throw new Error(`节点「${node.data.label}」未绑定有效的 Agent`);
        // 模型优先级：工作流指定 > Agent 绑定 > 第一个启用的模型
        const wfProvider = workflow.providerId
          ? providers.find((p) => p.id === workflow.providerId) ?? null
          : null;
        const provider = wfProvider ?? pickProvider(providers, agent.providerId);
        const custom = node.data.contextTemplate?.trim();
        const userContent = custom
          ? interpolate(custom, input, outputs, labelToId, memory)
          : upstreamOutput || input;
        const messages: ChatMessage[] = [
          { role: "system", content: agent.systemPrompt },
          { role: "user", content: userContent }
        ];
        output = await callChat(provider, messages, { temperature: agent.temperature });
      } else if (kind === "prompt") {
        const provider = (workflow.providerId ? providers.find((p) => p.id === workflow.providerId) : null) ?? pickProvider(providers, null);
        const text = interpolate(node.data.template ?? "", input, outputs, labelToId, memory);
        output = await callChat(provider, [{ role: "user", content: text }]);
      } else if (kind === "end") {
        output = upstreamOutput;
        outputs.set(node.id, output);
        endOutput = output;
        // 结束节点也可自动转提案（用最终输出解析）
        if (node.data.autoProposal && projectId && output.trim()) {
          const res = createProposalsFromOutput(projectId, output);
          proposalsCreated += res.created;
          if (res.error) proposalsError = res.error;
        }
        inFlight.delete(node.id);
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
      inFlight.delete(node.id);
      if (state.stopped) return;
      const message = err instanceof Error ? err.message : String(err);
      emit({ type: "node-error", nodeId: node.id, label: node.data.label, error: message });
      throw err;
    }

    outputs.set(node.id, output);
    inFlight.delete(node.id);
    emit({
      type: "node-done",
      nodeId: node.id,
      label: node.data.label,
      outputPreview: output.slice(0, 200),
      output
    });

    // autoProposal 节点：输出解析为结构化提案，自动创建到待审核（不自动应用）
    if (node.data.autoProposal && projectId && output.trim()) {
      const res = createProposalsFromOutput(projectId, output);
      proposalsCreated += res.created;
      if (res.error) proposalsError = res.error;
    }

    const edges = outEdges.get(node.id) ?? [];
    const taken: WorkflowNode[] = [];
    const seenTargets = new Set<string>();
    for (const edge of edges) {
      const target = nodeById.get(edge.target);
      if (!target || seenTargets.has(target.id)) continue;
      seenTargets.add(target.id);
      const expr = edge.data?.conditionExpr;
      const pass = expr ? evalCondition(expr, output, context) : true;
      // 无论条件是否满足，该父节点对此目标都算「已结算」（不满足 = 此分支不走）
      markSettled(target.id, node.id);
      if (pass) taken.push(target);
    }
    const trigger = (t: WorkflowNode): Promise<void> => {
      const parentsAll = inEdges.get(t.id) ?? [node.id];
      if (parentsAll.length <= 1) return runNode(t, output);
      const downstream = reachableFrom(t.id);
      const required = parentsAll.filter((p) => !downstream.has(p));
      const settled = settledBy.get(t.id);
      const parentInFlight = parentsAll.some((p) => inFlight.has(p));
      if (!parentInFlight && required.every((p) => settled?.has(p))) return runNode(t, output);
      return Promise.resolve(); // 还有父节点在执行中或未结算，等待它们完成后再触发
    };
    if (taken.length === 1) {
      await trigger(taken[0]);
    } else if (taken.length > 1) {
      // 分支并行：多个下游同时执行，全部结束后才继续汇合；任一分支失败则整体失败
      const results = await Promise.allSettled(taken.map((n) => trigger(n)));
      const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
      if (failed) throw failed.reason;
    }
  };

  try {
    const start = workflow.nodes.find((n) => n.data.kind === "start");
    if (!start) throw new Error("工作流缺少 start 节点");
    await runNode(start, input);
    if (state.stopped) {
      writeRecord("stopped", "已手动停止");
      emit({ type: "run-error", error: "已手动停止" });
      return { error: "已手动停止" };
    }
    const finalOutput = endOutput ?? [...outputs.values()].pop() ?? "";
    writeRecord("done");
    emit({ type: "run-done", finalOutput });
    return { finalOutput, proposalsCreated, ...(proposalsError ? { proposalsError } : {}) };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    writeRecord("error", error);
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
{"nodes":[{"id":"字符串","type":"start|agent|prompt|end|note","position":{"x":数字,"y":数字},"data":{"kind":"start|agent|prompt|end|note","label":"节点名称","agentId":null,"template":"prompt 节点的模板文本，可使用 {{input}} 与 {{nodes.<节点id>.output}} 插值"}}],"edges":[{"id":"字符串","source":"源节点id","target":"目标节点id","data":{"line":"bezier|step|straight","color":"#颜色","conditionExpr":"可选，以 output/context 求值的 JS 表达式，context.visits['节点名'] 可取该节点已执行次数（用于返修上限优雅退出）"},"label":"可选"}]}

规则：
- 必须恰好有一个 start 节点和至少一个 end 节点。
- agent 节点的 data.agentId 一律填 null，由用户在画布上指定。
- type 与 data.kind 必须一致。
- 节点 data.label 应起有意义的名称（如「写手」「审核」），其他节点可用 {{nodes.名称.output}} 引用它的输出。
- agent 节点可通过 data.contextTemplate 自定义上下文（支持 {{input}}、{{nodes.名称.output}}、{{memory.记忆文件名}} 插值），用于把非直接上游的内容带进来；不需要时省略该字段。
- 一个节点可以有多个入边：它会等所有非循环父节点都完成后才执行一次（并行分支的汇合），用 contextTemplate 引用各父节点输出。
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
{"nodes":[{"id":"字符串","type":"start|agent|prompt|end|note","position":{"x":数字,"y":数字},"data":{"kind":"...","label":"节点名称","agentId":"保持原值","template":"...","maxVisits":数字}}],"edges":[{"id":"字符串","source":"源节点id","target":"目标节点id","data":{"line":"bezier|step|straight","color":"#颜色","conditionExpr":"可选，以 output/context 求值的 JS 表达式，context.visits['节点名'] 可取该节点已执行次数（用于返修上限优雅退出）"},"label":"可选"}]}

规则：
- 保留用户已有的节点 id、agent 节点的 data.agentId 绑定和 maxVisits 设置，除非用户明确要求修改。
- 必须保留恰好一个 start 节点和至少一个 end 节点。
- type 与 data.kind 必须一致。
- 节点 data.label 应起有意义的名称（如「写手」「审核」），其他节点可用 {{nodes.名称.output}} 引用它的输出。
- agent 节点可通过 data.contextTemplate 自定义上下文（支持 {{input}}、{{nodes.名称.output}}、{{memory.记忆文件名}} 插值），用于把非直接上游的内容带进来；不需要时省略该字段。
- 一个节点可以有多个入边：它会等所有非循环父节点都完成后才执行一次（并行分支的汇合），用 contextTemplate 引用各父节点输出。
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
