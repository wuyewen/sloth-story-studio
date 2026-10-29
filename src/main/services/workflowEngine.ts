import type { WebContents } from "electron";
import crypto from "node:crypto";
import type {
  AgentProfile,
  AgentRunEvent,
  ChatMessage,
  ModelProvider,
  NodeRunRecord,
  RunUsage,
  WorkflowDef,
  WorkflowEdge,
  WorkflowNode,
  WorkflowRunEvent
} from "../../shared/types.js";
import { CONTEXT_DEFAULT_SOURCES, CONTEXT_SOURCES, REVIEW_DIMENSIONS } from "../../shared/types.js";
import { chat } from "./llmClient.js";
import type { ChatUsage } from "./llmClient.js";
import { evalConditionExpr, isSafeCondition } from "./condExpr.js";
import * as novelFs from "./novelFs.js";
import * as proposals from "./proposals.js";
import * as styleStore from "./styleStore.js";

export type GetKey = (providerId: string) => string;

const MAX_STEPS = 50;

// F-05：工作流定义哈希（{nodes, edges} 稳定序列化的 sha256），断点续跑时校验工作流未被修改
export function computeWorkflowHash(workflow: WorkflowDef): string {
  const stable = JSON.stringify({ nodes: workflow.nodes, edges: workflow.edges });
  return crypto.createHash("sha256").update(stable, "utf-8").digest("hex");
}

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

// 条件表达式走白名单安全求值器（F-01）：不支持的形态拒绝执行（返回 false 并告警）
function evalCondition(expr: string, output: string, context: Record<string, unknown>): boolean {
  try {
    return evalConditionExpr(expr, output, context);
  } catch (err) {
    console.warn(
      `[workflowEngine] 条件表达式被安全求值器拒绝，按不通过处理: ${expr.slice(0, 120)} — ${err instanceof Error ? err.message : String(err)}`
    );
    return false;
  }
}

function interpolate(
  template: string,
  input: string,
  outputs: Map<string, string>,
  labelToId?: Map<string, string>,
  memory?: Map<string, string>,
  style?: Map<string, string>
): string {
  return template
    .replace(/\{\{\s*input\s*\}\}/g, input)
    .replace(/\{\{\s*nodes\.([^.]+?)\.output\s*\}\}/g, (_m, key: string) => {
      const k = key.trim();
      return outputs.get(k) ?? outputs.get(labelToId?.get(k) ?? "") ?? "";
    })
    .replace(/\{\{\s*memory\.(.+?)\s*\}\}/g, (_m, key: string) => memory?.get(key.trim()) ?? "")
    .replace(/\{\{\s*style\.(.+?)\s*\}\}/g, (_m, key: string) => style?.get(key.trim()) ?? "");
}

// 扫描模板中的 {{memory.xxx}} 引用（xxx 为 memory/ 下的相对路径，可不带 .md）
const MEMORY_REF_RE = /\{\{\s*memory\.(.+?)\s*\}\}/g;

// 解析 autoProposal 节点的输出为结构化提案并创建到待审核（不自动应用）
// 契约校验：输出必须是合法 JSON 数组（宽容剥 ```json 围栏），元素必须含 targetFile 与 content/proposedContent，违反则抛出带诊断信息的错误
interface RawProposal {
  targetFile?: string;
  summary?: string;
  reason?: string;
  content?: string;
  proposedContent?: string;
}

function createProposalsFromOutput(projectId: string, output: string, nodeLabel: string): { created: number } {
  const trimmed = output.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const text = fenced ? fenced[1] : trimmed;
  const notJsonArray = () =>
    new Error(
      `节点「${nodeLabel}」开启了自动转提案，但输出不是有效的 JSON 数组。输出前 200 字：${output.slice(0, 200)}`
    );
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
        throw notJsonArray();
      }
    } else {
      throw notJsonArray();
    }
  }
  const items: RawProposal[] = Array.isArray(parsed)
    ? (parsed as RawProposal[])
    : Array.isArray((parsed as { proposals?: RawProposal[] }).proposals)
      ? (parsed as { proposals: RawProposal[] }).proposals
      : [];
  if (items.length === 0) {
    throw new Error(`节点「${nodeLabel}」开启了自动转提案，但输出的 JSON 数组为空或结构不符（需要提案对象数组）。`);
  }
  // 逐条校验必填字段，一次性列出所有问题
  const problems: string[] = [];
  items.forEach((item, i) => {
    const missing: string[] = [];
    if (!item || typeof item.targetFile !== "string" || !item.targetFile.trim()) missing.push("targetFile");
    const content = item?.proposedContent ?? item?.content;
    if (typeof content !== "string" || !content.trim()) missing.push("content");
    if (missing.length > 0) problems.push(`第 ${i + 1} 个元素缺少 ${missing.join("、")} 字段`);
  });
  if (problems.length > 0) {
    throw new Error(`节点「${nodeLabel}」的提案 JSON 校验未通过：${problems.join("；")}。`);
  }
  let created = 0;
  for (const item of items) {
    const content = (item.proposedContent ?? item.content) as string;
    const targetFile = item.targetFile!.endsWith(".md") ? item.targetFile! : `${item.targetFile}.md`;
    try {
      proposals.create(projectId, {
        targetFile,
        summary: (item.summary ?? "工作流记忆更新提案").slice(0, 120),
        reason: (item.reason ?? "").slice(0, 500),
        proposedContent: content
      });
      created++;
    } catch {
      // 单条写入失败不阻塞其余提案
    }
  }
  return { created };
}

// ---- 结构化审核节点（kind: review）----

function reviewSystemPrompt(dimensions: string[]): string {
  return `你是一位严谨的审稿总编。只针对以下审核维度审查用户给出的文本：${dimensions.join("、")}。
输出纯 JSON（不要 markdown 代码围栏、不要任何解释）：
{"verdict":"pass"|"revise","issues":[{"category":"维度名","severity":"blocker"|"major"|"minor","evidence":"原文证据片段","explanation":"问题原因","suggestedFix":"具体修复建议","quote":"需要修改的原文句子或段落（逐字摘自原文，供局部修订定位）"}]}
规则：
- 只有不存在 blocker 级阻断问题时 verdict 才允许为 "pass"，否则必须为 "revise"。
- 每个 issue 必须含 quote，且 quote 必须逐字摘自原文，不得改写。
- 没有问题就输出 {"verdict":"pass","issues":[]}。
- 只输出 JSON。`;
}

interface ReviewIssue {
  category: string;
  severity: "blocker" | "major" | "minor";
  evidence: string;
  explanation: string;
  suggestedFix: string;
  quote: string;
}

// 校验并规范化审核节点输出；不合法则抛出带诊断信息的错误
function validateReviewOutput(label: string, raw: string): string {
  const text = stripCodeFence(raw).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`审核节点「${label}」输出不是有效 JSON，前 200 字：${raw.slice(0, 200)}`);
  }
  const obj = parsed as { verdict?: unknown; issues?: unknown };
  if (obj.verdict !== "pass" && obj.verdict !== "revise") {
    throw new Error(`审核节点「${label}」输出的 verdict 必须是 "pass" 或 "revise"，实际：${String(obj.verdict)}`);
  }
  const rawIssues = obj.issues === undefined ? [] : obj.issues;
  if (!Array.isArray(rawIssues)) {
    throw new Error(`审核节点「${label}」输出的 issues 必须是数组`);
  }
  const problems: string[] = [];
  const issues: ReviewIssue[] = rawIssues.map((it, i) => {
    const o = (it ?? {}) as Record<string, unknown>;
    const missing = ["category", "severity", "evidence", "explanation", "suggestedFix", "quote"].filter(
      (k) => typeof o[k] !== "string" || !(o[k] as string).trim()
    );
    if (missing.length > 0) {
      problems.push(`第 ${i + 1} 个 issue 缺少 ${missing.join("、")} 字段`);
    }
    const severity = typeof o.severity === "string" ? o.severity : "";
    if (severity && !["blocker", "major", "minor"].includes(severity)) {
      problems.push(`第 ${i + 1} 个 issue 的 severity 非法（${severity}），应为 blocker|major|minor`);
    }
    return {
      category: String(o.category ?? ""),
      severity: (["blocker", "major", "minor"].includes(severity) ? severity : "major") as ReviewIssue["severity"],
      evidence: String(o.evidence ?? ""),
      explanation: String(o.explanation ?? ""),
      suggestedFix: String(o.suggestedFix ?? ""),
      quote: String(o.quote ?? "")
    };
  });
  if (problems.length > 0) {
    throw new Error(`审核节点「${label}」的 issues 校验未通过：${problems.join("；")}。`);
  }
  return JSON.stringify({ verdict: obj.verdict, issues });
}

// ---- 局部修订节点（kind: patch）----

const PATCH_SYSTEM_PROMPT = `你是文本修订助手。根据审核结果 JSON 中的 issues，为每条需要修改的问题输出替换对。只输出一个 JSON 数组（不要 markdown 代码围栏、不要任何解释）：
[{"old":"逐字摘自原文的片段","new":"修改后的文本"}]
规则：
- old 必须逐字摘自原文（优先使用 issue 的 quote 字段），不得改写、不得包含原文之外的内容。
- 只修改 issues 指出的问题，不做任何其他改动。
- verdict 为 pass 或没有需要修改的问题时，输出空数组 []。`;

interface PatchPair {
  old: string;
  new: string;
}

function parsePatchPairs(label: string, raw: string): PatchPair[] {
  const text = stripCodeFence(raw).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`局部修订节点「${label}」输出不是有效 JSON 数组，前 200 字：${raw.slice(0, 200)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`局部修订节点「${label}」输出不是有效 JSON 数组，前 200 字：${raw.slice(0, 200)}`);
  }
  return (parsed as Array<Record<string, unknown>>)
    .filter((p) => p && typeof p.old === "string" && typeof p.new === "string" && p.old.length > 0)
    .map((p) => ({ old: p.old as string, new: p.new as string }));
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
  projectId?: string,
  replayOutputs?: Record<string, string> // 断点续跑：key 为 `${nodeId}#${attempt}`，命中则复用输出、跳过 LLM 调用
): Promise<{ finalOutput?: string; error?: string; proposalsCreated?: number }> {
  const state = { stopped: false, controller: null as AbortController | null };
  running.set(runId, state);

  // 每次 LLM 调用都可被 stopRun 中断；同时累加 run 级 token 用量；支持单次调用超时（FR-09）
  const runUsage: RunUsage = { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, unknown: false };
  const budget = workflow.budget;
  let budgetExceeded = false; // 调用后检查：累计 token 已超出上限（F-07，写入运行记录）
  const callTimeoutSec =
    budget?.callTimeoutSec && budget.callTimeoutSec > 0 ? budget.callTimeoutSec : 0;
  const callChat = (
    provider: ModelProvider,
    messages: ChatMessage[],
    opts: { temperature?: number; onUsage?: (usage: ChatUsage) => void } = {}
  ): Promise<string> => {
    const controller = new AbortController();
    state.controller = controller;
    let timedOut = false;
    const timer =
      callTimeoutSec > 0
        ? setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, callTimeoutSec * 1000)
        : null;
    let gotUsage = false;
    return chat(provider, getKey(provider.id), messages, {
      ...opts,
      signal: controller.signal,
      onUsage: (u) => {
        gotUsage = true;
        runUsage.promptTokens += u.promptTokens ?? 0;
        runUsage.completionTokens += u.completionTokens ?? 0;
        runUsage.totalTokens += u.totalTokens ?? 0;
        opts.onUsage?.(u);
      }
    })
      .then((content) => {
        runUsage.calls += 1;
        if (!gotUsage) runUsage.unknown = true;
        // 调用后检查（F-07）：本次返回后累计已超 token 上限 → 记入运行记录；后续节点会被调用前 guard 拦住
        if (budget?.maxTokens && budget.maxTokens > 0 && !runUsage.unknown && runUsage.totalTokens > budget.maxTokens) {
          budgetExceeded = true;
        }
        return content;
      })
      .catch((err) => {
        if (timedOut) throw new Error(`调用超时（${callTimeoutSec} 秒），模型未及时响应`);
        throw err;
      })
      .finally(() => {
        if (timer) clearTimeout(timer);
        if (state.controller === controller) state.controller = null;
      });
  };

  // 预算检查（FR-09）：每个 LLM 节点发起调用前调用；超限即抛错，走 node-error/run-error 通道
  const checkBudget = (): void => {
    if (!budget) return;
    if (budget.maxCalls && budget.maxCalls > 0 && runUsage.calls >= budget.maxCalls) {
      throw new Error(
        `已达本次运行预算上限（模型调用 ${budget.maxCalls} 次），流程已安全停止。已完成节点的结果已保存，可从运行记录「从断点继续」恢复。`
      );
    }
    if (budget.maxTokens && budget.maxTokens > 0 && !runUsage.unknown && runUsage.totalTokens >= budget.maxTokens) {
      throw new Error(
        `已达本次运行预算上限（token ${budget.maxTokens}），流程已安全停止。已完成节点的结果已保存，可从运行记录「从断点继续」恢复。`
      );
    }
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
  const startedAt = Date.now();
  const memoryRefs: string[] = [];
  const nodeRuns: NodeRunRecord[] = []; // 节点级执行记录（仅 agent/prompt 节点）

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

  // 风格模板上下文（FR-06）：项目绑定风格时构建 {{style.*}} 插值表，并注入审核节点
  const styleProfile = projectId ? styleStore.get(novelFs.projectStyleId(projectId) ?? "") : null;
  const styleCtx = styleStore.styleContextMap(styleProfile);
  const styleFull = styleCtx.get("full") ?? "";

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
      input,
      workflowHash: computeWorkflowHash(workflow), // F-05：续跑时校验工作流未被修改
      outputPreview: final.slice(0, 200),
      finalOutput: final,
      ...(artifactRel ? { artifactPath: artifactRel } : {}),
      nodeRuns,
      ...(runUsage.calls > 0 ? { usage: runUsage } : {}),
      ...(budgetExceeded ? { budgetExceeded: true } : {})
    });
  };

  const emit = (ev: Omit<WorkflowRunEvent, "runId">): void => sendEvent(webContents, { runId, ...ev });

  const runNode = async (node: WorkflowNode, upstreamOutput: string): Promise<void> => {
    if (state.stopped) return;
    if (++steps > MAX_STEPS) {
      throw new Error(`工作流执行超过 ${MAX_STEPS} 步上限，可能存在循环`);
    }

    const kind = node.data.kind;
    // LLM 类节点：计执行次数、走节点级记录与断点重放；context 节点不调 LLM 但同样计数与记录
    const isLlmNode = kind === "agent" || kind === "prompt" || kind === "review" || kind === "patch";
    const isRecorded = isLlmNode || kind === "context";
    let attempt = 0;
    if (isRecorded) {
      const maxVisits =
        typeof node.data.maxVisits === "number" && node.data.maxVisits > 0 ? node.data.maxVisits : 3;
      const seen = (visits.get(node.id) ?? 0) + 1;
      visits.set(node.id, seen);
      visitsCtx[node.id] = seen;
      if (node.data.label) visitsCtx[node.data.label] = seen;
      attempt = seen;
      if (seen > maxVisits) {
        throw new Error(
          `节点「${node.data.label}」已执行 ${maxVisits} 次（达到重试上限），流程终止。可在节点上调整「最多执行次数」。`
        );
      }
    }
    emit({ type: "node-start", nodeId: node.id, label: node.data.label });
    inFlight.add(node.id);

    // 节点级可观测性：记录 LLM 类节点与 context 组装节点
    const recordable = isRecorded;
    const recStartedAt = Date.now();
    let recInput = "";
    let recModel: string | undefined;
    let recUsage: ChatUsage | undefined;
    let recReplayed = false;
    let recNote: string | undefined; // 成功但有需要说明的情况（如局部修订部分替换未定位）
    let recContextRefs: { source: string; chars: number }[] | undefined; // context 节点：实际包含的来源

    let output = "";
    try {
      if (kind === "note") {
        inFlight.delete(node.id);
        emit({ type: "node-done", nodeId: node.id, label: node.data.label, outputPreview: "" });
        return;
      } else if (kind === "start") {
        output = input;
      } else if (kind === "agent") {
        const custom = node.data.contextTemplate?.trim();
        const userContent = custom
          ? interpolate(custom, input, outputs, labelToId, memory, styleCtx)
          : upstreamOutput || input;
        recInput = userContent;
        // 断点续跑：该节点该次数上次已成功，直接复用输出、跳过 LLM 调用
        const replay = replayOutputs?.[`${node.id}#${attempt}`];
        if (replay !== undefined) {
          output = replay;
          recReplayed = true;
        } else {
          const agent = agents.find((a) => a.id === node.data.agentId);
          if (!agent) throw new Error(`节点「${node.data.label}」未绑定有效的 Agent`);
          // 模型优先级：工作流指定 > Agent 绑定 > 第一个启用的模型
          const wfProvider = workflow.providerId
            ? providers.find((p) => p.id === workflow.providerId) ?? null
            : null;
          const provider = wfProvider ?? pickProvider(providers, agent.providerId);
          recModel = provider.displayName || provider.model;
          const messages: ChatMessage[] = [
            { role: "system", content: agent.systemPrompt },
            { role: "user", content: userContent }
          ];
          checkBudget();
          output = await callChat(provider, messages, {
            temperature: agent.temperature,
            onUsage: (u) => {
              recUsage = u;
            }
          });
        }
      } else if (kind === "prompt") {
        const text = interpolate(node.data.template ?? "", input, outputs, labelToId, memory, styleCtx);
        recInput = text;
        // 断点续跑：该节点该次数上次已成功，直接复用输出、跳过 LLM 调用
        const replay = replayOutputs?.[`${node.id}#${attempt}`];
        if (replay !== undefined) {
          output = replay;
          recReplayed = true;
        } else {
          const provider = (workflow.providerId ? providers.find((p) => p.id === workflow.providerId) : null) ?? pickProvider(providers, null);
          recModel = provider.displayName || provider.model;
          checkBudget();
          output = await callChat(provider, [{ role: "user", content: text }], {
            onUsage: (u) => {
              recUsage = u;
            }
          });
        }
      } else if (kind === "review") {
        // 结构化审核：不绑 Agent，provider 取 工作流指定 > 第一个启用的
        const dims =
          Array.isArray(node.data.dimensions) && node.data.dimensions.length > 0
            ? node.data.dimensions.filter((d): d is string => typeof d === "string" && d.trim().length > 0)
            : [...REVIEW_DIMENSIONS];
        const dimensions = dims.length > 0 ? dims : [...REVIEW_DIMENSIONS];
        const custom = node.data.contextTemplate?.trim();
        const reviewInput = custom
          ? interpolate(custom, input, outputs, labelToId, memory, styleCtx)
          : upstreamOutput || input;
        recInput = reviewInput;
        const replay = replayOutputs?.[`${node.id}#${attempt}`];
        if (replay !== undefined) {
          output = replay;
          recReplayed = true;
        } else {
          const provider =
            (workflow.providerId ? providers.find((p) => p.id === workflow.providerId) : null) ??
            pickProvider(providers, null);
          recModel = provider.displayName || provider.model;
          // 项目绑定风格模板时，无论是否勾选文风维度，都以该配置为准审核文风一致性
          const sysBase = reviewSystemPrompt(dimensions);
          const sysPrompt = styleFull
            ? `${sysBase}\n\n【作品风格配置】\n${styleFull}\n\n文风一致性审核以上述风格配置为准。`
            : sysBase;
          checkBudget();
          const raw = await callChat(
            provider,
            [
              { role: "system", content: sysPrompt },
              { role: "user", content: reviewInput }
            ],
            {
              temperature: 0.2,
              onUsage: (u) => {
                recUsage = u;
              }
            }
          );
          output = validateReviewOutput(node.data.label, raw);
        }
      } else if (kind === "patch") {
        // 局部修订：按来源 label 找文本与审核结果，缺省回退直接上游
        const resolveSource = (label: string | undefined): string => {
          const key = label?.trim();
          if (key) {
            const hit = outputs.get(key) ?? outputs.get(labelToId.get(key) ?? "");
            if (typeof hit === "string" && hit) return hit;
          }
          return upstreamOutput || input;
        };
        const text = resolveSource(node.data.textSource);
        if (!text.trim()) throw new Error(`局部修订节点「${node.data.label}」找不到被修订文本（检查 textSource 或上游输出）`);
        const reviewJson = resolveSource(node.data.reviewSource);
        if (!reviewJson.trim()) throw new Error(`局部修订节点「${node.data.label}」找不到审核结果（检查 reviewSource 或上游输出）`);
        const patchInput = `审核结果：\n${reviewJson}\n\n原文：\n${text}`;
        recInput = patchInput;
        const replay = replayOutputs?.[`${node.id}#${attempt}`];
        // 短路：审核 JSON 可解析且无需修订（issues 为空数组，或 verdict=pass 且无 issues 字段）时跳过 LLM，直接透传原文
        let noFixNeeded = false;
        try {
          const parsedReview = JSON.parse(stripCodeFence(reviewJson).trim()) as {
            verdict?: unknown;
            issues?: unknown;
          };
          if (Array.isArray(parsedReview?.issues)) {
            noFixNeeded = parsedReview.issues.length === 0;
          } else {
            noFixNeeded = parsedReview?.verdict === "pass";
          }
        } catch {
          // 审核结果不是可解析的 JSON：保持现有行为，照常走 LLM
        }
        if (replay !== undefined) {
          output = replay;
          recReplayed = true;
        } else if (noFixNeeded) {
          output = text; // 审核通过：零成本透传正文，保证主链路最终输出永远是正文
        } else {
          const provider =
            (workflow.providerId ? providers.find((p) => p.id === workflow.providerId) : null) ??
            pickProvider(providers, null);
          recModel = provider.displayName || provider.model;
          checkBudget();
          const raw = await callChat(
            provider,
            [
              { role: "system", content: PATCH_SYSTEM_PROMPT },
              { role: "user", content: patchInput }
            ],
            {
              temperature: 0.2,
              onUsage: (u) => {
                recUsage = u;
              }
            }
          );
          const pairs = parsePatchPairs(node.data.label, raw);
          let patched = text;
          let unmatched = 0;
          for (const p of pairs) {
            const idx = patched.indexOf(p.old); // 多处出现时替换第一处
            if (idx < 0) {
              unmatched++;
            } else {
              patched = patched.slice(0, idx) + p.new + patched.slice(idx + p.old.length);
            }
          }
          if (pairs.length > 0 && unmatched / pairs.length > 0.5) {
            throw new Error(
              `局部修订定位失败：${pairs.length} 处替换中 ${unmatched} 处未在原文找到，请改为整章重写`
            );
          }
          if (unmatched > 0) recNote = `有 ${unmatched} 处替换未定位，已跳过`;
          output = pairs.length === 0 ? text : patched;
        }
      } else if (kind === "context") {
        // 上下文构建器（FR-05）：纯组装节点，不调 LLM
        const replay = replayOutputs?.[`${node.id}#${attempt}`];
        if (replay !== undefined) {
          output = replay;
          recReplayed = true;
        } else {
          const sources =
            Array.isArray(node.data.contextSources) && node.data.contextSources.length > 0
              ? node.data.contextSources.filter((s): s is string => typeof s === "string")
              : [...CONTEXT_DEFAULT_SOURCES];
          const maxChars =
            typeof node.data.contextMaxChars === "number" && node.data.contextMaxChars > 0
              ? node.data.contextMaxChars
              : 12000;
          const recentN =
            typeof node.data.contextRecentChapters === "number" && node.data.contextRecentChapters > 0
              ? Math.floor(node.data.contextRecentChapters)
              : 1;
          const chapterChars =
            typeof node.data.contextChapterChars === "number" && node.data.contextChapterChars > 0
              ? node.data.contextChapterChars
              : 3000;
          const sourceLabel = (id: string): string => CONTEXT_SOURCES.find((c) => c.id === id)?.label ?? id;

          const blocks: { id: string; label: string; text: string }[] = [];
          for (const src of sources) {
            let text = "";
            if (src === "style") {
              text = styleFull;
            } else if (src.startsWith("state-")) {
              // 六类结构化状态：读对应物化 md（该文件可能没被任何模板引用，这里直接读）
              if (projectId) {
                const rel = `${src}.md`;
                try {
                  const t = novelFs.memoryRead(projectId, rel);
                  if (t.trim()) {
                    text = t;
                    if (!memoryRefs.includes(rel)) memoryRefs.push(rel);
                  }
                } catch {
                  // 读不到跳过
                }
              }
            } else if (src === "memory-files") {
              if (projectId && typeof node.data.contextMemoryFiles === "string") {
                const names = node.data.contextMemoryFiles
                  .split(/[,，]/)
                  .map((s) => s.trim())
                  .filter(Boolean);
                const parts: string[] = [];
                for (const name of names) {
                  const rel = name.endsWith(".md") ? name : `${name}.md`;
                  try {
                    const t = novelFs.memoryRead(projectId, rel);
                    if (t.trim()) {
                      parts.push(`#### ${name}\n${t}`);
                      if (!memoryRefs.includes(rel)) memoryRefs.push(rel);
                    }
                  } catch {
                    // 读不到跳过
                  }
                }
                text = parts.join("\n\n");
              }
            } else if (src === "recent-chapters") {
              if (projectId) {
                try {
                  const proj = novelFs.list().find((p) => p.id === projectId);
                  if (proj) {
                    const parts: string[] = [];
                    for (const c of proj.chapters.slice(-recentN)) {
                      let body = novelFs.readChapter(projectId, c.id);
                      if (!body.trim()) continue;
                      if (body.length > chapterChars) body = `${body.slice(0, chapterChars)}\n（后略）`;
                      parts.push(`### ${c.title}\n${body}`);
                    }
                    text = parts.join("\n\n");
                  }
                } catch {
                  // 项目读取失败跳过
                }
              }
            } else if (src === "input") {
              text = input;
            }
            if (text.trim()) blocks.push({ id: src, label: sourceLabel(src), text });
          }

          // 预算控制：总长超 maxChars 时从最低优先级（列表最后）的非 input 来源开始整体移除；input 永不移除
          const render = (b: { label: string; text: string }): string => `【${b.label}】\n${b.text}`;
          const kept = [...blocks];
          const removed: string[] = [];
          const totalLen = (): number =>
            kept.reduce((sum, b) => sum + render(b).length, 0) + Math.max(0, kept.length - 1) * 2;
          while (totalLen() > maxChars) {
            let idx = -1;
            for (let i = kept.length - 1; i >= 0; i--) {
              if (kept[i].id !== "input") {
                idx = i;
                break;
              }
            }
            if (idx < 0) break; // 只剩 input，超出就让它超
            removed.unshift(kept[idx].label);
            kept.splice(idx, 1);
          }

          recContextRefs = [
            ...kept.map((b) => ({ source: b.label, chars: b.text.length })),
            ...removed.map((r) => ({ source: `${r}(已省略)`, chars: 0 }))
          ];
          output = kept.map(render).join("\n\n");
          if (removed.length > 0) {
            output += `\n\n【上下文预算 ${maxChars} 字符，已省略：${removed.join("、")}】`;
          }
        }
      } else if (kind === "end") {
        output = upstreamOutput;
        // 可选输出来源：条件分支汇入时，end 输出「最后那版正文」而非 pass 路径上游的内容
        const srcList = node.data.outputSource?.trim();
        if (srcList) {
          for (const name of srcList.split(/[,，]/).map((s) => s.trim()).filter(Boolean)) {
            const hit = outputs.get(name) ?? outputs.get(labelToId.get(name) ?? "");
            if (typeof hit === "string" && hit) {
              output = hit;
              break;
            }
          }
        }
        outputs.set(node.id, output);
        endOutput = output;
        // 结束节点也可自动转提案（用最终输出解析）；契约不满足时抛出错误终止运行
        if (node.data.autoProposal && projectId && output.trim()) {
          const res = createProposalsFromOutput(projectId, output, node.data.label);
          proposalsCreated += res.created;
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
      if (recordable) {
        const recFinishedAt = Date.now();
        nodeRuns.push({
          nodeId: node.id,
          label: node.data.label,
          kind,
          attempt,
          status: "failed",
          startedAt: recStartedAt,
          finishedAt: recFinishedAt,
          durationMs: recFinishedAt - recStartedAt,
          ...(recModel ? { model: recModel } : {}),
          inputChars: recInput.length,
          inputPreview: recInput.slice(0, 500),
          error: message,
          ...(recUsage ? { usage: recUsage } : {})
        });
      }
      emit({ type: "node-error", nodeId: node.id, label: node.data.label, error: message });
      throw err;
    }

    if (recordable) {
      const recFinishedAt = Date.now();
      nodeRuns.push({
        nodeId: node.id,
        label: node.data.label,
        kind,
        attempt,
        status: "succeeded",
        startedAt: recStartedAt,
        finishedAt: recReplayed ? recStartedAt : recFinishedAt,
        durationMs: recReplayed ? 0 : recFinishedAt - recStartedAt,
        ...(recModel ? { model: recModel } : {}),
        inputChars: recInput.length,
        inputPreview: recInput.slice(0, 500),
        output,
        ...(recNote ? { error: recNote } : {}),
        ...(recUsage ? { usage: recUsage } : {}),
        ...(recReplayed ? { replayed: true } : {}),
        ...(recContextRefs ? { contextRefs: recContextRefs } : {})
      });
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

    // autoProposal 节点：输出解析为结构化提案，自动创建到待审核（不自动应用）；契约不满足时抛出错误终止运行
    if (node.data.autoProposal && projectId && output.trim()) {
      const res = createProposalsFromOutput(projectId, output, node.data.label);
      proposalsCreated += res.created;
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
    return { finalOutput, proposalsCreated };
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

  // F-01：AI 生成的条件表达式必须能被白名单求值器解析，否则清空并告警
  for (const e of edges) {
    const expr = e.data?.conditionExpr;
    if (expr && !isSafeCondition(expr)) {
      console.warn(`[workflowEngine] AI 生成的边条件不被安全求值器支持，已清空: ${expr.slice(0, 120)}`);
      delete e.data!.conditionExpr;
    }
  }

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
