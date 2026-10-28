import { useId, useState } from "react";
import { Plus, X } from "lucide-react";

// 边条件的可视化编辑器：简单条件（一至两条规则 + 且/或）实时生成 JS 表达式；
// 已有表达式尽量反解析回可视化模式，匹配不上落到「自定义表达式」并保留原文，绝不丢条件。

type RuleType =
  | "contains"
  | "not-contains"
  | "verdict-pass"
  | "verdict-revise"
  | "chapter-pass"
  | "chapter-revise"
  | "visits-gte"
  | "visits-lt";

interface Rule {
  type: RuleType;
  text: string; // contains / not-contains
  label: string; // visits-*
  count: number; // visits-*
}

type Mode = "none" | "simple" | "custom";

interface CondModel {
  mode: Mode;
  combiner: "&&" | "||";
  rules: Rule[];
  custom: string;
}

const RULE_TYPES: { value: RuleType; label: string }[] = [
  { value: "contains", label: "输出包含文本" },
  { value: "not-contains", label: "输出不包含文本" },
  { value: "verdict-pass", label: "审核结论 = 通过" },
  { value: "verdict-revise", label: "审核结论 = 需修订" },
  { value: "chapter-pass", label: "结论标记 = PASS" },
  { value: "chapter-revise", label: "结论标记 = REVISE" },
  { value: "visits-gte", label: "节点执行次数 ≥" },
  { value: "visits-lt", label: "节点执行次数 <" }
];

const defaultRule = (): Rule => ({ type: "contains", text: "", label: "", count: 1 });

// ---- 表达式生成（与引擎 evalCondition 对齐）----

function ruleExpr(r: Rule): string {
  switch (r.type) {
    case "contains":
      return `String(output).includes(${JSON.stringify(r.text)})`;
    case "not-contains":
      return `!String(output).includes(${JSON.stringify(r.text)})`;
    case "verdict-pass":
      return `output.includes('"verdict":"pass"')`;
    case "verdict-revise":
      return `output.includes('"verdict":"revise"')`;
    case "chapter-pass":
      return `/CHAPTER_RESULT\\s*:\\s*PASS/i.test(String(output))`;
    case "chapter-revise":
      return `/CHAPTER_RESULT\\s*:\\s*REVISE/i.test(String(output))`;
    case "visits-gte":
      return `(context.visits[${JSON.stringify(r.label)}] || 0) >= ${r.count}`;
    case "visits-lt":
      return `(context.visits[${JSON.stringify(r.label)}] || 0) < ${r.count}`;
  }
}

function ruleValid(r: Rule): boolean {
  if (r.type === "contains" || r.type === "not-contains") return r.text.length > 0;
  if (r.type === "visits-gte" || r.type === "visits-lt") return r.label.trim().length > 0 && Number.isFinite(r.count);
  return true;
}

function buildExpr(m: CondModel): string {
  if (m.mode === "none") return "";
  if (m.mode === "custom") return m.custom.trim();
  const parts = m.rules.filter(ruleValid).map((r) => `(${ruleExpr(r)})`);
  return parts.join(m.combiner === "&&" ? " && " : " || ");
}

// ---- 反解析（已知形态回显到可视化控件）----

// 剥掉包裹整个表达式的最外层括号（可多层）；括号不包裹整体则原样返回
function stripOuterParens(s: string): string {
  let t = s.trim();
  for (;;) {
    if (!t.startsWith("(") || !t.endsWith(")")) return t;
    let depth = 0;
    let wraps = true;
    for (let i = 0; i < t.length; i++) {
      if (t[i] === "(") depth++;
      else if (t[i] === ")") depth--;
      if (depth === 0 && i < t.length - 1) {
        wraps = false;
        break;
      }
      if (depth < 0) {
        wraps = false;
        break;
      }
    }
    if (!wraps || depth !== 0) return t;
    t = t.slice(1, -1).trim();
  }
}

function unquote(token: string): string | null {
  if (token.length < 2) return null;
  if (token.startsWith('"')) {
    try {
      return JSON.parse(token) as string;
    } catch {
      return null;
    }
  }
  if (token.startsWith("'")) return token.slice(1, -1).replace(/\\'/g, "'");
  return null;
}

function matchSingle(raw: string): Rule | null {
  const s = stripOuterParens(raw);
  if (s === `output.includes('"verdict":"pass"')` || s === `String(output).includes('"verdict":"pass"')`) {
    return { ...defaultRule(), type: "verdict-pass" };
  }
  if (s === `output.includes('"verdict":"revise"')` || s === `String(output).includes('"verdict":"revise"')`) {
    return { ...defaultRule(), type: "verdict-revise" };
  }
  const chapter = /^\/CHAPTER_RESULT\\s\*:\\s\*(PASS|REVISE)\/i\.test\(String\(output\)\)$/.exec(s);
  if (chapter) {
    return { ...defaultRule(), type: chapter[1] === "PASS" ? "chapter-pass" : "chapter-revise" };
  }
  const visits =
    /^\(?\s*context\.visits\[("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\]\s*\|\|\s*0\s*\)?\s*(>=|<)\s*(\d+)$/.exec(s);
  if (visits) {
    const label = unquote(visits[1]);
    if (label === null) return null;
    return { type: visits[2] === ">=" ? "visits-gte" : "visits-lt", text: "", label, count: Number(visits[3]) };
  }
  const includes =
    /^(!)?\s*String\(output\)\.includes\(("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\)$/.exec(s);
  if (includes) {
    const text = unquote(includes[2]);
    if (text === null) return null;
    return { type: includes[1] ? "not-contains" : "contains", text, label: "", count: 1 };
  }
  return null;
}

// 顶层拆分 && / ||：跳过括号内（如 context.visits[x] || 0）和字符串内的连接符
function splitTopLevel(s: string): { combiner: "&&" | "||"; parts: string[] } | null {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let combiner: "&&" | "||" | null = null;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      cur += c;
      if (c === "\\") {
        cur += s[i + 1] ?? "";
        i++;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    if (c === "(") {
      depth++;
      cur += c;
      continue;
    }
    if (c === ")") {
      depth--;
      cur += c;
      continue;
    }
    if (depth === 0 && (c === "&" || c === "|") && s[i + 1] === c) {
      const op = c === "&" ? ("&&" as const) : ("||" as const);
      if (combiner && combiner !== op) return null; // && 与 || 混用，超出简单条件能力
      combiner = op;
      parts.push(cur.trim());
      cur = "";
      i++;
      continue;
    }
    cur += c;
  }
  parts.push(cur.trim());
  return { combiner: combiner ?? "&&", parts };
}

function parseCondition(expr: string): CondModel {
  const trimmed = expr.trim();
  if (!trimmed) return { mode: "none", combiner: "&&", rules: [defaultRule()], custom: "" };
  const split = splitTopLevel(trimmed);
  if (split && split.parts.length >= 1 && split.parts.length <= 2) {
    const rules = split.parts.map((p) => matchSingle(p));
    if (rules.every((r) => r !== null)) {
      return { mode: "simple", combiner: split.combiner, rules: rules as Rule[], custom: trimmed };
    }
  }
  return { mode: "custom", combiner: "&&", rules: [defaultRule()], custom: trimmed };
}

// ---- 组件 ----

export default function ConditionEditor({
  expr,
  nodeLabels,
  onChange
}: {
  expr: string;
  nodeLabels: string[];
  onChange: (expr: string) => void;
}) {
  const [model, setModel] = useState<CondModel>(() => parseCondition(expr));
  const listId = useId();

  function commit(next: CondModel) {
    setModel(next);
    onChange(buildExpr(next));
  }

  function setRule(i: number, patch: Partial<Rule>) {
    const rules = model.rules.map((r, idx) => (idx === i ? { ...r, ...patch } : r));
    commit({ ...model, rules });
  }

  function switchMode(mode: Mode) {
    if (mode === model.mode) return;
    if (mode === "simple") {
      // 尝试把当前表达式反解析回简单条件，失败则给一条空规则
      const parsed = parseCondition(model.mode === "custom" ? model.custom : buildExpr(model));
      commit({ ...parsed, mode: "simple" });
    } else if (mode === "custom") {
      commit({ ...model, mode, custom: buildExpr(model) || model.custom });
    } else {
      commit({ ...model, mode });
    }
  }

  const preview = buildExpr(model);

  return (
    <div className="cond-editor">
      <select
        className="text-input"
        value={model.mode}
        onChange={(e) => switchMode(e.target.value as Mode)}
      >
        <option value="none">无条件（总是执行）</option>
        <option value="simple">简单条件</option>
        <option value="custom">自定义表达式</option>
      </select>

      {model.mode === "simple" && (
        <div className="cond-rules">
          {model.rules.map((r, i) => (
            <div key={i} className="cond-rule">
              {i === 1 && (
                <div className="segmented small cond-combiner">
                  <button className={model.combiner === "&&" ? "active" : ""} onClick={() => commit({ ...model, combiner: "&&" })}>
                    且
                  </button>
                  <button className={model.combiner === "||" ? "active" : ""} onClick={() => commit({ ...model, combiner: "||" })}>
                    或
                  </button>
                </div>
              )}
              <div className="cond-rule-row">
                <select
                  className="text-input"
                  value={r.type}
                  onChange={(e) => setRule(i, { type: e.target.value as RuleType })}
                >
                  {RULE_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>{t.label}</option>
                  ))}
                </select>
                {i === 1 && (
                  <button
                    className="icon-button tiny"
                    title="移除该条件"
                    onClick={() => commit({ ...model, rules: [model.rules[0]] })}
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
              {(r.type === "contains" || r.type === "not-contains") && (
                <input
                  className="text-input"
                  value={r.text}
                  onChange={(e) => setRule(i, { text: e.target.value })}
                  placeholder="要匹配的文本…"
                />
              )}
              {(r.type === "visits-gte" || r.type === "visits-lt") && (
                <div className="cond-rule-row">
                  <input
                    className="text-input"
                    list={listId}
                    value={r.label}
                    onChange={(e) => setRule(i, { label: e.target.value })}
                    placeholder="节点名称，如：写手返修"
                  />
                  <input
                    className="text-input cond-count"
                    type="number"
                    min={0}
                    max={99}
                    value={r.count}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      if (Number.isFinite(n) && n >= 0) setRule(i, { count: Math.floor(n) });
                    }}
                  />
                </div>
              )}
            </div>
          ))}
          {model.rules.length === 1 && (
            <button
              className="ghost-button small"
              onClick={() => commit({ ...model, rules: [...model.rules, defaultRule()] })}
            >
              <Plus size={12} /> 添加条件
            </button>
          )}
          <datalist id={listId}>
            {nodeLabels.map((l) => (
              <option key={l} value={l} />
            ))}
          </datalist>
        </div>
      )}

      {model.mode === "custom" && (
        <textarea
          className="text-input"
          rows={3}
          value={model.custom}
          onChange={(e) => commit({ ...model, custom: e.target.value })}
          placeholder="output.includes('通过')"
        />
      )}

      <code className="cond-preview">{preview || "（无条件：总是执行）"}</code>
    </div>
  );
}
