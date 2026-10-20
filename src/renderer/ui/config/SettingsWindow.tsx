import { useEffect } from "react";
import { FolderOpen, ImageIcon, Trash2 } from "lucide-react";
import { sloth } from "../../api";
import { useStudio } from "../../state/store";
import { BridgeMissing } from "../components/Modal";

export default function SettingsWindow() {
  const ready = useStudio((s) => s.ready);
  const settings = useStudio((s) => s.settings);
  const init = useStudio((s) => s.init);
  const patchSettings = useStudio((s) => s.patchSettings);

  useEffect(() => {
    void init();
  }, [init]);

  if (!sloth) return <BridgeMissing />;
  if (!ready || !settings) return <div className="app-loading">加载中…</div>;

  async function pickDir() {
    const dir = await sloth!.settings.pickDirectory();
    if (dir) await patchSettings({ novelDir: dir });
  }

  async function pickBg() {
    const img = await sloth!.settings.pickBackgroundImage();
    if (img) await patchSettings({ backgroundImage: img });
  }

  return (
    <div className="config-shell">
      <div className="config-panel">
        <div className="config-head">
          <img src="assets/branding/app-icon-512.png" alt="" />
          <div>
            <h1>系统设置</h1>
            <p>保存即生效，无需重启。</p>
          </div>
        </div>

        <div className="settings-list">
          <div className="setting-block">
            <div className="setting-copy">
              <strong>小说文本目录</strong>
              <small>所有项目与章节都以纯文本保存在此目录下。</small>
            </div>
            <div className="setting-ctl">
              <input className="text-input" readOnly value={settings.novelDir} title={settings.novelDir} />
              <button className="ghost-button" onClick={pickDir}>
                <FolderOpen size={14} /> 选择目录
              </button>
            </div>
          </div>

          <div className="setting-block">
            <div className="setting-copy">
              <strong>自定义背景图</strong>
              <small>作为工作室主窗口的浅色背景。</small>
            </div>
            <div className="setting-ctl">
              {settings.backgroundImage ? (
                <img className="bg-preview" src={settings.backgroundImage} alt="背景预览" />
              ) : (
                <span className="bg-preview empty">
                  <ImageIcon size={18} />
                </span>
              )}
              <button className="ghost-button" onClick={pickBg}>
                选择图片
              </button>
              {settings.backgroundImage && (
                <button className="ghost-button danger-text" onClick={() => patchSettings({ backgroundImage: null })}>
                  <Trash2 size={14} /> 清除
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
