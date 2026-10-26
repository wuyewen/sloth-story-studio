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
  backgroundImage: null,
  agentDir: "",
  workflowDir: ""
};

export function readSettings(): AppSettings {
  return { ...DEFAULT_SETTINGS, ...readJson<Partial<AppSettings>>("settings.json", {}) };
}

export function writeSettings(settings: AppSettings): void {
  writeJson("settings.json", settings);
}

// ---- agents ----

// agents/workflows 支持自定义存储目录（settings.agentDir / workflowDir），默认在应用数据目录
function customFile(dirSetting: string, fileName: string): string {
  if (dirSetting) {
    fs.mkdirSync(dirSetting, { recursive: true });
    return path.join(dirSetting, fileName);
  }
  return path.join(dataDir(), fileName);
}

function agentsFile(): string {
  return customFile(readSettings().agentDir, "agents.json");
}

function workflowsFile(): string {
  return customFile(readSettings().workflowDir, "workflows.json");
}

// 目录切换时把现有内容迁移到新位置（目标已存在则不覆盖）
export function migrateStoreFile(fileName: string, targetDir: string): void {
  const target = path.join(targetDir, fileName);
  if (fs.existsSync(target)) return;
  const source = path.join(dataDir(), fileName);
  if (!fs.existsSync(source)) return;
  fs.mkdirSync(targetDir, { recursive: true });
  fs.copyFileSync(source, target);
}

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

function writeJsonAbs(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf-8");
  fs.renameSync(tmp, file);
}

function readJsonAbs<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

export function readAgents(): AgentProfile[] {
  const file = agentsFile();
  let agents = readJsonAbs<AgentProfile[]>(file, []);
  if (!fs.existsSync(file)) {
    const now = Date.now();
    const builtins: AgentProfile[] = BUILTIN_AGENTS.map((a) => ({
      ...a,
      id: newId(),
      createdAt: now,
      updatedAt: now
    }));
    agents = [...builtins, ...agents.filter((a) => !a.builtin)];
    writeAgents(agents);
  }
  return agents;
}

export function writeAgents(agents: AgentProfile[]): void {
  writeJsonAbs(agentsFile(), agents);
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
          conditionExpr:
            "(context.visits['小说写手修订'] || 0) < 3 && (output.includes('需修改') || output.includes('有问题') || output.includes('不通过'))"
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
        label: "通过或已达上限",
        data: {
          line: "bezier",
          color: "#22c55e",
          conditionExpr:
            "(context.visits['小说写手修订'] || 0) >= 3 || !(output.includes('需修改') || output.includes('有问题') || output.includes('不通过'))"
        }
      },
      { id: "e8", source: "final", target: "end", label: "输出终稿", data: { line: "bezier", color: "#94a3b8" } }
    ],
    createdAt: now,
    updatedAt: now
  };
}

// ---- WF01~WF04 标准创作工作流模板 ----

type NodeSpec = WorkflowDef["nodes"][number];
type EdgeSpec = WorkflowDef["edges"][number];

function mkAgent(
  byName: (name: string) => string | null,
  id: string,
  label: string,
  agentName: string,
  x: number,
  y: number,
  contextTemplate: string,
  maxVisits?: number
): NodeSpec {
  return {
    id,
    type: "agent",
    position: { x, y },
    data: { kind: "agent", label, agentId: byName(agentName), contextTemplate, ...(maxVisits ? { maxVisits } : {}) }
  };
}

function mkPrompt(id: string, label: string, x: number, y: number, template: string): NodeSpec {
  return { id, type: "prompt", position: { x, y }, data: { kind: "prompt", label, template } };
}

function mkEdge(id: string, source: string, target: string, label?: string, conditionExpr?: string): EdgeSpec {
  return {
    id,
    source,
    target,
    ...(label ? { label } : {}),
    data: { line: "bezier", color: "#94a3b8", ...(conditionExpr ? { conditionExpr } : {}) }
  };
}

const START: NodeSpec = { id: "start", type: "start", position: { x: 60, y: 80 }, data: { kind: "start", label: "开始" } };
const END: NodeSpec = { id: "end", type: "end", position: { x: 1760, y: 80 }, data: { kind: "end", label: "结束" } };

function wf01(byName: (name: string) => string | null, now: number): WorkflowDef {
  return {
    id: newId(),
    name: "WF01 全书规划与主线设计",
    description: "开书前运行：系统设计 → 世界观 → 全书大纲 → 逻辑与伏笔审查 → 记忆更新提案。读取现有记忆，产物可经审核后写入 memory/。需先配置大模型。",
    builtin: true,
    nodes: [
      START,
      mkPrompt("ctx", "读取现有记忆", 340, 80, "创作意图：{{input}}\n\n【现有核心设定】\n{{memory.story-bible}}\n\n【现有系统设计】\n{{memory.system-design}}\n\n【现有世界观】\n{{memory.world-bible}}\n\n【现有风格规范】\n{{memory.style-guide}}"),
      mkAgent(byName, "plan", "全书规划（大纲设计师）", "大纲设计师", 620, 80, "现有记忆与创作意图：\n{{nodes.ctx.output}}\n\n请输出：系统/核心设定、主线冲突、全书分卷大纲、长期伏笔总表。"),
      mkAgent(byName, "check", "逻辑与伏笔审查", "审核编辑", 900, 80, "全书规划稿：\n{{nodes.plan.output}}\n\n请审查因果链、人物动机、伏笔可回收性，列出问题清单（若无问题请明确写「通过」）。"),
      {
        id: "proposals",
        type: "prompt",
        position: { x: 1180, y: 80 },
        data: {
          kind: "prompt",
          label: "整理记忆更新提案",
          autoProposal: true,
          template:
            "全书规划：\n{{nodes.plan.output}}\n\n审查意见：\n{{nodes.check.output}}\n\n请把本次规划应写入记忆的内容整理为提案，只输出 JSON 数组（不要 markdown 围栏），每项：{\"targetFile\":\"story-bible|system-design|world-bible|master-outline|style-guide|foreshadowing-tracker 之一\",\"summary\":\"一句话变更摘要\",\"reason\":\"更新理由\",\"content\":\"建议写入的完整 Markdown 内容\"}"
        }
      },
      END
    ],
    edges: [
      mkEdge("e1", "start", "ctx"),
      mkEdge("e2", "ctx", "plan"),
      mkEdge("e3", "plan", "check"),
      mkEdge("e4", "check", "proposals"),
      mkEdge("e5", "proposals", "end", "提案")
    ],
    createdAt: now,
    updatedAt: now
  };
}

function wf02(byName: (name: string) => string | null, now: number): WorkflowDef {
  return {
    id: newId(),
    name: "WF02 小世界／故事单元规划",
    description: "开启新故事单元时运行：读取全书设定与既有伏笔，规划本单元主角、背景、核心冲突与骗局，拆分章节，审查一致性。需先配置大模型。",
    builtin: true,
    nodes: [
      START,
      mkPrompt("ctx", "读取全书记忆", 340, 80, "本单元规划目标：{{input}}\n\n【全书大纲】\n{{memory.master-outline}}\n\n【核心设定】\n{{memory.story-bible}}\n\n【系统设计】\n{{memory.system-design}}\n\n【伏笔追踪】\n{{memory.foreshadowing-tracker}}\n\n【上一单元交接】\n{{memory.handoffs/latest}}"),
      mkAgent(byName, "unit", "单元规划（大纲设计师）", "大纲设计师", 620, 80, "全书记忆与规划目标：\n{{nodes.ctx.output}}\n\n请输出：本单元设定、新主角与背景、核心冲突与骗局设计、章节分解、本单元伏笔安排与结局。"),
      mkAgent(byName, "check", "一致性审查", "审核编辑", 900, 80, "单元规划稿：\n{{nodes.unit.output}}\n\n全书记忆：\n{{nodes.ctx.output}}\n\n请审查与全书设定、系统设计、既有伏笔的冲突，列出问题（若无问题请明确写「通过」）。"),
      {
        id: "proposals",
        type: "prompt",
        position: { x: 1180, y: 80 },
        data: {
          kind: "prompt",
          label: "整理记忆更新提案",
          autoProposal: true,
          template:
            "单元规划稿：\n{{nodes.unit.output}}\n\n审查意见：\n{{nodes.check.output}}\n\n请把本次单元规划应写入记忆的内容整理为提案，只输出 JSON 数组（不要 markdown 围栏），每项：{\"targetFile\":\"master-outline|foreshadowing-tracker|character-state|handoffs/latest 之一\",\"summary\":\"一句话变更摘要\",\"reason\":\"更新理由\",\"content\":\"建议写入的完整 Markdown 内容\"}"
        }
      },
      END
    ],
    edges: [
      mkEdge("e1", "start", "ctx"),
      mkEdge("e2", "ctx", "unit"),
      mkEdge("e3", "unit", "check"),
      mkEdge("e4", "check", "proposals"),
      mkEdge("e5", "proposals", "end", "提案")
    ],
    createdAt: now,
    updatedAt: now
  };
}

function wf03(byName: (name: string) => string | null, now: number): WorkflowDef {
  return {
    id: newId(),
    name: "WF03 章节创作、评审与返修",
    description: "每章使用：读取相关记忆 → 写手初稿 → 编辑审查 → 读者评审并行 → 评审总编归纳 → 有问题返修（最多 3 轮）→ 终稿。需先配置大模型。",
    builtin: true,
    nodes: [
      START,
      mkPrompt("ctx", "读取本章记忆", 340, 80, "本章写作任务：{{input}}\n\n【全书大纲】\n{{memory.master-outline}}\n\n【风格规范】\n{{memory.style-guide}}\n\n【角色状态】\n{{memory.character-state}}\n\n【伏笔追踪】\n{{memory.foreshadowing-tracker}}\n\n【上一单元摘要】\n{{memory.unit-summaries/latest}}"),
      mkAgent(byName, "draft", "写作初稿", "小说写手", 620, 80, "记忆与任务：\n{{nodes.ctx.output}}\n\n请完成本章初稿（完整正文）。"),
      mkAgent(byName, "edit", "编辑审查", "审核编辑", 900, 80, "章节初稿：\n{{nodes.draft.output}}\n\n写作任务：\n{{nodes.ctx.output}}\n\n请审查逻辑、设定一致性、文风，列出问题清单（若无问题请明确写「通过」）。"),
      mkAgent(byName, "reader", "读者评审", "读者顾问", 1180, 80, "章节正文：\n{{nodes.draft.output}}\n\n编辑意见：\n{{nodes.edit.output}}\n\n请从读者视角评审本章（若无问题请明确写「通过」）。"),
      mkAgent(
        byName,
        "revise",
        "写手返修",
        "小说写手",
        1460,
        80,
        "写作任务：\n{{nodes.ctx.output}}\n\n上一版稿件：\n{{nodes.draft.output}}\n\n编辑意见：\n{{nodes.edit.output}}\n\n读者意见：\n{{nodes.reader.output}}\n\n请根据意见返修，输出完整修订稿（只输出正文）。",
        3
      ),
      END
    ],
    edges: [
      mkEdge("e1", "start", "ctx"),
      mkEdge("e2", "ctx", "draft"),
      mkEdge("e3", "draft", "edit"),
      mkEdge("e4", "edit", "reader"),
      {
        id: "e5",
        source: "reader",
        target: "revise",
        label: "有问题，返修（最多3轮）",
        data: {
          line: "step",
          color: "#ef4444",
          conditionExpr:
            "(context.visits['写手返修'] || 0) < 3 && (output.includes('需修改') || output.includes('有问题') || output.includes('不通过'))"
        }
      },
      {
        id: "e6",
        source: "revise",
        target: "edit",
        type: "loopback",
        label: "修订稿复审",
        animated: true,
        style: { stroke: "#E0A458", strokeDasharray: "6 4" },
        data: { line: "step", color: "#E0A458", loopY: 16 }
      },
      {
        id: "e7",
        source: "reader",
        target: "end",
        label: "通过或已达上限",
        data: {
          line: "bezier",
          color: "#22c55e",
          conditionExpr:
            "(context.visits['写手返修'] || 0) >= 3 || !(output.includes('需修改') || output.includes('有问题') || output.includes('不通过'))"
        }
      }
    ],
    createdAt: now,
    updatedAt: now
  };
}

function wf04(byName: (name: string) => string | null, now: number): WorkflowDef {
  return {
    id: newId(),
    name: "WF04 单元复盘、记忆归档与交接",
    description: "单元结束时运行：以最终正文为事实来源，对比计划与实际，产出单元摘要、下一单元交接和记忆更新提案。需先配置大模型。",
    builtin: true,
    nodes: [
      START,
      mkPrompt("ctx", "读取单元记忆", 340, 80, "本单元复盘范围：{{input}}\n\n【单元计划（全书大纲相关部分）】\n{{memory.master-outline}}\n\n【角色状态】\n{{memory.character-state}}\n\n【伏笔追踪】\n{{memory.foreshadowing-tracker}}"),
      mkAgent(byName, "review", "复盘对比（审核编辑）", "审核编辑", 620, 80, "单元记忆：\n{{nodes.ctx.output}}\n\n请以最终正文为准（见输入），比较计划与实际剧情：检查闭环、角色状态变化、系统规则变化、未回收伏笔。"),
      mkAgent(byName, "archive", "归档与交接（大纲设计师）", "大纲设计师", 900, 80, "复盘结果：\n{{nodes.review.output}}\n\n单元记忆：\n{{nodes.ctx.output}}\n\n请输出三部分：1）本单元摘要；2）给下一单元的交接要点；3）需要更新的记忆内容（角色状态、伏笔、全书大纲的变化）。"),
      {
        id: "proposals",
        type: "prompt",
        position: { x: 1180, y: 80 },
        data: {
          kind: "prompt",
          label: "整理记忆更新提案",
          autoProposal: true,
          template:
            "归档与交接内容：\n{{nodes.archive.output}}\n\n请把其中应写入记忆的内容整理为提案，只输出 JSON 数组（不要 markdown 围栏），每项：{\"targetFile\":\"character-state|foreshadowing-tracker|master-outline|unit-summaries/单元名|handoffs/latest 之一\",\"summary\":\"一句话变更摘要\",\"reason\":\"更新理由\",\"content\":\"建议写入的完整 Markdown 内容\"}"
        }
      },
      END
    ],
    edges: [
      mkEdge("e1", "start", "ctx"),
      mkEdge("e2", "ctx", "review"),
      mkEdge("e3", "review", "archive"),
      mkEdge("e4", "archive", "proposals"),
      mkEdge("e5", "proposals", "end", "提案")
    ],
    createdAt: now,
    updatedAt: now
  };
}

function wfDemo(byName: (name: string) => string | null, now: number): WorkflowDef {
  return {
    id: newId(),
    name: "DEMO 并行与汇合示例",
    description: "演示用法：读取共享记忆 → 两个写手并行出稿（分支并行）→ 汇合节点等两个都完成后融合（多入边 join）。运行前请先在托盘配置大模型，并从创作工作台运行以注入项目记忆。",
    builtin: true,
    nodes: [
      START,
      mkPrompt("ctx", "读取共享记忆", 340, 150, "写作任务：{{input}}\n\n【风格规范】\n{{memory.style-guide}}\n\n【角色状态】\n{{memory.character-state}}"),
      mkAgent(byName, "draftA", "写手 · 版本A", "小说写手", 620, 60, "任务与记忆：\n{{nodes.ctx.output}}\n\n请写版本 A（侧重节奏快、冲突强）。只输出正文。"),
      mkAgent(byName, "draftB", "写手 · 版本B", "小说写手", 620, 240, "任务与记忆：\n{{nodes.ctx.output}}\n\n请写版本 B（侧重氛围、情绪细腻）。只输出正文。"),
      mkAgent(
        byName,
        "merge",
        "融合定稿（汇合）",
        "审核编辑",
        980,
        150,
        "写作任务：\n{{nodes.ctx.output}}\n\n版本 A：\n{{nodes.draftA.output}}\n\n版本 B：\n{{nodes.draftB.output}}\n\n请融合两版优点输出最终定稿（完整正文）。"
      ),
      { id: "end", type: "end", position: { x: 1260, y: 150 }, data: { kind: "end", label: "结束" } }
    ],
    edges: [
      mkEdge("e1", "start", "ctx"),
      mkEdge("e2", "ctx", "draftA", "并行A"),
      mkEdge("e3", "ctx", "draftB", "并行B"),
      mkEdge("e4", "draftA", "merge", "汇合"),
      mkEdge("e5", "draftB", "merge", "汇合"),
      mkEdge("e6", "merge", "end", "定稿")
    ],
    createdAt: now,
    updatedAt: now
  };
}

function builtinWorkflowTemplates(byName: (name: string) => string | null): WorkflowDef[] {
  const now = Date.now();
  return [buildBuiltinWorkflow(byName), wf01(byName, now), wf02(byName, now), wf03(byName, now), wf04(byName, now), wfDemo(byName, now)];
}

export function readWorkflows(): WorkflowDef[] {
  const file = workflowsFile();
  let workflows = readJsonAbs<WorkflowDef[]>(file, []);
  const agents = readAgents();
  const byName = (name: string): string | null =>
    (agents.find((a) => a.builtin && a.name === name) ?? agents.find((a) => a.name === name))?.id ?? null;
  let changed = false;
  for (const tpl of builtinWorkflowTemplates(byName)) {
    const existing = workflows.find((w) => w.name === tpl.name);
    if (existing) {
      if (!existing.builtin) {
        workflows = workflows.map((w) => (w.id === existing.id ? { ...w, builtin: true } : w));
        changed = true;
      } else if (
        existing.description !== tpl.description ||
        JSON.stringify(existing.nodes) !== JSON.stringify(tpl.nodes) ||
        JSON.stringify(existing.edges) !== JSON.stringify(tpl.edges)
      ) {
        // 内置模板随版本升级（内置只读不可改，安全覆盖；保留原 id 不破坏项目槽位绑定）
        workflows = workflows.map((w) =>
          w.id === existing.id ? { ...tpl, id: existing.id, createdAt: existing.createdAt } : w
        );
        changed = true;
      }
    } else {
      workflows = [tpl, ...workflows];
      changed = true;
    }
  }
  if (changed || !fs.existsSync(file)) writeJsonAbs(file, workflows);
  return workflows;
}

export function writeWorkflows(workflows: WorkflowDef[]): void {
  writeJsonAbs(workflowsFile(), workflows);
}
