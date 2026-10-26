import { create } from "zustand";
import { sloth } from "../api";
import type {
  AgentProfile,
  AppSettings,
  ModelProviderInfo,
  NovelProject,
  WorkflowDef
} from "../../shared/types";

interface StudioState {
  ready: boolean;
  providers: ModelProviderInfo[];
  agents: AgentProfile[];
  projects: NovelProject[];
  workflows: WorkflowDef[];
  settings: AppSettings | null;
  currentProjectId: string | null; // 侧边栏选中的小说项目（树形导航）
  workbenchMemoryOpen: boolean; // 「记忆管理」导航时自动打开记忆弹窗
  setCurrentProject: (id: string | null) => void;
  setWorkbenchMemoryOpen: (v: boolean) => void;
  init: () => Promise<void>;
  refreshProviders: () => Promise<void>;
  refreshAgents: () => Promise<void>;
  refreshProjects: () => Promise<void>;
  refreshWorkflows: () => Promise<void>;
  patchSettings: (patch: Partial<AppSettings>) => Promise<void>;
}

export const useStudio = create<StudioState>((set, get) => ({
  ready: false,
  providers: [],
  agents: [],
  projects: [],
  workflows: [],
  settings: null,
  currentProjectId: null,
  workbenchMemoryOpen: false,
  setCurrentProject: (id) => set({ currentProjectId: id }),
  setWorkbenchMemoryOpen: (v) => set({ workbenchMemoryOpen: v }),

  async init() {
    if (!sloth) {
      set({ ready: true });
      return;
    }
    const [providers, agents, projects, workflows, settings] = await Promise.all([
      sloth.models.list(),
      sloth.agents.list(),
      sloth.novels.list(),
      sloth.workflows.list(),
      sloth.settings.get()
    ]);
    set({ providers, agents, projects, workflows, settings, ready: true });
    sloth.settings.onChanged((next) => {
      set({ settings: next });
      // 目录类设置变化后，相关数据可能来自新位置，全部刷新
      void get().refreshAgents();
      void get().refreshWorkflows();
      void get().refreshProjects();
    });
    sloth.models.onChanged((next) => set({ providers: next }));
    sloth.app.onFocus(() => {
      // 窗口重新聚焦：外部可能改过 workflows/agents/项目文件，全部刷新
      void get().refreshWorkflows();
      void get().refreshAgents();
      void get().refreshProjects();
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

  async patchSettings(patch) {
    if (!sloth) return;
    set({ settings: await sloth.settings.set(patch) });
  }
}));

export const enabledProviders = (s: StudioState) => s.providers.filter((p) => p.enabled);

export const providerName = (providers: ModelProviderInfo[], id: string | null) =>
  providers.find((p) => p.id === id)?.displayName ?? "未绑定模型";
