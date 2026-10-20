import { useEffect, useState } from "react";
import { BookOpen, Sparkles, Workflow, Search, ChevronRight } from "lucide-react";
import { sloth } from "../api";
import { useStudio } from "../state/store";
import { BridgeMissing } from "./components/Modal";
import EditorPage from "./pages/EditorPage";
import AgentsPage from "./pages/AgentsPage";
import WorkflowsPage from "./pages/WorkflowsPage";

type Page = "editor" | "agents" | "workflows";

const nav: { id: Page; label: string; icon: typeof BookOpen }[] = [
  { id: "editor", label: "小说编辑器", icon: BookOpen },
  { id: "agents", label: "Agents", icon: Sparkles },
  { id: "workflows", label: "Workflows", icon: Workflow }
];

const pageTitle: Record<Page, string> = {
  editor: "小说编辑器",
  agents: "Agents",
  workflows: "Workflows"
};

function Brand() {
  return (
    <div className="brand">
      <img src="assets/branding/app-icon-512.png" alt="Sloth Story Studio" />
      <span>Sloth Story Studio</span>
    </div>
  );
}

export default function App() {
  const [page, setPage] = useState<Page>("editor");
  const [query, setQuery] = useState("");
  const ready = useStudio((s) => s.ready);
  const settings = useStudio((s) => s.settings);
  const init = useStudio((s) => s.init);

  useEffect(() => {
    void init();
  }, [init]);

  if (!sloth) return <BridgeMissing />;
  if (!ready) return <div className="app-loading">正在打开工作室…</div>;

  const bg = settings?.backgroundImage ?? null;

  return (
    <div className="app-shell">
      {bg && (
        <div className="app-bg" style={{ backgroundImage: `url(${bg})` }}>
          <div className="app-bg-mask" />
        </div>
      )}

      <aside className="sidebar">
        <div className="sidebar-top">
          <Brand />
        </div>
        <div className="nav-label">创作空间</div>
        <nav className="nav-list">
          {nav.map(({ id, label, icon: Icon }) => (
            <button key={id} className={`nav-item ${page === id ? "active" : ""}`} onClick={() => setPage(id)}>
              <Icon size={18} strokeWidth={1.8} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="local-status">
            <span className="status-dot" />
            <div>
              <strong>本地工作区</strong>
              <small>数据保存在此设备</small>
            </div>
          </div>
          <div className="sidebar-foot">
            <span>Sloth Story Studio</span>
            <span>v0.1.0</span>
          </div>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumbs">
            <span>工作空间</span>
            <ChevronRight size={14} />
            <strong>{pageTitle[page]}</strong>
          </div>
          <div className="topbar-actions">
            <label className="search-box">
              <Search size={16} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索项目、章节..."
              />
              <kbd>⌘ K</kbd>
            </label>
          </div>
        </header>

        <div className={`page-content page-fill ${page === "editor" ? "" : "page-hidden"}`}>
          <EditorPage query={query} />
        </div>
        <div className={`page-content page-fill ${page === "agents" ? "" : "page-hidden"}`}>
          <AgentsPage />
        </div>
        <div className={`page-content page-fill ${page === "workflows" ? "" : "page-hidden"}`}>
          <WorkflowsPage />
        </div>

        <footer className="app-footer">
          <span>用自己的节奏，写自己的故事。</span>
          <span>
            <span className="status-dot" /> 本地模式
          </span>
        </footer>
      </main>
    </div>
  );
}
