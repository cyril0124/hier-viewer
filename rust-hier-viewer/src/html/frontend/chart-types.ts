import type { HierarchyNode, ViewerState } from "./types.js";

export interface ChartEntry {
  id: number;
  node: ChartNode;
  value: number;
  fraction: number;
  style: ChartEntryStyle;
}

export interface ChartEntryStyle {
  fill: string;
  stroke: string;
  background: string;
}

export interface Chart {
  root: ChartNode;
  level: number;
  mode: ChartMode;
  analysisMode: AnalysisMode;
  total: number;
  maxValue: number;
  minValue: number;
  formatValue: (value: number) => string;
  entries: ChartEntry[];
  status: string;
}

export type ChartNode = HierarchyNode;
export type ChartMode = ViewerState["chartMode"];
export type AnalysisMode = Exclude<ViewerState["analysisMode"], "none">;
export type ChartFilterState = Pick<ViewerState, "search" | "matchIds" | "matchSubtreeIds">;

export interface ChartTraversal {
  state: ChartFilterState;
  getNode: (id: number) => Pick<HierarchyNode, "parent" | "children">;
}

export interface PieViewState {
  x: number;
  y: number;
  w: number;
  h: number;
  baseW: number;
  baseH: number;
  dragging: boolean;
  dragMoved: boolean;
  lastClientX: number;
  lastClientY: number;
  suppressClick: boolean;
}

export interface ThreeViewState {
  yaw: number;
  pitch: number;
  distance: number;
  targetX: number;
  targetY: number;
  targetZ: number;
  minDistance: number;
  maxDistance: number;
  fitDistance: number;
}

export interface ThreeContext {
  zoomByFactor: (factor: number) => void;
  fitView: () => void;
  zoomLabel: () => string;
  hintText: () => string;
  dispose: () => void;
}

export interface PieHoverBinding {
  id: number;
  slice: SVGPathElement;
  legend: HTMLElement | null;
  transform: (active: boolean) => string;
}

export interface ViewStatus {
  zoomLabel: string;
  hintText: string;
}

export interface ChartApi {
  state: ChartState;
  getNode: (id: number) => ChartNode;
  visibleParent: (id: number) => number | null;
  currentMaxDepth: () => number;
  setRootAndReset: (nodeId: number) => void;
  focusNodeInMainView: (nodeId: number) => void;
  analysisActive: () => boolean;
  buildSignalAnalysis: () => void;
  syncAnalysisControls: () => void;
  currentThemeVisuals: () => ThemeVisuals;
  mixHexColors: (base: string, accent: string, mix: number) => string;
  hexToRgba: (hex: string, alpha: number) => string;
  themeNodeAccent: (index: number) => string;
  subtreeWeightedBits: (node: ChartNode) => number;
  formatMetricValue: (value: number) => string;
  savePersistedState: () => void;
  requestDraw: () => void;
}

export type ChartState = Pick<ViewerState,
  "currentRoot" | "chartLevel" | "chartMode" | "chartRenderMode" |
  "chartPanelOpen" | "chartPanelDirty" | "mainViewMode" | "search" |
  "filterScope" | "filterMode" | "analysisMode" | "analysisPatternMode" |
  "analysisPattern" | "analysisError" | "analysisSubtreeCounts" |
  "analysisSubtreeRatios" | "analysisSubtreeLocs" | "matchIds" |
  "matchSubtreeIds" | "theme" | "weightedVariableWeight" | "weightedNetWeight"
>;

export interface ThemeVisuals {
  dark: boolean;
  canvasBase: string;
  panel: string;
  text: string;
  textSoft: string;
  match: string;
  analysisRamp?: string[];
}

export interface ChartController {
  invalidate: () => void;
  zoomByFactor: (factor: number) => boolean;
  fitView: () => boolean;
  viewStatus: () => ViewStatus | null;
  render: () => void;
}
