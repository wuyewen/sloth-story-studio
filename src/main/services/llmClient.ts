import type { WebContents } from "electron";
import type { ChatMessage, ModelProvider } from "../../shared/types.js";

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

const streamControllers = new Map<string, AbortController>();

export function abortStream(requestId: string): void {
  streamControllers.get(requestId)?.abort();
}

interface ChatCompletionChoice {
  message?: { content?: string | null };
}

interface ChatCompletionResponse {
  choices?: ChatCompletionChoice[];
}

export async function chat(
  provider: ModelProvider,
  apiKey: string,
  messages: ChatMessage[],
  opts: ChatOptions = {}
): Promise<string> {
  const baseUrl = provider.baseUrl.replace(/\/+$/, "");
  const body: Record<string, unknown> = {
    model: provider.model,
    messages,
    stream: false
  };
  // max_tokens 只在显式指定时发送；contextLength 是模型的上下文窗口参考值，不作为输出上限
  if (opts.maxTokens) body.max_tokens = opts.maxTokens;
  if (opts.temperature !== undefined) body.temperature = opts.temperature;
  if (provider.enableThinking) body.enable_thinking = true;

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(body),
    signal: opts.signal
  });

  if (!res.ok) {
    const text = (await res.text().catch(() => "")).slice(0, 500);
    throw new Error(`LLM 请求失败 (HTTP ${res.status}): ${text}`);
  }

  const data = (await res.json()) as ChatCompletionResponse;
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new Error("LLM 响应缺少 content 字段");
  }
  return content;
}

export async function chatStream(
  webContents: WebContents,
  requestId: string,
  provider: ModelProvider,
  apiKey: string,
  messages: ChatMessage[],
  opts: ChatOptions = {}
): Promise<void> {
  const controller = new AbortController();
  streamControllers.set(requestId, controller);
  try {
    const baseUrl = provider.baseUrl.replace(/\/+$/, "");
    const body: Record<string, unknown> = {
      model: provider.model,
      messages,
      stream: true
    };
    const maxTokens = opts.maxTokens;
    if (maxTokens) body.max_tokens = maxTokens;
    if (opts.temperature !== undefined) body.temperature = opts.temperature;
    if (provider.enableThinking) body.enable_thinking = true;

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!res.ok || !res.body) {
      const text = (await res.text().catch(() => "")).slice(0, 500);
      throw new Error(`LLM 请求失败 (HTTP ${res.status}): ${text}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const handleLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) return;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") return;
      try {
        const json = JSON.parse(payload) as {
          choices?: Array<{ delta?: { content?: string | null } }>;
        };
        const delta = json.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta.length > 0 && !webContents.isDestroyed()) {
          webContents.send("llm:chunk", { requestId, delta });
        }
      } catch {
        // 忽略不完整/非 JSON 的 SSE 行
      }
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        handleLine(line);
      }
    }
    if (buffer.trim()) handleLine(buffer);

    if (!webContents.isDestroyed()) {
      webContents.send("llm:done", { requestId });
    }
  } catch (err) {
    if (!webContents.isDestroyed()) {
      if (controller.signal.aborted) {
        webContents.send("llm:done", { requestId });
      } else {
        webContents.send("llm:error", {
          requestId,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }
  } finally {
    streamControllers.delete(requestId);
  }
}
