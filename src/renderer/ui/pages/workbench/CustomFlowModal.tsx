import { useMemo, useState } from "react";
import { Loader2, Wand2 } from "lucide-react";
import { sloth } from "../../../api";
import { useStudio } from "../../../state/store";
import { Modal } from "../../components/Modal";
import type { WorkflowDef, WorkflowEdge, WorkflowNode } from "../../../../shared/types";

// ---- 风格预设（选中直接创建，不走大模型） ----

interface AgentDef {
  name: string;
  role: string;
  systemPrompt: string;
  temperature: number;
  color: string;
}

interface StylePack {
  id: string;
  name: string;
  desc: string;
  agents: AgentDef[];
  workflowDesc: string;
  writerAgent: string;
  reviewerAgent: string;
  readerAgent: string;
}

const PACKS: StylePack[] = [
  {
    id: "xuanhuan-funny-antifraud",
    name: "玄幻·搞笑·反诈（单元流）",
    desc: "每个小世界一种骗局，写手+审核+玄幻/搞笑/反诈三读者并行评审",
    agents: [
      { name: "玄幻反诈写手", role: "按单元大纲写反诈题材的章节正文", systemPrompt: "你是一位擅长反诈题材单元故事的小说写手。根据给定的大纲与记忆创作章节正文：情节服务于骗局设计，骗局逻辑真实可识别、有警示价值。文风以本书绑定的风格模板为准（随上下文给出）。【硬性要求】只输出正文，不输出任何解释、修改说明或元信息。", temperature: 0.8, color: "#C85B4E" },
      { name: "反诈审稿编辑", role: "审查章节逻辑、设定一致性与骗局呈现", systemPrompt: "你是严谨的小说审稿编辑。审查章节正文的逻辑漏洞、设定一致性、文风问题（以本书绑定的风格模板为准），以及骗局的可识别性与警示价值。结尾必须单独一行输出结论标记：CHAPTER_RESULT: PASS（通过）或 CHAPTER_RESULT: REVISE（需返修）。", temperature: 0.3, color: "#5B7EC8" }
    ],
    workflowDesc: "单元流章节生产：写手初稿 → 反诈审稿编辑审查 → 需返修回写手（最多3轮）→ 终稿",
    writerAgent: "玄幻反诈写手",
    reviewerAgent: "反诈审稿编辑",
    readerAgent: ""
  },
  {
    id: "single-arc",
    name: "通用长篇（单线架构）",
    desc: "一条主线走到底：写手+编辑双人组，适合不拆单元的长篇",
    agents: [
      { name: "长篇写手", role: "按大纲写长篇小说章节正文", systemPrompt: "你是长篇小说写手。根据任务与记忆写作章节正文，保持人物与主线一致；文风以本书绑定的风格模板为准（随上下文给出）。【硬性要求】只输出正文，不输出解释或元信息。", temperature: 0.8, color: "#80A78A" },
      { name: "长篇编辑", role: "审查章节逻辑与文风一致性", systemPrompt: "你是长篇小说的责任编辑。审查章节的逻辑、人物一致性、文风统一性（以本书绑定的风格模板为准）。结尾必须单独一行输出结论标记：CHAPTER_RESULT: PASS（通过）或 CHAPTER_RESULT: REVISE（需返修）。", temperature: 0.3, color: "#7D8796" }
    ],
    workflowDesc: "长篇单线：写手初稿 → 编辑审查 → 需返修回写手（最多3轮）→ 终稿",
    writerAgent: "长篇写手",
    reviewerAgent: "长篇编辑",
    readerAgent: ""
  }
];

function buildPackWorkflow(pack: StylePack): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } {
  const nodes: WorkflowNode[] = [
    { id: "start", type: "start", position: { x: 60, y: 80 }, data: { kind: "start", label: "开始" } },
    { id: "ctx", type: "prompt", position: { x: 340, y: 80 }, data: { kind: "prompt", label: "章节任务与记忆", template: "# 本章写作任务\n{{input}}\n\n【本书风格】\n{{style.full}}\n\n【全书规划】\n{{memory.全书规划}}\n\n【单元规划】\n{{memory.unit-plan}}" } },
    { id: "draft", type: "agent", position: { x: 620, y: 80 }, data: { kind: "agent", label: "写作初稿", agentId: null, contextTemplate: "写作任务与记忆：\n{{nodes.ctx.output}}\n\n请完成本章初稿（完整正文，只输出正文）。" } },
    { id: "edit", type: "agent", position: { x: 900, y: 80 }, data: { kind: "agent", label: "编辑审查", agentId: null, contextTemplate: "写作任务：\n{{nodes.ctx.output}}\n\n章节稿件：\n{{nodes.draft.output}}\n\n返修稿（首轮为空，非空则以它为准）：\n{{nodes.revise.output}}\n\n请审查当前稿件；结尾必须单独一行输出结论标记：CHAPTER_RESULT: PASS 或 CHAPTER_RESULT: REVISE。" } },
    { id: "revise", type: "agent", position: { x: 1180, y: 80 }, data: { kind: "agent", label: "写手返修", agentId: null, maxVisits: 3, contextTemplate: "写作任务：\n{{nodes.ctx.output}}\n\n上一版稿件：\n{{nodes.draft.output}}\n\n编辑意见：\n{{nodes.edit.output}}\n\n请根据意见返修，输出完整修订稿（只输出正文）。" } },
    { id: "end", type: "end", position: { x: 1460, y: 80 }, data: { kind: "end", label: "结束" } }
  ];
  const edges: WorkflowEdge[] = [
    { id: "e1", source: "start", target: "ctx", data: { line: "bezier", color: "#94a3b8" } },
    { id: "e2", source: "ctx", target: "draft", data: { line: "bezier", color: "#94a3b8" } },
    { id: "e3", source: "draft", target: "edit", data: { line: "bezier", color: "#94a3b8" } },
    { id: "e4", source: "edit", target: "revise", label: "需返修（最多3轮）", data: { line: "step", color: "#ef4444", conditionExpr: "/CHAPTER_RESULT\\s*:\\s*REVISE/i.test(String(output)) && (context.visits['写手返修'] || 0) < 3" } },
    { id: "e5", source: "revise", target: "edit", type: "loopback", label: "修订稿复审", animated: true, style: { stroke: "#E0A458", strokeDasharray: "6 4" }, data: { line: "step", color: "#E0A458", loopY: 16 } },
    { id: "e6", source: "edit", target: "end", label: "通过或已达上限", data: { line: "bezier", color: "#22c55e", conditionExpr: "/CHAPTER_RESULT\\s*:\\s*PASS/i.test(String(output)) || (context.visits['写手返修'] || 0) >= 3" } }
  ];
  return { nodes, edges };
}

interface Props {
  projectId: string;
  projectTitle: string;
  onClose: () => void;
}

export default function CustomFlowModal({ projectId, projectTitle, onClose }: Props) {
  const agents = useStudio((s) => s.agents);
  const providers = useStudio((s) => s.providers);
  const agentGroups = useStudio((s) => s.agentGroups);
  const workflowGroups = useStudio((s) => s.workflowGroups);
  const refreshAgents = useStudio((s) => s.refreshAgents);
  const refreshWorkflows = useStudio((s) => s.refreshWorkflows);
  const refreshGroups = useStudio((s) => s.refreshGroups);

  const usable = providers.filter((p) => p.enabled);
  const matchGroup = (groups: typeof agentGroups) =>
    groups.find((g) => projectTitle.includes(g.name) || g.name.includes(projectTitle))?.id ?? "";

  const [packId, setPackId] = useState("");
  const [desc, setDesc] = useState("");
  const [providerId, setProviderId] = useState("");
  const [agentGroupId, setAgentGroupId] = useState("");
  const [workflowGroupId, setWorkflowGroupId] = useState("");
  const [inited, setInited] = useState(false);
  if (!inited) {
    setAgentGroupId(matchGroup(agentGroups));
    setWorkflowGroupId(matchGroup(workflowGroups));
    setInited(true);
  }
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState("");
  const [doneMsg, setDoneMsg] = useState("");

  const pack = useMemo(() => PACKS.find((p) => p.id === packId) ?? null, [packId]);
  const effProvider = usable.find((p) => p.id === providerId)?.id ?? usable[0]?.id ?? "";

  async function ensureAgent(def: AgentDef): Promise<string> {
    const existing = agents.find((a) => a.name === def.name);
    if (existing) return existing.id;
    const list = await sloth!.agents.save({
      name: def.name, role: def.role, systemPrompt: def.systemPrompt,
      providerId: null, temperature: def.temperature, color: def.color
    });
    const created = list.find((a) => a.name === def.name);
    if (agentGroupId && created) await sloth!.agents.setGroup(created.id, agentGroupId);
    return created!.id;
  }

  async function createFromPack(p: StylePack) {
    const writerId = await ensureAgent(p.agents[0]);
    const reviewerId = await ensureAgent(p.agents[1]);
    const { nodes, edges } = buildPackWorkflow(p);
    for (const n of nodes) {
      if (n.data.kind === "agent") {
        if (n.id === "draft" || n.id === "revise") n.data.agentId = writerId;
        if (n.id === "edit") n.data.agentId = reviewerId;
      }
    }
    const name = `${p.name} · 章节生产`;
    const saved = await sloth!.workflows.save({ name, description: p.workflowDesc, nodes, edges });
    const wf = saved.find((w) => w.name === name);
    if (workflowGroupId && wf) await sloth!.workflows.setGroup(wf.id, workflowGroupId);
    return name;
  }

  async function createFromDesc() {
    const agentRes = await sloth!.llm.chat({
      providerId: effProvider,
      messages: [
        { role: "system", content: "你是 Agent 设计助手。只输出 JSON 数组，不要围栏不要解释。每项：{\"name\":\"...\",\"role\":\"一句话职责\",\"systemPrompt\":\"中文系统提示词（只定义职责与专业要求；文风规则不要写死，结尾加一句：文风以本书绑定的风格模板为准）\",\"temperature\":0.7,\"color\":\"#C85B4E\"}" },
        { role: "user", content: `为以下小说创作风格设计 2-3 个协作 Agent（如写手/审核/读者）：\n${desc.trim()}` }
      ]
    });
    const agentMatch = agentRes.slice(agentRes.indexOf("["), agentRes.lastIndexOf("]") + 1);
    const defs = JSON.parse(agentMatch) as AgentDef[];
    const nameToId = new Map<string, string>();
    for (const d of defs) nameToId.set(d.name, await ensureAgent(d));

    const { nodes, edges } = await sloth!.workflows.generate(
      `为以下风格创建小说章节创作工作流（写作→审核→返修循环→终稿），Agent 节点使用这些名称：${[...nameToId.keys()].join("、")}。风格：${desc.trim()}。注意：写作类节点的上下文模板需包含【本书风格】{{style.full}} 引用（项目绑定风格模板后自动生效），不要把文风规则写死进节点模板。`,
      effProvider
    );
    for (const n of nodes) {
      if (n.data.kind === "agent" && !n.data.agentId) {
        const hit = [...nameToId.entries()].find(([nm]) => n.data.label.includes(nm) || nm.includes(n.data.label));
        n.data.agentId = hit?.[1] ?? nameToId.values().next().value ?? null;
      }
    }
    const wfName = `${desc.trim().slice(0, 12) || "自定义"} · 创作流水线`;
    const saved = await sloth!.workflows.save({ name: wfName, description: desc.trim(), nodes, edges });
    const wf = saved.find((w) => w.name === wfName);
    if (workflowGroupId && wf) await sloth!.workflows.setGroup(wf.id, workflowGroupId);
    return wfName;
  }

  async function run() {
    if (!sloth) return;
    setRunning(true);
    setErr("");
    setDoneMsg("");
    try {
      if (pack && !desc.trim()) {
        const name = await createFromPack(pack);
        setDoneMsg(`已创建「${name}」（Agent 与工作流已归入所选分组）`);
      } else {
        if (!desc.trim()) throw new Error("请填写风格描述，或只选一个预设");
        if (!effProvider) throw new Error("没有启用的大模型，请先在托盘「大模型配置」中添加");
        const name = await createFromDesc();
        setDoneMsg(`已创建「${name}」（Agent 与工作流已归入所选分组）`);
      }
      await refreshAgents();
      await refreshWorkflows();
      await refreshGroups();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  return (
    <Modal title="自定义创作流水线" onClose={() => !running && onClose()} width={560}>
      <div className="form-row">
        <span className="form-label">风格预设（选了且不加描述 = 直接创建，不走大模型）</span>
        <div className="pack-chips">
          {PACKS.map((p) => (
            <button key={p.id} className={`group-chip ${packId === p.id ? "active" : ""}`} onClick={() => setPackId(packId === p.id ? "" : p.id)} title={p.desc}>
              {p.name}
            </button>
          ))}
        </div>
      </div>
      <label className="form-row">
        <span className="form-label">风格描述{pack ? "（选了预设又加描述 = 大模型定制生成）" : ""}</span>
        <textarea className="text-input" rows={3} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="例如：悬疑推理风，单元案件制，重逻辑反转……" />
      </label>
      <div className="form-grid">
        <label className="form-row">
          <span className="form-label">大模型（定制生成时用）</span>
          <select className="text-input" value={effProvider} onChange={(e) => setProviderId(e.target.value)}>
            {usable.map((p) => (
              <option key={p.id} value={p.id}>{p.displayName}</option>
            ))}
          </select>
        </label>
        <label className="form-row">
          <span className="form-label">Agent 分组</span>
          <select className="text-input" value={agentGroupId} onChange={(e) => setAgentGroupId(e.target.value)}>
            <option value="">默认分组</option>
            {agentGroups.map((g) => (
              <option key={g.id} value={g.id}>{g.name}</option>
            ))}
          </select>
        </label>
      </div>
      <label className="form-row">
        <span className="form-label">工作流分组</span>
        <select className="text-input" value={workflowGroupId} onChange={(e) => setWorkflowGroupId(e.target.value)}>
          <option value="">默认分组</option>
          {workflowGroups.map((g) => (
            <option key={g.id} value={g.id}>{g.name}</option>
          ))}
        </select>
      </label>
      {err && <p className="inline-msg err">{err}</p>}
      {doneMsg && <p className="inline-msg ok">{doneMsg}</p>}
      <div className="modal-actions">
        <button className="ghost-button" disabled={running} onClick={onClose}>关闭</button>
        <button className="primary-button" disabled={running || (!pack && !desc.trim())} onClick={() => void run()}>
          {running ? <Loader2 size={14} className="spin" /> : <Wand2 size={14} />}
          {running ? "生成中…" : pack && !desc.trim() ? "直接创建（不耗模型）" : "生成 Agent + 工作流"}
        </button>
      </div>
    </Modal>
  );
}
