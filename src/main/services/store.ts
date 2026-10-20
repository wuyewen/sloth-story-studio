import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { AgentProfile, ModelProvider, WorkflowDef } from "../../shared/types.js";
import type { AppSettings } from "../../shared/types.js";

function dataDir(): string {
  const dir = app.getPath("userData");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function readJson<T>(fileName: string, fallback: T): T {
  const file = path.join(dataDir(), fileName);
  try {
    const raw = fs.readFileSync(file, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(fileName: string, value: unknown): void {
  const file = path.join(dataDir(), fileName);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf-8");
  fs.renameSync(tmp, file);
}

export function newId(): string {
  return crypto.randomUUID();
}

// ---- models ----

interface ModelRecord extends ModelProvider {
  apiKeyEnc?: string;
}

export function readModels(): ModelRecord[] {
  return readJson<ModelRecord[]>("models.json", []);
}

export function writeModels(models: ModelRecord[]): void {
  writeJson("models.json", models);
}

export type { ModelRecord };

// ---- settings ----

const DEFAULT_SETTINGS: AppSettings = {
  novelDir: "",
  backgroundImage: null
};

export function readSettings(): AppSettings {
  return { ...DEFAULT_SETTINGS, ...readJson<Partial<AppSettings>>("settings.json", {}) };
}

export function writeSettings(settings: AppSettings): void {
  writeJson("settings.json", settings);
}

// ---- agents ----

const BUILTIN_AGENTS: Array<Omit<AgentProfile, "id" | "createdAt" | "updatedAt">> = [
  {
    name: "大纲设计师",
    role: "负责故事结构与章节大纲设计",
    systemPrompt:
      "你是一位资深小说大纲设计师。你擅长把模糊的创意整理成结构清晰的故事大纲：确立主题与主线冲突，划分卷与章节，安排节奏与伏笔。输出时使用条理分明的中文，先给总体框架，再给逐章要点。",
    providerId: null,
    temperature: 0.7,
    color: "#E8A33D",
    builtin: true
  },
  {
    name: "小说写手",
    role: "负责正文写作与润色",
    systemPrompt:
      "你是一位才华横溢的中文小说写手。根据给定的大纲与要求创作小说正文，注重场景描写、人物对话与情感张力，文风流畅自然。除非用户另有要求，保持第三人称叙述与统一的文风。【硬性要求】只输出小说正文本身，绝不输出任何修改说明、创作思路、注释、解释、评审回应或其他元信息，正文前后不要添加任何说明性文字。",
    providerId: null,
    temperature: 0.9,
    color: "#7BA05B",
    builtin: true
  },
  {
    name: "审核编辑",
    role: "负责审稿、找错与修改建议",
    systemPrompt:
      "你是一位严谨的中文图书编辑。审读给定的小说文本，指出逻辑漏洞、前后矛盾、语病、节奏问题与用词不当之处，并给出具体可执行的修改建议。先列问题清单，再给总体评价。",
    providerId: null,
    temperature: 0.3,
    color: "#5B7FA0",
    builtin: true
  },
  {
    name: "读者顾问",
    role: "以目标读者视角给出反馈",
    systemPrompt:
      "你是一位阅书无数的普通读者代表。从读者体验角度评价给定的小说内容：哪里吸引人、哪里想弃书、对角色和剧情的真实感受。用坦率、具体、口语化的中文反馈，不做学术分析。",
    providerId: null,
    temperature: 0.8,
    color: "#C46A8A",
    builtin: true
  }
];

export function readAgents(): AgentProfile[] {
  const seededFlag = path.join(dataDir(), ".agents-seeded");
  let agents = readJson<AgentProfile[]>("agents.json", []);
  if (!fs.existsSync(seededFlag)) {
    const now = Date.now();
    const builtins: AgentProfile[] = BUILTIN_AGENTS.map((a) => ({
      ...a,
      id: newId(),
      createdAt: now,
      updatedAt: now
    }));
    agents = [...builtins, ...agents.filter((a) => !a.builtin)];
    writeJson("agents.json", agents);
    fs.writeFileSync(seededFlag, String(now), "utf-8");
  }
  return agents;
}

export function writeAgents(agents: AgentProfile[]): void {
  writeJson("agents.json", agents);
}

// ---- workflows ----

// 内置工作流模板：agent 绑定按名称解析（新装时映射到本机播种的内置 agent id）
const BUILTIN_WORKFLOW_NAME = "简易小说工作流";

function buildBuiltinWorkflow(agentIdByName: (name: string) => string | null): WorkflowDef {
  const now = Date.now();
  const agent = (
    id: string,
    label: string,
    agentName: string,
    x: number,
    y: number,
    contextTemplate: string,
    maxVisits?: number
  ): WorkflowDef["nodes"][number] => ({
    id,
    type: "agent",
    position: { x, y },
    data: {
      kind: "agent",
      label,
      agentId: agentIdByName(agentName),
      contextTemplate,
      ...(maxVisits ? { maxVisits } : {})
    }
  });
  return {
    id: newId(),
    name: BUILTIN_WORKFLOW_NAME,
    description:
      "大纲设计师 → 小说写手初稿 → 审核编辑 → 读者顾问，有问题回到写手修订（最多 3 次），通过后由写手输出终稿。运行前请先在托盘「大模型配置」中添加并启用模型。",
    builtin: true,
    nodes: [
      { id: "start", type: "start", position: { x: 60, y: 80 }, data: { kind: "start", label: "开始" } },
      agent("outline", "大纲设计师", "大纲设计师", 340, 80, "用户需求：{{input}}"),
      agent("draft", "小说写手初稿", "小说写手", 620, 80, "用户需求：{{input}}\n故事大纲：{{nodes.outline.output}}"),
      agent("review", "审核编辑", "审核编辑", 900, 80, "用户需求：{{input}}\n故事大纲：{{nodes.outline.output}}\n小说稿件：{{nodes.draft.output}}"),
      agent("reader", "读者顾问", "读者顾问", 1180, 80, "用户需求：{{input}}\n小说稿件：{{nodes.draft.output}}\n审核意见：{{nodes.review.output}}"),
      agent(
        "revise",
        "小说写手修订",
        "小说写手",
        1480,
        80,
        "用户需求：{{input}}\n故事大纲：{{nodes.outline.output}}\n上一版稿件：{{nodes.draft.output}}\n审核编辑意见：{{nodes.review.output}}\n读者顾问意见：{{nodes.reader.output}}\n请根据以上意见修改稿件，输出完整的修订稿。",
        3
      ),
      agent(
        "final",
        "小说写手终稿",
        "小说写手",
        1480,
        230,
        "用户需求：{{input}}\n故事大纲：{{nodes.outline.output}}\n最新稿件：{{nodes.draft.output}}\n审核编辑意见：{{nodes.review.output}}\n读者顾问意见：{{nodes.reader.output}}\n请整合全部意见，输出可直接交付的最终成稿（完整正文）。"
      ),
      { id: "end", type: "end", position: { x: 1760, y: 80 }, data: { kind: "end", label: "结束" } }
    ],
    edges: [
      { id: "e1", source: "start", target: "outline", data: { line: "bezier", color: "#94a3b8" } },
      { id: "e2", source: "outline", target: "draft", label: "大纲", data: { line: "bezier", color: "#94a3b8" } },
      { id: "e3", source: "draft", target: "review", label: "初稿", data: { line: "bezier", color: "#94a3b8" } },
      { id: "e4", source: "review", target: "reader", data: { line: "bezier", color: "#94a3b8" } },
      {
        id: "e5",
        source: "reader",
        target: "revise",
        label: "有问题，需修改（最多3次）",
        data: {
          line: "step",
          color: "#ef4444",
          conditionExpr: "output.includes('需修改') || output.includes('有问题') || output.includes('不通过')"
        }
      },
      {
        id: "e6",
        source: "revise",
        target: "review",
        type: "loopback",
        label: "修订稿复审",
        animated: true,
        style: { stroke: "#E0A458", strokeDasharray: "6 4" },
        data: { line: "step", color: "#E0A458", loopY: 16 }
      },
      {
        id: "e7",
        source: "reader",
        target: "final",
        label: "通过或已达3次",
        data: {
          line: "bezier",
          color: "#22c55e",
          conditionExpr: "!(output.includes('需修改') || output.includes('有问题') || output.includes('不通过'))"
        }
      },
      { id: "e8", source: "final", target: "end", label: "输出终稿", data: { line: "bezier", color: "#94a3b8" } }
    ],
    createdAt: now,
    updatedAt: now
  };
}

export function readWorkflows(): WorkflowDef[] {
  const seededFlag = path.join(dataDir(), ".workflows-seeded");
  let workflows = readJson<WorkflowDef[]>("workflows.json", []);
  if (!fs.existsSync(seededFlag)) {
    const now = Date.now();
    const agents = readAgents();
    const byName = (name: string): string | null =>
      (agents.find((a) => a.builtin && a.name === name) ?? agents.find((a) => a.name === name))?.id ?? null;
    const existing = workflows.find((w) => w.name === BUILTIN_WORKFLOW_NAME);
    if (existing) {
      workflows = workflows.map((w) => (w.id === existing.id ? { ...w, builtin: true } : w));
    } else {
      workflows = [buildBuiltinWorkflow(byName), ...workflows];
    }
    writeJson("workflows.json", workflows);
    fs.writeFileSync(seededFlag, String(now), "utf-8");
  }
  return workflows;
}

export function writeWorkflows(workflows: WorkflowDef[]): void {
  writeJson("workflows.json", workflows);
}
