import { useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { Modal, ConfirmDialog } from "./Modal";
import type { ItemGroup } from "../../../shared/types";

interface Props {
  groups: ItemGroup[];
  active: string | null; // null=全部 "default"=默认分组 其余=分组 id
  onSelect: (id: string | null) => void;
  onCreate: (name: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onDropItem: (itemId: string, groupId: string | null) => void;
}

export default function GroupBar({ groups, active, onSelect, onCreate, onRename, onDelete, onDropItem }: Props) {
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [renaming, setRenaming] = useState<ItemGroup | null>(null);
  const [deleting, setDeleting] = useState<ItemGroup | null>(null);

  const chips: { id: string | null; label: string }[] = [
    { id: null, label: "全部" },
    { id: "default", label: "默认分组" },
    ...groups.map((g) => ({ id: g.id, label: g.name }))
  ];

  const activeCustom = groups.find((g) => g.id === active) ?? null;

  function allowDrop(e: React.DragEvent) {
    e.preventDefault();
  }

  function drop(e: React.DragEvent, groupId: string | null) {
    e.preventDefault();
    const itemId = e.dataTransfer.getData("text/plain");
    if (itemId) onDropItem(itemId, groupId);
  }

  return (
    <>
      <div className="group-bar">
        {chips.map((c) => (
          <button
            key={c.id ?? "all"}
            className={`group-chip ${active === c.id ? "active" : ""}`}
            onClick={() => onSelect(c.id)}
            onDragOver={allowDrop}
            onDrop={(e) => drop(e, c.id === "default" ? null : c.id)}
          >
            {c.label}
          </button>
        ))}
        <button className="group-chip group-add" title="新建分组" onClick={() => { setName(""); setCreateOpen(true); }}>
          <Plus size={13} />
        </button>
        {activeCustom && (
          <span className="group-ops">
            <button className="icon-button tiny" title="重命名分组" onClick={() => { setName(activeCustom.name); setRenaming(activeCustom); }}>
              <Pencil size={12} />
            </button>
            <button className="icon-button tiny danger-text" title="删除分组" onClick={() => setDeleting(activeCustom)}>
              <Trash2 size={12} />
            </button>
          </span>
        )}
      </div>

      {createOpen && (
        <Modal title="新建分组" onClose={() => setCreateOpen(false)} width={380}>
          <label className="form-row">
            <span className="form-label">分组名称</span>
            <input
              className="text-input"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && name.trim()) {
                  onCreate(name.trim());
                  setCreateOpen(false);
                }
              }}
              placeholder="例如：读者团"
            />
          </label>
          <div className="modal-actions">
            <button className="ghost-button" onClick={() => setCreateOpen(false)}>取消</button>
            <button
              className="primary-button"
              disabled={!name.trim()}
              onClick={() => {
                onCreate(name.trim());
                setCreateOpen(false);
              }}
            >
              创建
            </button>
          </div>
        </Modal>
      )}

      {renaming && (
        <Modal title="重命名分组" onClose={() => setRenaming(null)} width={380}>
          <label className="form-row">
            <span className="form-label">分组名称</span>
            <input className="text-input" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <div className="modal-actions">
            <button className="ghost-button" onClick={() => setRenaming(null)}>取消</button>
            <button
              className="primary-button"
              disabled={!name.trim()}
              onClick={() => {
                onRename(renaming.id, name.trim());
                setRenaming(null);
              }}
            >
              保存
            </button>
          </div>
        </Modal>
      )}

      {deleting && (
        <ConfirmDialog
          title="删除分组"
          message={`确定删除分组「${deleting.name}」吗？组内成员会自动归入默认分组，不会被删除。`}
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            onDelete(deleting.id);
            setDeleting(null);
            onSelect(null);
          }}
        />
      )}
    </>
  );
}
