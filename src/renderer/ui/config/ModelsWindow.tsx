import { useEffect, useState } from "react";
import { Plus, Trash2, PlugZap } from "lucide-react";
import { sloth } from "../../api";
import { useStudio } from "../../state/store";
import { BridgeMissing, ConfirmDialog } from "../components/Modal";
import type { ModelProviderInfo } from "../../../shared/types";

interface FormState {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  displayName: string;
  enableThinking: boolean;
  sendTemperature: boolean;
  contextLength: string;
  enabled: boolean;
}

const blank: FormState = {
  name: "",
  baseUrl: "",
  apiKey: "",
  model: "",
  displayName: "",
  enableThinking: false,
  sendTemperature: true,
  contextLength: "",
  enabled: true
};

function fromProvider(p: ModelProviderInfo): FormState {
  return {
    name: p.name,
    baseUrl: p.baseUrl,
    apiKey: "",
    model: p.model,
    displayName: p.displayName,
    enableThinking: p.enableThinking,
    sendTemperature: p.sendTemperature !== false,
    contextLength: p.contextLength == null ? "" : String(p.contextLength),
    enabled: p.enabled
  };
}

export default function ModelsWindow() {
  const providers = useStudio((s) => s.providers);
  const refresh = useStudio((s) => s.refreshProviders);
  const init = useStudio((s) => s.init);
  const ready = useStudio((s) => s.ready);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(blank);
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    void init();
  }, [init]);

  useEffect(() => {
    if (selectedId) {
      const p = providers.find((x) => x.id === selectedId);
      if (p) setForm(fromProvider(p));
    }
  }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!sloth) return <BridgeMissing />;
  if (!ready) return <div className="app-loading">加载中…</div>;

  const selected = providers.find((p) => p.id === selectedId) ?? null;

  function startNew() {
    setSelectedId(null);
    setForm(blank);
    setMessage(null);
  }

  function patch(patch: Partial<FormState>) {
    setForm((f) => ({ ...f, ...patch }));
  }

  async function save() {
    if (!form.name.trim() || !form.baseUrl.trim() || !form.model.trim() || !form.displayName.trim()) {
      setMessage({ kind: "err", text: "请填写名称、地址、Model 与显示名称。" });
      return;
    }
    const isNew = !selectedId;
    if (isNew && !form.apiKey.trim()) {
      setMessage({ kind: "err", text: "新建配置必须填写 API Key。" });
      return;
    }
    const contextLength = form.contextLength.trim() === "" ? null : Number(form.contextLength);
    if (contextLength != null && (!Number.isFinite(contextLength) || contextLength <= 0)) {
      setMessage({ kind: "err", text: "上下文长度必须是正整数。" });
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      await sloth!.models.save({
        id: selectedId ?? undefined,
        name: form.name.trim(),
        baseUrl: form.baseUrl.trim(),
        apiKey: form.apiKey,
        model: form.model.trim(),
        displayName: form.displayName.trim(),
        enableThinking: form.enableThinking,
        sendTemperature: form.sendTemperature,
        contextLength,
        enabled: form.enabled
      });
      await refresh();
      setMessage({ kind: "ok", text: "已保存。" });
      patch({ apiKey: "" });
    } catch (e) {
      setMessage({ kind: "err", text: `保存失败：${String(e)}` });
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!selectedId) return;
    await sloth!.models.remove(selectedId);
    setConfirmDelete(false);
    startNew();
    await refresh();
  }

  async function test() {
    if (!form.baseUrl.trim() || !form.model.trim()) {
      setMessage({ kind: "err", text: "请先填写地址与 Model。" });
      return;
    }
    if (!form.apiKey.trim() && !selected?.hasKey) {
      setMessage({ kind: "err", text: "请先填写 API Key。" });
      return;
    }
    setTesting(true);
    setMessage(null);
    try {
      const contextLength = form.contextLength.trim() === "" ? null : Number(form.contextLength);
      const r = await sloth!.models.test({
        id: selectedId ?? undefined,
        name: form.name.trim() || "test",
        baseUrl: form.baseUrl.trim(),
        apiKey: form.apiKey,
        model: form.model.trim(),
        displayName: form.displayName.trim() || form.model.trim(),
        enableThinking: form.enableThinking,
        sendTemperature: form.sendTemperature,
        contextLength,
        enabled: form.enabled
      });
      setMessage({ kind: r.ok ? "ok" : "err", text: r.message });
    } catch (e) {
      setMessage({ kind: "err", text: `测试失败：${String(e)}` });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="config-shell">
      <div className="config-panel">
        <div className="config-head">
          <img src="assets/branding/app-icon-512.png" alt="" />
          <div>
            <h1>大模型配置</h1>
            <p>管理用于 AI 写作的 OpenAI 兼容模型服务。</p>
          </div>
        </div>

        <div className="model-layout">
          <div className="model-side">
            <button className="primary-button model-new" onClick={startNew}>
              <Plus size={15} /> 新增
            </button>
            <div className="model-list">
              {providers.map((p) => (
                <button
                  key={p.id}
                  className={`model-item ${p.id === selectedId ? "active" : ""}`}
                  onClick={() => {
                    setSelectedId(p.id);
                    setMessage(null);
                  }}
                >
                  <strong>{p.displayName}</strong>
                  <small>
                    {p.model}
                    {!p.enabled && " · 已停用"}
                  </small>
                </button>
              ))}
              {providers.length === 0 && <p className="model-empty">还没有配置，点击「新增」开始。</p>}
            </div>
          </div>

          <div className="model-form">
            <label className="form-row">
              <span className="form-label">名称</span>
              <input className="text-input" value={form.name} onChange={(e) => patch({ name: e.target.value })} placeholder="例如：DeepSeek 官方" />
            </label>
            <label className="form-row">
              <span className="form-label">地址 baseUrl</span>
              <input className="text-input" value={form.baseUrl} onChange={(e) => patch({ baseUrl: e.target.value })} placeholder="https://api.deepseek.com/v1" />
            </label>
            <label className="form-row">
              <span className="form-label">API Key</span>
              <input
                className="text-input"
                type="password"
                value={form.apiKey}
                onChange={(e) => patch({ apiKey: e.target.value })}
                placeholder={selected?.hasKey ? "已保存，输入以更换" : "sk-..."}
              />
            </label>
            <div className="form-grid">
              <label className="form-row">
                <span className="form-label">Model</span>
                <input className="text-input" value={form.model} onChange={(e) => patch({ model: e.target.value })} placeholder="deepseek-chat" />
              </label>
              <label className="form-row">
                <span className="form-label">显示名称</span>
                <input className="text-input" value={form.displayName} onChange={(e) => patch({ displayName: e.target.value })} placeholder="DeepSeek V3" />
              </label>
            </div>
            <div className="form-grid">
              <div className="form-row">
                <span className="form-label">上下文长度（可选，单位：tokens）</span>
                <div className="ctx-row">
                  <input
                    className="text-input"
                    type="number"
                    min={1}
                    value={form.contextLength}
                    disabled={form.contextLength === "1000000"}
                    onChange={(e) => patch({ contextLength: e.target.value })}
                    placeholder="例如 8192"
                  />
                  <label className="check-item">
                    <input
                      type="checkbox"
                      checked={form.contextLength === "1000000"}
                      onChange={(e) => patch({ contextLength: e.target.checked ? "1000000" : "" })}
                    />
                    1M
                  </label>
                </div>
              </div>
              <div className="form-row">
                <span className="form-label">选项</span>
                <div className="check-row">
                  <label className="check-item">
                    <input type="checkbox" checked={form.enableThinking} onChange={(e) => patch({ enableThinking: e.target.checked })} />
                    启用思考模式
                  </label>
                  <label className="check-item" title="某些套餐模型只接受默认温度（如 Kimi 订阅），关闭则不发送 temperature 参数">
                    <input type="checkbox" checked={form.sendTemperature} onChange={(e) => patch({ sendTemperature: e.target.checked })} />
                    自定义温度
                  </label>
                  <label className="check-item">
                    <input type="checkbox" checked={form.enabled} onChange={(e) => patch({ enabled: e.target.checked })} />
                    启用此模型
                  </label>
                </div>
              </div>
            </div>

            {message && <p className={`inline-msg ${message.kind}`}>{message.text}</p>}

            <div className="form-actions">
              {selected && (
                <button className="ghost-button danger-text" onClick={() => setConfirmDelete(true)}>
                  <Trash2 size={14} /> 删除
                </button>
              )}
              <span className="flex-spacer" />
              <button className="ghost-button" disabled={testing} onClick={test}>
                <PlugZap size={14} /> {testing ? "测试中…" : "测试连接"}
              </button>
              <button className="primary-button" disabled={saving} onClick={save}>
                {saving ? "保存中…" : "保存"}
              </button>
            </div>
          </div>
        </div>
      </div>

      {confirmDelete && (
        <ConfirmDialog
          title="删除模型配置"
          message={`确定删除「${selected?.displayName}」吗？绑定此模型的 Agent 将需要重新绑定。`}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={remove}
        />
      )}
    </div>
  );
}
