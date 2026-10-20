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
  init: () => Promise<void>;
  refreshProviders: () => Promise<void>;
  refreshAgents: () => Promise<void>;
  refreshProjects: () => Promise<void>;
  refreshWorkflows: () => Promise<void>;
  patchSettings: (patch: Partial<AppSettings>) => Promise<void>;
}

export const useStudio = create<StudioState>((set) => ({
  ready: false,
  providers: [],
  agents: [],
  projects: [],
  workflows: [],
  settings: null,

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
    sloth.settings.onChanged((next) => set({ settings: next }));
    sloth.models.onChanged((next) => set({ providers: next }));
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
