import type { CoverageDisplay } from "./coverage-types.js";

export type Nullable<T> = T | null;

export interface DefinitionSignalStat {
  signalName: string;
  signalKind: string;
  signalCount: number;
  totalBits: number;
}

export interface AnalysisDefinition {
  definitionKey: string;
  signalStats: DefinitionSignalStat[];
}

export interface HierarchyNode {
  id: number;
  name: string;
  module: string;
  definitionKey: Nullable<string>;
  parent: Nullable<number>;
  depth: number;
  children: number[];
  path: string;
  subtreeInstances: number;
  subtreeLeaves: number;
  subtreeSignalCount: number;
  subtreeInternalSignalCount: number;
  subtreeSignalBits: number;
  subtreeVariableBits: number;
  subtreeNetBits: number;
  moduleVariableCount: number;
  moduleNetCount: number;
  moduleSignalCount: number;
  moduleVariableBits: number;
  moduleNetBits: number;
  moduleSignalBits: number;
  moduleInternalSignalCount: number;
  filePath: Nullable<string>;
  sourceHref: Nullable<string>;
  definitionFilePath: Nullable<string>;
  definitionSourceHref: Nullable<string>;
  line: Nullable<number>;
  column: Nullable<number>;
  endLine: Nullable<number>;
  endColumn: Nullable<number>;
  definitionLine: Nullable<number>;
  definitionColumn: Nullable<number>;
  definitionEndLine: Nullable<number>;
  definitionEndColumn: Nullable<number>;
  snippetText?: string;
  snippetStartLine?: number;
  snippetEndLine?: number;
  definitionSnippetText?: string;
  definitionSnippetStartLine?: number;
  definitionSnippetEndLine?: number;
}

export interface ViewerData {
  title: string;
  builtAtUnixMs: number;
  debugUiLabels: boolean;
  rootId: number;
  defaultMetric: string;
  analysisDefinitions: Nullable<AnalysisDefinition[]>;
  analysisFile: Nullable<string>;
  schematic?: { version: number; directory: string } | null;
  nodes: HierarchyNode[];
}

export type Metric = "instances" | "leaves" | "signals" | "weighted_signals";
export type LayoutMode = "classic" | "accurate";
export type Decomposition = "subtree" | "self";
export type AnalysisMode = "none" | "count" | "ratio" | "loc";
export type PatternMode = "text" | "wildcard" | "regex";
export type FilterScope = "path" | "instance" | "module" | "both";
export type FilterMode = "text" | "wildcard" | "regex";
export type MainViewMode = "treemap" | "pie2d" | "three3d" | "coverage" | "schematic";
export type ChartRenderMode = "pie2d" | "three3d";
export type SourceTargetKind = "instance" | "definition";
export type SourceRenderMode = "full" | "compact" | "plain";

export interface TreemapArea {
  nodeId: number;
  rect: { x: number; y: number; w: number; h: number };
  level: number;
  kind: "node" | "self";
}

export interface SourceTarget {
  kind: SourceTargetKind;
  filePath: Nullable<string>;
  sourceHref: Nullable<string>;
  line: number;
  endLine: number;
  column: number;
  endColumn: number;
  snippetText?: string;
  snippetStartLine?: number;
  snippetEndLine?: number;
  titleSuffix: string;
  locationLabel: string;
  url?: string;
}

export interface SourceBookmark {
  line: number;
  label: string;
  preview: string;
}

export interface ViewerState {
  coverage?: CoverageDisplay;
  homeRoot: number;
  currentRoot: number;
  theme: string;
  metric: Metric | string;
  weightedVariableWeight: number;
  weightedNetWeight: number;
  layoutMode: LayoutMode;
  decomposition: Decomposition;
  analysisMode: AnalysisMode;
  analysisPatternMode: PatternMode;
  analysisPattern: string;
  analysisError: string;
  analysisLocalCounts: number[];
  analysisSubtreeCounts: number[];
  analysisLocalLocs: number[];
  analysisSubtreeLocs: number[];
  analysisLocalRatios: number[];
  analysisSubtreeRatios: number[];
  analysisMaxSubtreeCount: number;
  analysisVisibleMaxCount: number;
  analysisVisibleMaxLoc: number;
  analysisVisibleMaxRatio: number;
  analysisVisibleSubtreeQualified: boolean[];
  analysisLegendFilter: string[];
  analysisLegendVisibleSubtree: boolean[];
  analysisHatchDisabledUntil: number;
  advancedPopoverOpen: boolean;
  advancedPopoverLeft: Nullable<number>;
  advancedPopoverTop: Nullable<number>;
  draggingAdvancedPopover: boolean;
  advancedPopoverDragOffsetX: number;
  advancedPopoverDragOffsetY: number;
  toolbarCollapsed: boolean;
  selectMode: boolean;
  depthLimit: Nullable<number>;
  zoom: number;
  viewX: number;
  viewY: number;
  areas: TreemapArea[];
  hoverId: Nullable<number>;
  hoverAreaKind: "node" | "self";
  hoveredTreemapToggleId: Nullable<number>;
  treemapToggleTooltipNodeId: Nullable<number>;
  treemapToggleTooltipClientX: number;
  treemapToggleTooltipClientY: number;
  selectedId: Nullable<number>;
  selectedAreaKind: "node" | "self";
  hoverCardActive: boolean;
  hoverCardLeft: Nullable<number>;
  hoverCardTop: number;
  draggingHoverCard: boolean;
  hoverCardDragOffsetX: number;
  hoverCardDragOffsetY: number;
  hoverUpdateTimer: Nullable<number>;
  selectClickTimer: Nullable<number>;
  sourceNodeId: Nullable<number>;
  sourceTargetKind: SourceTargetKind;
  search: string;
  filterScope: FilterScope;
  filterMode: FilterMode;
  searchError: string;
  matches: number[];
  matchIds: Set<number>;
  matchVisibleIds: Set<number>;
  matchSubtreeIds: Set<number>;
  matchLines: string[];
  sourceRequestToken: number;
  sourceAbortController: Nullable<AbortController>;
  sourcePanelFullscreen: boolean;
  sourceSearchMode: PatternMode;
  sourceSearch: string;
  sourceSearchError: string;
  sourceSearchMatchIndex: number;
  sourceBookmarkEditingKey: Nullable<string>;
  sourceBookmarkEditingLine: Nullable<number>;
  sourceBookmarkEditingDraft: string;
  sourceBookmarksByFile: Record<string, SourceBookmark[]>;
  searchHistoryByField: Record<string, string[]>;
  treePanelOpen: boolean;
  treePanelWidth: number;
  draggingTreePanelResize: boolean;
  treePanelResizeStartX: number;
  treePanelResizeStartWidth: number;
  matchPanelOpen: boolean;
  treeCollapsedIds: Set<number>;
  matchPanelWidth: number;
  matchPanelHeight: number;
  matchPanelLeft: Nullable<number>;
  matchPanelTop: number;
  draggingMatchPanel: boolean;
  matchPanelDragOffsetX: number;
  matchPanelDragOffsetY: number;
  draggingMatchPanelResizeX: boolean;
  draggingMatchPanelResizeY: boolean;
  matchPanelResizeStartX: number;
  matchPanelResizeStartY: number;
  matchPanelResizeStartWidth: number;
  matchPanelResizeStartHeight: number;
  treePanelDirty: boolean;
  matchPanelDirty: boolean;
  mainViewMode: MainViewMode;
  chartPanelOpen: boolean;
  chartMode: string;
  chartRenderMode: ChartRenderMode;
  chartLevel: Nullable<number>;
  chartPanelDirty: boolean;
  zenMode: boolean;
  zenOverlayLeft: Nullable<number>;
  zenOverlayTop: Nullable<number>;
  draggingZenOverlay: boolean;
  zenOverlayDragOffsetX: number;
  zenOverlayDragOffsetY: number;
  treemapAnalysisLegendLeft: Nullable<number>;
  treemapAnalysisLegendTop: Nullable<number>;
  draggingTreemapAnalysisLegend: boolean;
  treemapAnalysisLegendDragOffsetX: number;
  treemapAnalysisLegendDragOffsetY: number;
  chartPanelWidth: number;
  chartPanelHeight: number;
  chartPanelLeft: number;
  chartPanelTop: number;
  draggingChartPanelResize: boolean;
  chartPanelResizeStartX: number;
  chartPanelResizeStartY: number;
  chartPanelResizeStartWidth: number;
  chartPanelResizeStartHeight: number;
  isDragging: boolean;
  dragMoved: boolean;
  lastPointerX: number;
  lastPointerY: number;
  devicePixelRatio: number;
}

export type ViewerStateFixture = Partial<ViewerState> & Pick<ViewerState, "analysisLocalCounts" | "analysisLocalLocs">;

export interface AnalysisRuntime {
  nodes: HierarchyNode[];
  state: Pick<ViewerState, "analysisMode" | "analysisPatternMode" | "analysisPattern" | "analysisError" | "analysisLocalCounts" | "analysisSubtreeCounts" | "analysisLocalLocs" | "analysisSubtreeLocs" | "analysisLocalRatios" | "analysisSubtreeRatios" | "analysisMaxSubtreeCount">;
  analysisDefinitions: Nullable<AnalysisDefinition[]>;
  analysisDefinitionsLoadError: string;
}
