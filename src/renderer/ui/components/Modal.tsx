import type { ReactNode } from "react";
import { X } from "lucide-react";

export function Modal({
  title,
  children,
  onClose,
  width
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  width?: number;
}) {
  return (
    <div
      className="modal-mask"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal" style={width ? { width } : undefined}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="icon-button" aria-label="关闭" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  title,
  message,
  confirmText = "删除",
  blockConfirm = false,
  altText,
  onAlt,
  onCancel,
  onConfirm
}: {
  title: string;
  message: string;
  confirmText?: string;
  blockConfirm?: boolean;
  altText?: string; // 第三个按钮（引导动作），如「去提取」
  onAlt?: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal title={title} onClose={onCancel} width={380}>
      <p className="confirm-message">{message}</p>
      <div className="modal-actions">
        <button className="ghost-button" onClick={onCancel}>
          {blockConfirm ? "知道了" : "取消"}
        </button>
        {altText && onAlt && (
          <button className="ghost-button" onClick={onAlt}>
            {altText}
          </button>
        )}
        {!blockConfirm && (
          <button className="danger-button" onClick={onConfirm}>
            {confirmText}
          </button>
        )}
      </div>
    </Modal>
  );
}

export function BridgeMissing() {
  return (
    <div className="bridge-missing">
      <img src="assets/branding/app-icon-512.png" alt="Sloth Story Studio" />
      <h1>请在 Sloth Story Studio 桌面应用中打开</h1>
      <p>当前页面未检测到桌面端桥接（window.sloth），应用需要在 Electron 环境中运行。</p>
    </div>
  );
}
