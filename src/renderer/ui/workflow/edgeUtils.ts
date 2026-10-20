import type { WorkflowEdgeLine } from "../../../shared/types";

export const EDGE_COLORS = ["#C85B4E", "#7D8796", "#E0A458", "#80A78A", "#5B7EC8", "#252b33"];

export const LINE_OPTIONS: { value: WorkflowEdgeLine; label: string }[] = [
  { value: "bezier", label: "曲线" },
  { value: "step", label: "折线" },
  { value: "straight", label: "直线" }
];

export function lineToRfType(line: WorkflowEdgeLine | undefined): string {
  if (line === "step") return "step";
  if (line === "straight") return "straight";
  return "default";
}
