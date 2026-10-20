import type { SlothApi } from "../shared/types";

export const sloth: SlothApi | null =
  typeof window !== "undefined" && window.sloth ? window.sloth : null;

export type * from "../shared/types";
