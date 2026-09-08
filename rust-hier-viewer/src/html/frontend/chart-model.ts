import { coverageFilterActive } from "./coverage-display.js";
import type { ChartFilterState, ChartTraversal } from "./chart-types.js";

export function filterActive(state: ChartFilterState): boolean {
  return (state.search || "").trim().length > 0 || coverageFilterActive(state.coverage);
}

export function isBranchIncluded(
  nodeId: number,
  matchedAncestor: boolean,
  state: ChartFilterState
): boolean {
  if (!filterActive(state)) {
    return true;
  }
  // Coverage belongs to each individual instance. A matching parent's score
  // must not qualify its children, whose scores may fall in different buckets.
  if (coverageFilterActive(state.coverage)) {
    return state.matchIds.has(nodeId) || state.matchSubtreeIds.has(nodeId);
  }
  return matchedAncestor || state.matchIds.has(nodeId) || state.matchSubtreeIds.has(nodeId);
}

export function collectLevelNodes(
  rootId: number,
  relativeLevel: number,
  api: ChartTraversal
): number[] {
  const result: number[] = [];
  const state = api.state;

  let matchedAncestor = false;
  let parentId = api.getNode(rootId).parent;
  while (parentId !== null && parentId !== undefined) {
    if (state.matchIds.has(parentId)) {
      matchedAncestor = true;
      break;
    }
    parentId = api.getNode(parentId).parent;
  }

  const stack: Array<number | boolean> = [rootId, 0, matchedAncestor];
  while (stack.length) {
    const matchedAncestor = stack.pop() as boolean;
    const depth = stack.pop() as number;
    const nodeId = stack.pop() as number;
    const node = api.getNode(nodeId);
    const nextMatchedAncestor = matchedAncestor || state.matchIds.has(nodeId);
    if (!isBranchIncluded(nodeId, nextMatchedAncestor, state)) {
      continue;
    }
    // Mirror treemap level semantics instead of exact-depth slicing.
    // Once a branch reaches the requested depth, or it terminates early,
    // that node becomes the frontier entry shown by chart views.
    if (depth >= relativeLevel || !node.children.length) {
      if (!coverageFilterActive(state.coverage) || state.matchIds.has(nodeId)) {
        result.push(nodeId);
      }
      continue;
    }
    // Push in reverse so the frontier retains left-to-right DFS order.
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      stack.push(node.children[index], depth + 1, nextMatchedAncestor);
    }
  }
  return result;
}

export function threeFitDistance(
  extent: number,
  maxHeight: number,
  clientWidth: number,
  clientHeight: number
): number {
  const aspect = Math.max(1, clientWidth) / Math.max(1, clientHeight);
  const verticalHalfFov = (19 * Math.PI) / 180;
  const halfFov = Math.min(verticalHalfFov, Math.atan(Math.tan(verticalHalfFov) * aspect));
  const radius = Math.hypot(extent, extent, maxHeight) / 2;
  return (radius * 1.1) / Math.sin(halfFov);
}

export function createThreeViewState(
  extent: number,
  maxHeight: number,
  clientWidth: number,
  clientHeight: number
) {
  const fitDistance = threeFitDistance(extent, maxHeight, clientWidth, clientHeight);
  return {
    yaw: 0.72,
    pitch: 1.06,
    distance: fitDistance,
    targetX: 0,
    targetY: maxHeight / 2,
    targetZ: 0,
    minDistance: Math.max(2.8, extent * 0.18),
    maxDistance: Math.max(22, extent * 7.2, fitDistance * 2),
    fitDistance,
  };
}

export function coverageBarHeight(percentage: number, maximumHeight: number): number {
  return Math.max(0, Math.min(100, percentage)) / 100 * maximumHeight;
}

export function threeBarVisualRatio(value: number, maxValue: number, minValue: number): number {
  if (!(maxValue > 0) || !(value > 0)) {
    return 0;
  }

  const minVal = Math.max(minValue || 0, Number.MIN_VALUE);
  const rawRatio = Math.max(0, Math.min(1, value / maxValue));
  const dynamicRange = maxValue / minVal;
  let exponent = 1;
  if (dynamicRange > 4096) {
    exponent = 0.36;
  } else if (dynamicRange > 512) {
    exponent = 0.44;
  } else if (dynamicRange > 96) {
    exponent = 0.54;
  } else if (dynamicRange > 24) {
    exponent = 0.66;
  } else if (dynamicRange > 6) {
    exponent = 0.82;
  }
  return Math.pow(rawRatio, exponent);
}
