import { useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, Eye, Loader2, SendHorizonal } from "lucide-react";
import { sloth } from "../../../api";
import { Modal } from "../../components/Modal";
import { Markdown } from "../editor/Markdown";
import type { NovelProject, WorkflowDef, WorkflowRunEvent } from "../../../../shared/types";

// 极简创作模式：对话式写小说，底层复用现有流水线（规划/章节槽位工作流、提案、记忆提取）
// 确定性状态机，不做自由意图识别：无全书大纲 → 跑规划槽位；有大纲 → 写下一章。

interface Msg {
  id: number;
  role: "user" | "system";
  kind: "text" | "progress" | "plan" | "chapter" | "error";
  text: string;
  // progress
  currentNode?: string;
  doneCount?: number;
  // chapter 卡片
  chapterId?: string;
  chapterTitle?: string;
  words?: number;
  memApplied?: number;
  memConflicts?: number;
}

const countWords = (text: string) => text.replace(/\s/g, "").length;

export default function SimpleMode({
  project,
  workflows,
  refreshProjects
}: {
  project: NovelProject;
  workflows: WorkflowDef[];
  refreshProjects: () => Promise<void>;
}) {
  const [messages, setMessages] = useState<Msg[]>([
    {
      id: 0,
      role: "system",
      kind: "text",
      text: "告诉我这本书想写什么（题材、创意、想要的风格都可以），我先为你做全书规划；有大纲后，再说一句想怎么开头就开始写。"
    }
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ title: string; content: string } | null>(null);
  const [capInput, setCapInput] = useState(project.unitChapterCap ? String(project.unitChapterCap) : "");
  const seqRef = useRef(1);
  const listRef = useRef<HTMLDivElement>(null);

  // 切换项目时同步上限输入框
  useEffect(() => {
    setCapInput(project.unitChapterCap ? String(project.unitChapterCap) : "");
  }, [project.id]);

  // 变更即存：空/0/非法 = 不限，1-50 取整
  async function saveCap() {
    if (!sloth) return;
    const n = Number(capInput);
    const cap = capInput.trim() && Number.isFinite(n) && n >= 1 ? Math.min(50, Math.floor(n)) : null;
    if ((cap ?? null) === (project.unitChapterCap ?? null)) return;
    await sloth.novels.updateMeta(project.id, { unitChapterCap: cap });
    await refreshProjects();
  }

  // 章节目录：按单元分组
  const toc = useMemo(
    () =>
      project.units.map((u) => ({
        unit: u,
        chapters: u.chapterIds
          .map((id) => project.chapters.find((c) => c.id === id))
          .filter((c): c is NonNullable<typeof c> => Boolean(c))
      })),
    [project]
  );

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages]);

  function push(msg: Omit<Msg, "id">): number {
    const id = seqRef.current++;
    setMessages((m) => [...m, { ...msg, id }]);
    return id;
  }

  function patchMsg(id: number, patch: Partial<Msg>): void {
    setMessages((m) => m.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  }

  async function openPreview(chapterId: string, title: string) {
    if (!sloth) return;
    setPreview({ title, content: await sloth.novels.readChapter(project.id, chapterId) });
  }

  // 订阅一次运行的节点事件，把简版进度写进指定消息卡片
  function watchRun(runId: string, progressMsgId: number): () => void {
    let done = 0;
    return sloth!.workflows.onEvent((ev: WorkflowRunEvent) => {
      if (ev.runId !== runId) return;
      if (ev.type === "node-start") {
        patchMsg(progressMsgId, { currentNode: ev.label ?? "节点" });
      } else if (ev.type === "node-done" || ev.type === "node-error") {
        done += 1;
        patchMsg(progressMsgId, { doneCount: done });
      }
    });
  }

  async function runWfOnce(wf: WorkflowDef, input: string, progressMsgId: number): Promise<{ finalOutput?: string; error?: string }> {
    const runId = crypto.randomUUID();
    const off = watchRun(runId, progressMsgId);
    try {
      return await sloth!.workflows.run(runId, wf.id, input, project.id);
    } finally {
      off();
    }
  }

  // 自动接受全部 pending 提案（冲突跳过计数）
  async function applyPendingProposals(): Promise<{ applied: number; skipped: number }> {
    let applied = 0;
    let skipped = 0;
    try {
      const pending = (await sloth!.proposals.list(project.id)).filter((p) => p.status === "pending");
      for (const p of pending) {
        const r = await sloth!.proposals.accept(project.id, p.id);
        if (r.conflict) skipped++;
        else applied++;
      }
    } catch {
      // 提案应用失败不阻塞主流程
    }
    return { applied, skipped };
  }

  // 单元标题顺延（与编辑器一致：按现有最大编号 +1）
  function nextUnitTitle(proj: NovelProject): string {
    const nums = proj.units
      .map((u) => /第\s*(\d+)\s*单元/.exec(u.title)?.[1])
      .filter((n): n is string => Boolean(n))
      .map(Number);
    const next = nums.length > 0 ? Math.max(...nums) + 1 : 1;
    return `第 ${next} 单元`;
  }

  async function doPlanning(text: string, progressMsgId: number): Promise<void> {
    const wf = workflows.find((w) => w.id === project.workflowSlots?.planning) ?? null;
    if (!wf) {
      push({ role: "system", kind: "error", text: "未绑定「全书规划」槽位的工作流。请到专业模式的工作流管理里绑定后再试。" });
      return;
    }
    patchMsg(progressMsgId, { text: "先为你做全书规划…" });
    const res = await runWfOnce(wf, text, progressMsgId);
    if (res.error || !res.finalOutput) {
      push({
        role: "system",
        kind: "error",
        text: `全书规划失败：${res.error ?? "没有产出"}。可从专业模式的运行记录里断点继续。`
      });
      return;
    }
    // 自动接受本次运行产生的全部 pending 提案（冲突跳过）
    const { applied, skipped } = await applyPendingProposals();
    push({
      role: "system",
      kind: "plan",
      text:
        `${res.finalOutput.slice(0, 500)}${res.finalOutput.length > 500 ? "…" : ""}\n\n` +
        `已生成全书规划${applied > 0 ? `，记忆提案已应用 ${applied} 条` : ""}${skipped > 0 ? `，${skipped} 条冲突已跳过` : ""}，` +
        `可在「记忆管理」查看/调整。再说一句想怎么开头，我就开始写。`
    });
  }

  async function doChapter(text: string, progressMsgId: number): Promise<void> {
    let proj = project; // 局部跟随刷新（createUnit/createChapter 返回最新项目数据）
    // 没有单元先自动建
    let unitMeta = proj.units[proj.units.length - 1] ?? null;
    if (!unitMeta) {
      const list = await sloth!.novels.createUnit(proj.id, "第 1 单元");
      proj = list.find((p) => p.id === proj.id) ?? proj;
      unitMeta = proj.units[proj.units.length - 1] ?? null;
      await refreshProjects();
    }

    // ---- 单元完结序列：达到每单元章数上限时，先复盘归档、再规划新单元、最后写新单元第一章 ----
    let finale: { finishedUnit: string; newUnit: string } | null = null;
    const cap = proj.unitChapterCap;
    if (unitMeta && typeof cap === "number" && cap > 0) {
      const chapterCount = unitMeta.chapterIds.filter((id) => proj.chapters.some((c) => c.id === id)).length;
      if (chapterCount >= cap) {
        const finishedUnit = unitMeta.title;
        // 1) 单元复盘（未绑定槽位则跳过并提示；失败降级继续）
        const reviewWf = workflows.find((w) => w.id === proj.workflowSlots?.review) ?? null;
        if (reviewWf) {
          patchMsg(progressMsgId, { text: `单元「${finishedUnit}」已写满 ${chapterCount} 章，正在复盘归档…`, currentNode: "", doneCount: 0 });
          const r = await runWfOnce(reviewWf, `单元「${finishedUnit}」已写满 ${chapterCount} 章，请复盘归档`, progressMsgId);
          if (r.error) {
            push({ role: "system", kind: "text", text: `单元复盘失败：${r.error}。不影响继续，直接规划新单元。` });
          } else {
            const { applied, skipped } = await applyPendingProposals();
            push({
              role: "system",
              kind: "text",
              text: `单元「${finishedUnit}」复盘完成 ✓${applied > 0 ? `（提案应用 ${applied} 条${skipped > 0 ? `，${skipped} 条冲突跳过` : ""}）` : ""}`
            });
          }
        } else {
          push({ role: "system", kind: "text", text: "未绑定「单元复盘」槽位工作流，跳过复盘步骤。" });
        }
        // 2) 建新单元 + 规划（规划失败则中止，不写章）
        const newTitle = nextUnitTitle(proj);
        const list = await sloth!.novels.createUnit(proj.id, newTitle);
        proj = list.find((p) => p.id === proj.id) ?? proj;
        await refreshProjects();
        const newUnit = proj.units[proj.units.length - 1];
        if (!newUnit) {
          push({ role: "system", kind: "error", text: "新建单元失败，已中止。旧单元内容不受影响。" });
          return;
        }
        const unitWf = workflows.find((w) => w.id === proj.workflowSlots?.unit) ?? null;
        if (unitWf) {
          patchMsg(progressMsgId, { text: `正在规划新单元「${newUnit.title}」…`, currentNode: "", doneCount: 0 });
          // 用户原话若不只是"继续/写下一章"类指令，作为方向附上
          const directive = /^(继续|写下一章|下一章|接着写|继续写|继续写下去)\s*[。！!]*$/.test(text) ? "" : text;
          const r = await runWfOnce(
            unitWf,
            `按全书大纲规划下一单元${directive ? `\n\n方向参考：${directive}` : ""}`,
            progressMsgId
          );
          if (r.error || !r.finalOutput) {
            push({
              role: "system",
              kind: "error",
              text: `新单元规划失败：${r.error ?? "没有产出"}。已中止本章写作；旧单元已完结不回滚，可到专业模式重试规划，或直接再发一句重试。`
            });
            return;
          }
          const { applied, skipped } = await applyPendingProposals();
          push({
            role: "system",
            kind: "text",
            text: `新单元「${newUnit.title}」规划完成 ✓${applied > 0 ? `（提案应用 ${applied} 条${skipped > 0 ? `，${skipped} 条冲突跳过` : ""}）` : ""}`
          });
        } else {
          push({ role: "system", kind: "text", text: "未绑定「规划新单元」槽位工作流，已直接在新单元开写。" });
        }
        unitMeta = newUnit;
        finale = { finishedUnit, newUnit: newUnit.title };
      }
    }

    // 3) 正常章节流水线
    const wf =
      workflows.find((w) => w.id === proj.workflowSlots?.chapter) ??
      workflows.find((w) => w.name.includes("章节创作")) ??
      null;
    if (!wf) {
      push({ role: "system", kind: "error", text: "未绑定「章节创作」槽位的工作流。请到专业模式的工作流管理里绑定后再试。" });
      return;
    }
    patchMsg(progressMsgId, { text: finale ? "新单元就位，正在写第 1 章…" : "正在写下一章…", currentNode: "", doneCount: 0 });
    const res = await runWfOnce(wf, text, progressMsgId);
    if (res.error || !res.finalOutput) {
      push({
        role: "system",
        kind: "error",
        text: `本章创作失败：${res.error ?? "没有产出"}。可从专业模式的运行记录里断点继续。`
      });
      return;
    }
    // 存新章节（进入当前单元）
    const finalOutput = res.finalOutput;
    const firstLine = finalOutput.split(/\r?\n/).find((l) => l.trim())?.trim() ?? "";
    const title = firstLine.replace(/^#+\s*/, "").slice(0, 12) || `第 ${proj.chapters.length + 1} 章`;
    const list = await sloth!.novels.createChapter(proj.id, title, unitMeta?.id ?? undefined);
    const updated = list.find((p) => p.id === proj.id);
    const created = updated?.chapters[updated.chapters.length - 1];
    if (!created) {
      push({ role: "system", kind: "error", text: "章节已生成但保存失败（建章节失败），最终输出可在运行记录中找到。" });
      return;
    }
    await sloth!.novels.writeChapter(proj.id, created.id, finalOutput, "workflow");
    // 自动提取记忆：new/update 落库，conflict 计数
    let memApplied = 0;
    let memConflicts = 0;
    try {
      const ex = await sloth!.novels.extractChapterState(proj.id, { unitId: unitMeta?.id ?? undefined, chapterId: created.id });
      for (const it of ex.items) {
        if (it.relation === "conflict") {
          memConflicts++;
          continue;
        }
        await sloth!.novels.stateUpsert(proj.id, {
          type: it.entity.type,
          name: it.entity.name,
          data: it.entity.data,
          status: it.entity.status,
          ...(it.entity.source ? { source: it.entity.source } : {})
        });
        memApplied++;
      }
    } catch {
      // 记忆提取失败不影响章节回复
    }
    await refreshProjects();
    push({
      role: "system",
      kind: "chapter",
      text: `✓ 《${created.title}》已完成`,
      chapterId: created.id,
      chapterTitle: created.title,
      words: countWords(finalOutput),
      memApplied,
      memConflicts
    });
    if (finale) {
      push({
        role: "system",
        kind: "text",
        text: `单元「${finale.finishedUnit}」已完结归档 ✓ 新单元「${finale.newUnit}」已规划 ✓ 第 1 章已写完（点上方卡片可预览全文）`
      });
    }
  }

  async function send() {
    const text = input.trim();
    if (!sloth || !text || busy) return;
    setInput("");
    push({ role: "user", kind: "text", text });
    const progressMsgId = push({ role: "system", kind: "progress", text: "正在准备…", currentNode: "", doneCount: 0 });
    setBusy(true);
    try {
      const memFiles = await sloth.novels.memoryList(project.id);
      const hasOutline = memFiles.some((f) => f.rel === "master-outline.md");
      if (hasOutline) await doChapter(text, progressMsgId);
      else await doPlanning(text, progressMsgId);
    } catch (err) {
      push({
        role: "system",
        kind: "error",
        text: `出了点问题：${err instanceof Error ? err.message : String(err)}。可从运行记录里断点继续。`
      });
    } finally {
      // 移除进度卡片（结果卡片已单独发出）
      setMessages((m) => m.filter((x) => x.id !== progressMsgId));
      setBusy(false);
    }
  }

  return (
    <div className="simple-mode">
      <div className="simple-toc">
        <div className="col-head"><BookOpen size={13} /> 章节目录</div>
        <div className="simple-toc-list">
          {toc.map((g) => (
            <div key={g.unit.id} className="simple-toc-group">
              <div className="unit-head">{g.unit.title}</div>
              {g.chapters.length === 0 && <div className="unit-empty">暂无章节</div>}
              {g.chapters.map((c) => (
                <button key={c.id} className="simple-toc-item" onClick={() => void openPreview(c.id, c.title)}>
                  <span>{c.title}</span>
                  <small>{c.words} 字</small>
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>

      <div className="simple-chat">
        <div className="simple-cap-row">
          <label className="simple-cap">
            每单元章数上限
            <input
              className="text-input"
              type="number"
              min={1}
              max={50}
              value={capInput}
              disabled={busy}
              placeholder="不限"
              onChange={(e) => setCapInput(e.target.value)}
              onBlur={() => void saveCap()}
              onKeyDown={(e) => e.key === "Enter" && void saveCap()}
            />
          </label>
          <small>不设限：所有章节都在当前单元；设限后写满自动复盘归档并开启新单元</small>
        </div>
        <div className="simple-msgs" ref={listRef}>
          {messages.map((m) =>
            m.role === "user" ? (
              <div key={m.id} className="simple-msg user">{m.text}</div>
            ) : (
              <div key={m.id} className={`simple-msg sys kind-${m.kind}`}>
                {m.kind === "progress" && (
                  <span className="simple-progress">
                    <Loader2 size={13} className="spin" />
                    {m.text}
                    {m.currentNode ? `（当前：${m.currentNode}，已完成 ${m.doneCount ?? 0} 个节点）` : ""}
                  </span>
                )}
                {m.kind === "chapter" ? (
                  <>
                    <div className="simple-chapter-head">
                      <strong>{m.text}</strong>
                      <button className="ghost-button small" onClick={() => m.chapterId && void openPreview(m.chapterId, m.chapterTitle ?? "")}>
                        <Eye size={12} /> 预览
                      </button>
                    </div>
                    <small>
                      {m.words} 字 · 记忆更新 {m.memApplied ?? 0} 条
                      {(m.memConflicts ?? 0) > 0 && ` · ${m.memConflicts} 条冲突待处理（记忆管理 → 结构化状态）`}
                    </small>
                  </>
                ) : (
                  m.kind !== "progress" && <span className="simple-text">{m.text}</span>
                )}
              </div>
            )
          )}
        </div>
        <div className="simple-input-row">
          <textarea
            className="text-input simple-input"
            rows={2}
            value={input}
            disabled={busy}
            placeholder={busy ? "正在创作中…" : "想怎么写，直接说……（Enter 发送，Shift+Enter 换行）"}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <button className="primary-button simple-send" disabled={busy || !input.trim()} onClick={() => void send()}>
            {busy ? <Loader2 size={14} className="spin" /> : <SendHorizonal size={14} />}
          </button>
        </div>
      </div>

      {preview && (
        <Modal title={preview.title} onClose={() => setPreview(null)} width={720}>
          <div className="editor-preview simple-preview">
            <Markdown text={preview.content} />
          </div>
        </Modal>
      )}
    </div>
  );
}
