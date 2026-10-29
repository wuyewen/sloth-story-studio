// 条件表达式白名单安全求值器（F-01）：替代 new Function 动态执行。
// 仅支持 ConditionEditor 可生成的形态与历史存量形态：
// - 字符串/数字/true/false 字面量
// - 标识符仅 output（字符串）与 context.visits[字符串|标识符]
// - 调用仅 String(output)、output.includes("...")/String(output).includes("...")、/regex/flags.test(String(output))
// - 运算符 && || ! === !== >= <= > < 与括号
// 其余一律解析失败（由调用方决定拒绝策略）。

type Tok =
  | { t: "str"; v: string }
  | { t: "num"; v: number }
  | { t: "ident"; v: string }
  | { t: "regex"; v: string; flags: string }
  | { t: "punct"; v: string };

const PUNCTS = ["===", "!==", "&&", "||", ">=", "<=", "(", ")", "[", "]", ".", ",", "!", ">", "<"];

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const isIdentStart = (c: string) => /[A-Za-z_$一-鿿]/.test(c);
  const isIdentChar = (c: string) => /[A-Za-z0-9_$一-鿿]/.test(c);
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const q = c;
      let j = i + 1;
      let out = "";
      for (;;) {
        if (j >= src.length) throw new Error("字符串未闭合");
        if (src[j] === "\\") {
          if (j + 1 >= src.length) throw new Error("字符串转义不完整");
          out += src[j + 1];
          j += 2;
          continue;
        }
        if (src[j] === q) break;
        out += src[j];
        j++;
      }
      toks.push({ t: "str", v: out });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      const v = Number(src.slice(i, j));
      if (!Number.isFinite(v)) throw new Error("非法数字");
      toks.push({ t: "num", v });
      i = j;
      continue;
    }
    if (c === "/") {
      // 正则字面量（本语法不支持除法，/ 只出现在此位置）
      let j = i + 1;
      let pattern = "";
      let inClass = false;
      for (;;) {
        if (j >= src.length) throw new Error("正则未闭合");
        if (src[j] === "\\") {
          if (j + 1 >= src.length) throw new Error("正则转义不完整");
          pattern += src[j] + src[j + 1];
          j += 2;
          continue;
        }
        if (src[j] === "[") inClass = true;
        else if (src[j] === "]") inClass = false;
        else if (src[j] === "/" && !inClass) break;
        pattern += src[j];
        j++;
      }
      let flags = "";
      j++;
      while (j < src.length && /[a-z]/.test(src[j])) flags += src[j++];
      if (!/^[ims]*$/.test(flags)) throw new Error(`不支持的正则标志：${flags}`);
      toks.push({ t: "regex", v: pattern, flags });
      i = j;
      continue;
    }
    if (isIdentStart(c)) {
      let j = i;
      while (j < src.length && isIdentChar(src[j])) j++;
      toks.push({ t: "ident", v: src.slice(i, j) });
      i = j;
      continue;
    }
    const punct = PUNCTS.find((p) => src.startsWith(p, i));
    if (punct) {
      toks.push({ t: "punct", v: punct });
      i += punct.length;
      continue;
    }
    throw new Error(`不支持的字符：${c}`);
  }
  return toks;
}

type Ast =
  | { k: "lit"; v: string | number | boolean }
  | { k: "output" }
  | { k: "visits"; key: string }
  | { k: "includes"; needle: string }
  | { k: "regexTest"; pattern: string; flags: string }
  | { k: "not"; a: Ast }
  | { k: "and" | "or"; l: Ast; r: Ast }
  | { k: "cmp"; op: string; l: Ast; r: Ast };

class Parser {
  private pos = 0;
  constructor(private toks: Tok[]) {}

  private peek(): Tok | null {
    return this.toks[this.pos] ?? null;
  }
  private next(): Tok {
    const t = this.toks[this.pos++];
    if (!t) throw new Error("表达式意外结束");
    return t;
  }
  private expectPunct(v: string): void {
    const t = this.next();
    if (t.t !== "punct" || t.v !== v) throw new Error(`期望 ${v}`);
  }
  private expectIdent(v: string): void {
    const t = this.next();
    if (t.t !== "ident" || t.v !== v) throw new Error(`期望标识符 ${v}`);
  }

  parse(): Ast {
    const ast = this.orExpr();
    if (this.pos !== this.toks.length) throw new Error("表达式有多余内容");
    return ast;
  }

  private orExpr(): Ast {
    let l = this.andExpr();
    while (this.peek()?.t === "punct" && (this.peek() as { v: string }).v === "||") {
      this.next();
      l = { k: "or", l, r: this.andExpr() };
    }
    return l;
  }

  private andExpr(): Ast {
    let l = this.cmpExpr();
    while (this.peek()?.t === "punct" && (this.peek() as { v: string }).v === "&&") {
      this.next();
      l = { k: "and", l, r: this.cmpExpr() };
    }
    return l;
  }

  private cmpExpr(): Ast {
    const l = this.unaryExpr();
    const t = this.peek();
    if (t?.t === "punct" && ["===", "!==", ">=", "<=", ">", "<"].includes(t.v)) {
      this.next();
      return { k: "cmp", op: t.v, l, r: this.unaryExpr() };
    }
    return l;
  }

  private unaryExpr(): Ast {
    const t = this.peek();
    if (t?.t === "punct" && t.v === "!") {
      this.next();
      return { k: "not", a: this.unaryExpr() };
    }
    return this.primary();
  }

  private primary(): Ast {
    const t = this.next();
    if (t.t === "str") return { k: "lit", v: t.v };
    if (t.t === "num") return { k: "lit", v: t.v };
    if (t.t === "regex") {
      // 仅允许 /re/flags.test(String(output))
      this.expectPunct(".");
      this.expectIdent("test");
      this.expectPunct("(");
      this.expectIdent("String");
      this.expectPunct("(");
      this.expectIdent("output");
      this.expectPunct(")");
      this.expectPunct(")");
      return { k: "regexTest", pattern: t.v, flags: t.flags };
    }
    if (t.t === "punct" && t.v === "(") {
      const inner = this.orExpr();
      this.expectPunct(")");
      return inner;
    }
    if (t.t === "ident") {
      if (t.v === "true") return { k: "lit", v: true };
      if (t.v === "false") return { k: "lit", v: false };
      if (t.v === "output") {
        // 允许 output 或 output.includes("...")
        const dot = this.peek();
        if (dot?.t === "punct" && dot.v === ".") {
          this.next();
          this.expectIdent("includes");
          this.expectPunct("(");
          const arg = this.next();
          if (arg.t !== "str") throw new Error("includes 只接受字符串字面量");
          this.expectPunct(")");
          return { k: "includes", needle: arg.v };
        }
        return { k: "output" };
      }
      if (t.v === "String") {
        // 仅允许 String(output)[.includes("...")]
        this.expectPunct("(");
        this.expectIdent("output");
        this.expectPunct(")");
        const dot = this.peek();
        if (dot?.t === "punct" && dot.v === ".") {
          this.next();
          this.expectIdent("includes");
          this.expectPunct("(");
          const arg = this.next();
          if (arg.t !== "str") throw new Error("includes 只接受字符串字面量");
          this.expectPunct(")");
          return { k: "includes", needle: arg.v };
        }
        return { k: "output" };
      }
      if (t.v === "context") {
        // 仅允许 context.visits[字符串|标识符]
        this.expectPunct(".");
        this.expectIdent("visits");
        this.expectPunct("[");
        const key = this.next();
        if (key.t !== "str" && key.t !== "ident") throw new Error("context.visits 下标只接受字符串或标识符");
        this.expectPunct("]");
        return { k: "visits", key: key.v };
      }
      throw new Error(`不允许的标识符：${t.v}`);
    }
    throw new Error("非法表达式");
  }
}

type Value = string | number | boolean;

function truthy(v: Value): boolean {
  return Boolean(v);
}

function evalAst(ast: Ast, output: string, context: Record<string, unknown>): Value {
  switch (ast.k) {
    case "lit":
      return ast.v;
    case "output":
      return output;
    case "visits": {
      const visits = context.visits as Record<string, unknown> | undefined;
      const n = Number(visits?.[ast.key] ?? 0);
      return Number.isFinite(n) ? n : 0;
    }
    case "includes":
      return output.includes(ast.needle);
    case "regexTest":
      return new RegExp(ast.pattern, ast.flags).test(String(output));
    case "not":
      return !truthy(evalAst(ast.a, output, context));
    case "and": {
      const l = evalAst(ast.l, output, context);
      return truthy(l) ? evalAst(ast.r, output, context) : l;
    }
    case "or": {
      const l = evalAst(ast.l, output, context);
      return truthy(l) ? l : evalAst(ast.r, output, context);
    }
    case "cmp": {
      const l = evalAst(ast.l, output, context);
      const r = evalAst(ast.r, output, context);
      switch (ast.op) {
        case "===":
          return l === r;
        case "!==":
          return l !== r;
        case ">=":
          return (l as number) >= (r as number);
        case "<=":
          return (l as number) <= (r as number);
        case ">":
          return (l as number) > (r as number);
        case "<":
          return (l as number) < (r as number);
        default:
          throw new Error(`不支持的运算符：${ast.op}`);
      }
    }
  }
}

// 解析并求值；任何不被白名单支持的形态都会抛错
export function evalConditionExpr(expr: string, output: string, context: Record<string, unknown>): boolean {
  const ast = new Parser(tokenize(expr)).parse();
  return truthy(evalAst(ast, output, context));
}

// 仅校验表达式能否被白名单求值器解析（保存/生成工作流时用）
export function isSafeCondition(expr: string): boolean {
  try {
    new Parser(tokenize(expr)).parse();
    return true;
  } catch {
    return false;
  }
}
