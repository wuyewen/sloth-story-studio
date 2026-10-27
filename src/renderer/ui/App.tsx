import { useEffect, useState } from "react";
import { BookOpen, Home, Sparkles, Workflow, Search, ChevronRight, SlidersHorizontal, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { sloth } from "../api";
import { useStudio } from "../state/store";
import { BridgeMissing } from "./components/Modal";
import EditorPage from "./pages/EditorPage";
import AgentsPage from "./pages/AgentsPage";
import WorkflowsPage from "./pages/WorkflowsPage";
import WorkbenchPage from "./pages/WorkbenchPage";
import ProjectSettingsPage from "./pages/ProjectSettingsPage";
import ProjectWorkflowsPage from "./pages/ProjectWorkflowsPage";
import HomePage from "./pages/HomePage";
import type { ItemGroup } from "../../shared/types";

type Page = "home" | "workbench" | "editor" | "agents" | "workflows" | "project-settings" | "project-workflows";

const pageTitle: Record<Page, string> = {
  home: "首页",
  workbench: "创作工作台",
  editor: "章节编辑器",
  agents: "智能体",
  workflows: "工作流",
  "project-settings": "项目设置",
  "project-workflows": "工作流管理"
};

function Brand() {
  return (
    <div className="brand">
      <img src="assets/branding/app-icon-512.png" alt="Sloth Story Studio" />
      <span>Sloth Story Studio</span>
    </div>
  );
}

function ToolGroup({
  icon,
  label,
  pageId,
  page,
  setPage,
  groups,
  activeGroup,
  setActiveGroup,
  onDropItem
}: {
  icon: React.ReactNode;
  label: string;
  pageId: Page;
  page: Page;
  setPage: (p: Page) => void;
  groups: ItemGroup[];
  activeGroup: string | null;
  setActiveGroup: (id: string | null) => void;
  onDropItem: (itemId: string, groupId: string | null) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const items: { id: string | null; label: string }[] = [
    { id: null, label: "全部" },
    { id: "default", label: "默认分组" },
    ...groups.map((g) => ({ id: g.id, label: g.name }))
  ];
  return (
    <div className="nav-group">
      <button
        className={`nav-item nav-l2 ${expanded ? "expanded" : ""} ${page === pageId ? "active" : ""}`}
        onClick={() => {
          setExpanded(!expanded);
          setPage(pageId);
          setActiveGroup(null);
        }}
      >
        {icon}
        <span>{label}</span>
        <ChevronRight size={13} className={`nav-chevron ${expanded ? "down" : ""}`} />
      </button>
      {expanded && (
        <div className="nav-sub">
          {items.map((it) => (
            <button
              key={it.id ?? "all"}
              className={`nav-item nav-l3 ${page === pageId && activeGroup === it.id ? "active" : ""}`}
              onClick={() => {
                setPage(pageId);
                setActiveGroup(it.id);
              }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const itemId = e.dataTransfer.getData("text/plain");
                if (itemId) onDropItem(itemId, it.id === "default" ? null : it.id);
              }}
            >
              <span>{it.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [page, setPage] = useState<Page>("home");
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState(false);
  const ready = useStudio((s) => s.ready);
  const settings = useStudio((s) => s.settings);
  const init = useStudio((s) => s.init);
  const projects = useStudio((s) => s.projects);
  const currentProjectId = useStudio((s) => s.currentProjectId);
  const setCurrentProject = useStudio((s) => s.setCurrentProject);
  const setWorkbenchMemoryOpen = useStudio((s) => s.setWorkbenchMemoryOpen);
  const agentGroups = useStudio((s) => s.agentGroups);
  const workflowGroups = useStudio((s) => s.workflowGroups);
  const activeAgentGroup = useStudio((s) => s.activeAgentGroup);
  const activeWorkflowGroup = useStudio((s) => s.activeWorkflowGroup);
  const setActiveAgentGroup = useStudio((s) => s.setActiveAgentGroup);
  const setActiveWorkflowGroup = useStudio((s) => s.setActiveWorkflowGroup);
  const refreshAgents = useStudio((s) => s.refreshAgents);
  const refreshWorkflows = useStudio((s) => s.refreshWorkflows);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [activeSubLabel, setActiveSubLabel] = useState<string>("创作工作台");

  useEffect(() => {
    void init();
  }, [init]);

  // 没有项目时默认落在首页（项目在那里新建）
  useEffect(() => {
    if (ready && projects.length === 0 && page === "workbench") setPage("home");
  }, [ready, projects.length]);

  if (!sloth) return <BridgeMissing />;
  if (!ready) return <div className="app-loading">正在打开工作室…</div>;

  const bg = settings?.backgroundImage ?? null;
  const activeProjectId = currentProjectId ?? projects[0]?.id ?? null;

  function gotoProject(pid: string, target: Page, subLabel?: string) {
    setCurrentProject(pid);
    setExpandedId(pid);
    if (subLabel) setActiveSubLabel(subLabel);
    setPage(target);
  }

  const subItems: { target: Page; label: string }[] = [
    { target: "workbench", label: "创作工作台" },
    { target: "editor", label: "章节编辑器" },
    { target: "project-workflows", label: "工作流管理" },
    { target: "workbench", label: "记忆管理" },
    { target: "project-settings", label: "项目设置" }
  ];

  return (
    <div className="app-shell">
      {bg && (
        <div className="app-bg" style={{ backgroundImage: `url(${bg})` }}>
          <div className="app-bg-mask" />
        </div>
      )}

      <aside className={`sidebar ${collapsed ? "collapsed" : ""}`}>
        <div className="sidebar-top">
          <Brand />
          <button
            className="icon-button collapse-button"
            aria-label={collapsed ? "展开侧边栏" : "收起侧边栏"}
            title={collapsed ? "展开侧边栏" : "收起侧边栏"}
            onClick={() => setCollapsed(!collapsed)}
          >
            {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          </button>
        </div>
        <div className="sidebar-scroll">
        <nav className="nav-list">
          <button
            className={`nav-item nav-l1 ${page === "home" ? "active" : ""}`}
            onClick={() => setPage("home")}
          >
            <Home size={18} strokeWidth={1.8} />
            <span>首页</span>
          </button>
        </nav>
        <div className="nav-label">小说</div>
        <nav className="nav-list">
          {projects.length === 0 && (
            <button className="nav-item nav-l3 nav-hint" onClick={() => setPage("home")}>
              <span>＋ 还没有项目，点击去新建</span>
            </button>
          )}
          {projects.map((p) => {
            const expanded = expandedId === p.id;
            const isActiveProject =
              activeProjectId === p.id &&
              (page === "workbench" || page === "editor" || page === "project-settings" || page === "project-workflows");
            return (
              <div key={p.id} className="nav-group">
                <button
                  className={`nav-item nav-l2 ${expanded ? "expanded" : ""} ${isActiveProject ? "active" : ""}`}
                  onClick={() => {
                    setExpandedId(expanded ? null : p.id);
                    setCurrentProject(p.id);
                    if (!expanded) {
                      setActiveSubLabel("创作工作台");
                      setPage("workbench");
                    }
                  }}
                >
                  <BookOpen size={18} strokeWidth={1.8} />
                  <span>{p.title}</span>
                  <ChevronRight size={13} className={`nav-chevron ${expanded ? "down" : ""}`} />
                </button>
                {expanded && (
                  <div className="nav-sub">
                    {subItems.map((s) => {
                      const active = isActiveProject && activeSubLabel === s.label && page === s.target;
                      return (
                        <button
                          key={s.label}
                          className={`nav-item nav-l3 ${active ? "active" : ""}`}
                          onClick={() => {
                            setActiveSubLabel(s.label);
                            if (s.label === "记忆管理") {
                              setCurrentProject(p.id);
                              setWorkbenchMemoryOpen(true);
                              setPage("workbench");
                            } else {
                              gotoProject(p.id, s.target, s.label);
                            }
                          }}
                        >
                          <span>{s.label}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </nav>
        <div className="nav-label">工具</div>
        <nav className="nav-list">
          <ToolGroup
            icon={<Sparkles size={18} strokeWidth={1.8} />}
            label="智能体 (Agents)"
            pageId="agents"
            page={page}
            setPage={setPage}
            groups={agentGroups}
            activeGroup={activeAgentGroup}
            setActiveGroup={setActiveAgentGroup}
            onDropItem={(itemId, gid) => void sloth?.agents.setGroup(itemId, gid).then(() => refreshAgents())}
          />
          <ToolGroup
            icon={<Workflow size={18} strokeWidth={1.8} />}
            label="工作流 (Workflows)"
            pageId="workflows"
            page={page}
            setPage={setPage}
            groups={workflowGroups}
            activeGroup={activeWorkflowGroup}
            setActiveGroup={setActiveWorkflowGroup}
            onDropItem={(itemId, gid) => void sloth?.workflows.setGroup(itemId, gid).then(() => refreshWorkflows())}
          />
        </nav>
        </div>
        <div className="sidebar-bottom">
          <button className="nav-item" onClick={() => void sloth?.app.openConfig("settings")}>
            <SlidersHorizontal size={18} strokeWidth={1.8} />
            <span>设置</span>
          </button>
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

        <div className={`page-content ${page === "home" ? "" : "page-hidden"}`}>
          <HomePage onOpenProject={() => setPage("workbench")} />
        </div>
        <div className={`page-content ${page === "workbench" ? "" : "page-hidden"}`}>
          <WorkbenchPage />
        </div>
        <div className={`page-content page-fill ${page === "editor" ? "" : "page-hidden"}`}>
          <EditorPage query={query} />
        </div>
        <div className={`page-content page-fill ${page === "agents" ? "" : "page-hidden"}`}>
          <AgentsPage />
        </div>
        <div className={`page-content page-fill ${page === "workflows" ? "" : "page-hidden"}`}>
          <WorkflowsPage />
        </div>
        <div className={`page-content ${page === "project-settings" ? "" : "page-hidden"}`}>
          <ProjectSettingsPage />
        </div>
        <div className={`page-content ${page === "project-workflows" ? "" : "page-hidden"}`}>
          <ProjectWorkflowsPage />
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
