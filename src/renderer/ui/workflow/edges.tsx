import { BaseEdge, EdgeLabelRenderer, type EdgeProps } from "@xyflow/react";
import type { WorkflowEdgeLine } from "../../../shared/types";

export type LoopBackData = {
  line?: WorkflowEdgeLine;
  color?: string;
  conditionExpr?: string;
  loopY?: number; // 回退线顶部通道的 y 坐标（由自动整理计算）
};

// 回退线：从源节点右侧绕到所有节点上方的通道，再从目标节点左侧进入，避免横穿节点
export function LoopBackEdge({ id, sourceX, sourceY, targetX, targetY, style, markerEnd, label, data }: EdgeProps) {
  const topY = (data as LoopBackData | undefined)?.loopY ?? Math.min(sourceY, targetY) - 70;
  const path = [
    `M ${sourceX},${sourceY}`,
    `L ${sourceX + 26},${sourceY}`,
    `L ${sourceX + 26},${topY}`,
    `L ${targetX - 26},${topY}`,
    `L ${targetX - 26},${targetY}`,
    `L ${targetX},${targetY}`
  ].join(" ");
  const labelX = (sourceX + targetX) / 2;

  return (
    <>
      <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} interactionWidth={24} />
      {label && (
        <EdgeLabelRenderer>
          <div
            className="wf-edge-label"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${topY}px)` }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const edgeTypes = {
  loopback: LoopBackEdge
};
