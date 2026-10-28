import { create } from "zustand";
import { sloth } from "../api";
import type {
  AgentProfile,
  AppSettings,
  ItemGroup,
  ModelProviderInfo,
  NovelProject,
  StyleProfile,
  WorkflowDef
} from "../../shared/types";

interface StudioState {
  ready: boolean;
  providers: ModelProviderInfo[];
  agents: AgentProfile[];
  projects: NovelProject[];
  workflows: WorkflowDef[];
  styles: StyleProfile[];
  settings: AppSettings | null;
  currentProjectId: string | null; // 侧边栏选中的小说项目（树形导航）
  workbenchMemoryOpen: boolean; // 「记忆管理」导航时自动打开记忆弹窗
  agentGroups: ItemGroup[];
  workflowGroups: ItemGroup[];
  activeAgentGroup: string | null; // null=全部 "default"=默认分组 其余=分组 id
  activeWorkflowGroup: string | null;
  canvasAgentGroup: string | null; // 画布工具条选的 Agent 分组（节点下拉只显示该组）
  setCurrentProject: (id: string | null) => void;
  setWorkbenchMemoryOpen: (v: boolean) => void;
  setActiveAgentGroup: (id: string | null) => void;
  setActiveWorkflowGroup: (id: string | null) => void;
  setCanvasAgentGroup: (id: string | null) => void;
  refreshGroups: () => Promise<void>;
  init: () => Promise<void>;
  refreshProviders: () => Promise<void>;
  refreshAgents: () => Promise<void>;
  refreshProjects: () => Promise<void>;
  refreshWorkflows: () => Promise<void>;
  refreshStyles: () => Promise<void>;
  patchSettings: (patch: Partial<AppSettings>) => Promise<void>;
}

export const useStudio = create<StudioState>((set, get) => ({
  ready: false,
  providers: [],
  agents: [],
  projects: [],
  workflows: [],
  styles: [],
  settings: null,
  currentProjectId: null,
  workbenchMemoryOpen: false,
  agentGroups: [],
  workflowGroups: [],
  activeAgentGroup: null,
  activeWorkflowGroup: null,
  canvasAgentGroup: null,
  setCurrentProject: (id) => set({ currentProjectId: id }),
  setWorkbenchMemoryOpen: (v) => set({ workbenchMemoryOpen: v }),
  setActiveAgentGroup: (id) => set({ activeAgentGroup: id }),
  setActiveWorkflowGroup: (id) => set({ activeWorkflowGroup: id }),
  setCanvasAgentGroup: (id) => set({ canvasAgentGroup: id }),

  async refreshGroups() {
    if (!sloth) return;
    const [agentGroups, workflowGroups] = await Promise.all([
      sloth.agents.listGroups(),
      sloth.workflows.listGroups()
    ]);
    set({ agentGroups, workflowGroups });
  },

  async init() {
    if (!sloth) {
      set({ ready: true });
      return;
    }
    const [providers, agents, projects, workflows, settings, agentGroups, workflowGroups, styles] = await Promise.all([
      sloth.models.list(),
      sloth.agents.list(),
      sloth.novels.list(),
      sloth.workflows.list(),
      sloth.settings.get(),
      sloth.agents.listGroups(),
      sloth.workflows.listGroups(),
      sloth.styles.list()
    ]);
    set({ providers, agents, projects, workflows, settings, agentGroups, workflowGroups, styles, ready: true });
    sloth.settings.onChanged((next) => {
      set({ settings: next });
      // 目录类设置变化后，相关数据可能来自新位置，全部刷新
      void get().refreshAgents();
      void get().refreshWorkflows();
      void get().refreshProjects();
      void get().refreshGroups();
      void get().refreshStyles();
    });
    sloth.models.onChanged((next) => set({ providers: next }));
    sloth.app.onFocus(() => {
      // 窗口重新聚焦：外部可能改过 workflows/agents/项目文件，全部刷新
      void get().refreshWorkflows();
      void get().refreshAgents();
      void get().refreshProjects();
      void get().refreshGroups();
      void get().refreshStyles();
    });
  },

  async refreshProviders() {
    if (!sloth) return;
    set({ providers: await sloth.models.list() });
  },

  async refreshAgents() {
    if (!sloth) return;
    set({ agents: await sloth.agents.list() });
  },

  async refreshProjects() {
    if (!sloth) return;
    set({ projects: await sloth.novels.list() });
  },

  async refreshWorkflows() {
    if (!sloth) return;
    set({ workflows: await sloth.workflows.list() });
  },

  async refreshStyles() {
    if (!sloth) return;
    set({ styles: await sloth.styles.list() });
  },

  async patchSettings(patch) {
    if (!sloth) return;
    set({ settings: await sloth.settings.set(patch) });
  }
}));

export const enabledProviders = (s: StudioState) => s.providers.filter((p) => p.enabled);

export const providerName = (providers: ModelProviderInfo[], id: string | null) =>
  providers.find((p) => p.id === id)?.displayName ?? "未绑定模型";
