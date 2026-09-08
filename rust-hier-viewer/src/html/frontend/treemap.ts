import type {
  HierarchyNode,
  ViewerData,
  ViewerState,
  SourceTarget,
  SourceTargetKind,
  TreemapArea,
} from "./types.js";
import type {
  Rect,
  AreaKind,
  LayoutArea,
  LayoutItem,
  ClassicDivTree,
  AccurateDivTree,
  ThemeVisuals,
  AnalysisBucketStyle,
} from "./main-types.js";
import type { ChartController } from "./chart-types.js";
import { coverageColor, coverageDetailsHtml, coverageFilterActive } from "./coverage-display.js";
import {
  mixHexColors,
  hexToRgba,
  clampValue,
  formatMetricValue,
  normalizeAnalysisLegendFilter,
  clamp,
  hoverMetaLine,
} from "./ui.js";

export interface TreemapDependencies {
  state: ViewerState;
  themeSelect: HTMLSelectElement;
  getNode: (id: number) => HierarchyNode;
  analysisActive: () => boolean;
  analysisLocalValue: (nodeId: number) => number;
  analysisNodeQualified: (nodeId: number) => boolean;
  ctx: CanvasRenderingContext2D;
  canvas: HTMLCanvasElement;
  hideTreemapToggleTooltip: () => void;
  savePersistedState: () => void;
  nodeIsVisibleDescendantOf: (rootId: number, nodeId: number) => boolean;
  expandTreePath: (nodeId: number) => void;
  hoverCard: HTMLDivElement;
  clearUiAnnotationHoverTargetWithin: (container: Element | null) => void;
  currentMaxDepth: () => number;
  depthSelect: HTMLSelectElement;
  subtreeDepth: (nodeId: number) => number;
  visibleParent: (nodeId: number) => number | null;
  selectModeBtn: HTMLButtonElement;
  hoverTopbar: HTMLDivElement;
  hoverSelectedPill: HTMLDivElement;
  hoverDismissBtn: HTMLButtonElement;
  nodes: HierarchyNode[];
  applyMainViewMode: () => void;
  applyZenModeState: () => void;
  updateAnalysisVisibleExtents: () => void;
  updateAnalysisLegendVisibleSubtree: () => void;
  renderTreemapAnalysisLegend: () => void;
  buildBreadcrumbs: (nodeId: number) => void;
  updateStatus: () => void;
  renderTreePanel: () => void;
  renderMatchPanel: () => void;
  chartController: ChartController | null;
  applyHoverCardPosition: () => void;
  homeBtn: HTMLButtonElement;
  upBtn: HTMLButtonElement;
  scheduleUiAnnotations: () => void;
  sourcePanel: HTMLElement;
  hoverActions: HTMLDivElement;
  hoverPath: HTMLDivElement;
  hoverTitle: HTMLDivElement;
  nodeHasInstanceSource: (node: HierarchyNode) => boolean;
  formatLocation: (node: HierarchyNode) => string;
  nodeHasDefinitionSource: (node: HierarchyNode) => boolean;
  formatSourceLocation: (target: SourceTarget | null) => string;
  buildSourceTarget: (node: HierarchyNode | null, kind: SourceTargetKind | null) => SourceTarget | null;
  DATA: ViewerData;
  decompositionLabel: () => "n/a" | "subtree + local self" | "subtree only";
  hoverMeta: HTMLDivElement;
  openInstanceSourceBtn: HTMLButtonElement;
  openModuleSourceBtn: HTMLButtonElement;
  nodeHasAnySource: (node: HierarchyNode) => boolean;
  renderSource: (nodeId: number, targetKind?: SourceTargetKind | null) => Promise<void>;
  canvasPanel: HTMLElement;
  treemapAnalysisLegendHead: HTMLElement | null;
  treemapAnalysisLegend: HTMLDivElement;
  treemapStage: HTMLDivElement;
  applyTreemapAnalysisLegendPosition: () => void;
  showTreemapToggleTooltip: (nodeId: number, clientX: number, clientY: number) => void;
}

export function createTreemapRuntime(deps: TreemapDependencies) {
    const {
      state,
      themeSelect,
      getNode,
      analysisActive,
      analysisLocalValue,
      analysisNodeQualified,
      ctx,
      canvas,
      hideTreemapToggleTooltip,
      savePersistedState,
      nodeIsVisibleDescendantOf,
      expandTreePath,
      hoverCard,
      clearUiAnnotationHoverTargetWithin,
      currentMaxDepth,
      depthSelect,
      subtreeDepth,
      visibleParent,
      selectModeBtn,
      hoverTopbar,
      hoverSelectedPill,
      hoverDismissBtn,
      nodes,
      applyMainViewMode,
      applyZenModeState,
      updateAnalysisVisibleExtents,
      updateAnalysisLegendVisibleSubtree,
      renderTreemapAnalysisLegend,
      buildBreadcrumbs,
      updateStatus,
      renderTreePanel,
      renderMatchPanel,
      applyHoverCardPosition,
      homeBtn,
      upBtn,
      scheduleUiAnnotations,
      sourcePanel,
      hoverActions,
      hoverPath,
      hoverTitle,
      nodeHasInstanceSource,
      formatLocation,
      nodeHasDefinitionSource,
      formatSourceLocation,
      buildSourceTarget,
      DATA,
      decompositionLabel,
      hoverMeta,
      openInstanceSourceBtn,
      openModuleSourceBtn,
      nodeHasAnySource,
      renderSource,
      canvasPanel,
      treemapAnalysisLegendHead,
      treemapAnalysisLegend,
      treemapStage,
      applyTreemapAnalysisLegendPosition,
      showTreemapToggleTooltip
    } = deps;

    const analysisHatchPatternCache = new Map<string, CanvasPattern | null>();
    let interactionFrame: number | null = null;
    let zoomStatusDirty = false;
    let worldAreas: TreemapArea[] | null = null;
    let layoutWidth = 0;
    let layoutHeight = 0;
    let layoutZoom = 0;
    let projectedViewX = NaN;
    let projectedViewY = NaN;

    function weightedBits(variableBits: number, netBits: number) {
      return (
        variableBits * state.weightedVariableWeight +
        netBits * state.weightedNetWeight
      );
    }

    function subtreeWeightedBits(node: HierarchyNode) {
      return weightedBits(node.subtreeVariableBits || 0, node.subtreeNetBits || 0);
    }

    function localWeightedBits(node: HierarchyNode) {
      return weightedBits(node.moduleVariableBits || 0, node.moduleNetBits || 0);
    }

    const THEME_VISUALS: Record<string, ThemeVisuals> = {
      "warm-paper": {
        dark: false,
        canvasClassic: "#f6f1e7",
        canvasAccurate: "#f3eee4",
        canvasBase: "#efe6d8",
        panel: "#fff9f0",
        text: "#26180e",
        textSoft: "#6f5a46",
        accents: ["#c9d67d", "#9fd6a7", "#8dcfc3", "#9cc9e3", "#b8bbe4", "#d4bbd8", "#e2bf90"],
        match: "#d48722",
        analysisRamp: ["#e4a294", "#d8745d", "#bf4738", "#8d281d"],
      },
      "vscode-dark": {
        dark: true,
        canvasClassic: "#222324",
        canvasAccurate: "#1e1f20",
        canvasBase: "#252526",
        panel: "#252526",
        text: "#d4d4d4",
        textSoft: "#9da0a6",
        accents: ["#4ec9b0", "#9cdcfe", "#569cd6", "#b5cea8", "#dcdcaa", "#ce9178", "#c586c0"],
        match: "#dcdcaa",
        analysisRamp: ["#4ec9b0", "#569cd6", "#c586c0", "#f44747"],
      },
      "github-light": {
        dark: false,
        canvasClassic: "#f6f8fa",
        canvasAccurate: "#f0f3f6",
        canvasBase: "#f0f3f6",
        panel: "#ffffff",
        text: "#1f2328",
        textSoft: "#59636e",
        accents: ["#368c91", "#397cb8", "#7878b5", "#b16a8b", "#bf8951", "#649b7b", "#689bb5"],
        match: "#fb8f44",
        analysisRamp: ["#fb8f44", "#bc4c00", "#cf222e", "#8250df"],
      },
      "tokyo-night": {
        dark: true,
        canvasClassic: "#1b1d2a",
        canvasAccurate: "#171924",
        canvasBase: "#24283b",
        panel: "#24283b",
        text: "#c0caf5",
        textSoft: "#9aa5ce",
        accents: ["#9ece6a", "#73daca", "#7dcfff", "#7aa2f7", "#bb9af7", "#f7768e", "#e0af68"],
        match: "#e0af68",
        analysisRamp: ["#e0af68", "#ff9e64", "#f7768e", "#bb9af7"],
      },
      "nord": {
        dark: true,
        canvasClassic: "#313846",
        canvasAccurate: "#2e3440",
        canvasBase: "#3b4252",
        panel: "#434c5e",
        text: "#eceff4",
        textSoft: "#d8dee9",
        accents: ["#a3be8c", "#8fbcbb", "#88c0d0", "#81a1c1", "#5e81ac", "#b48ead", "#ebcb8b", "#d08770"],
        match: "#ebcb8b",
        analysisRamp: ["#ebcb8b", "#d08770", "#bf616a", "#b48ead"],
      },
      "solarized-light": {
        dark: false,
        canvasClassic: "#f7f0dd",
        canvasAccurate: "#f4ecd8",
        canvasBase: "#eee8d5",
        panel: "#fdf6e3",
        text: "#586e75",
        textSoft: "#657b83",
        accents: ["#859900", "#2aa198", "#268bd2", "#6c71c4", "#d33682", "#cb4b16", "#b58900"],
        match: "#b58900",
        analysisRamp: ["#b58900", "#cb4b16", "#dc322f", "#6c71c4"],
      },
      "catppuccin-latte": {
        dark: false,
        canvasClassic: "#e9edf4",
        canvasAccurate: "#e5e9f1",
        canvasBase: "#dce0e8",
        panel: "#eff1f5",
        text: "#4c4f69",
        textSoft: "#6c6f85",
        accents: ["#40a02b", "#179299", "#1e66f5", "#7287fd", "#ea76cb", "#fe640b", "#df8e1d"],
        match: "#df8e1d",
        analysisRamp: ["#df8e1d", "#fe640b", "#e64553", "#ea76cb"],
      }
    };

    function currentThemeVisuals() {
      return THEME_VISUALS[state.theme] || THEME_VISUALS["github-light"];
    }

    function themeNodeAccent(level: number) {
      const theme = currentThemeVisuals();
      return theme.accents[level % theme.accents.length];
    }

    function themeAnalysisBuckets(): [null, ...AnalysisBucketStyle[]] {
      const theme = currentThemeVisuals();
      return [
        null,
        ...theme.analysisRamp.map((color, index) => {
          const contentFill = mixHexColors(theme.canvasBase, color, theme.dark ? 0.18 + index * 0.04 : 0.12 + index * 0.04);
          const contentStroke = mixHexColors(theme.text, color, theme.dark ? 0.36 + index * 0.05 : 0.30 + index * 0.06);
          const shellFill = mixHexColors(theme.canvasBase, color, theme.dark ? 0.42 + index * 0.08 : 0.34 + index * 0.08);
          const shellStroke = mixHexColors(theme.text, color, theme.dark ? 0.64 + index * 0.05 : 0.54 + index * 0.06);
          return {
            contentFill,
            contentStroke,
            shellFill,
            shellStroke,
            labelText: theme.dark ? "rgba(236, 239, 244, 0.96)" : "rgba(44, 32, 24, 0.96)",
            badgeText: theme.dark ? "rgba(236, 239, 244, 0.98)" : "rgba(44, 32, 24, 0.98)"
          };
        })
      ];
    }

    function applyTheme() {
      document.body.dataset.theme = state.theme;
      if (themeSelect) {
        themeSelect.value = state.theme;
      }
    }

    function analysisLegendFilterSet() {
      return new Set(normalizeAnalysisLegendFilter(state.analysisLegendFilter));
    }

    function hasAnalysisLegendFilter(filterKey: string) {
      if (!filterKey) {
        return false;
      }
      return analysisLegendFilterSet().has(filterKey);
    }

    function toggleAnalysisLegendFilter(filterKey: string) {
      if (!filterKey) {
        return;
      }
      const next = analysisLegendFilterSet();
      if (next.has(filterKey)) {
        next.delete(filterKey);
      } else {
        next.add(filterKey);
      }
      state.analysisLegendFilter = Array.from(next).sort();
    }

    function weightForNode(nodeId: number) {
      const node = getNode(nodeId);
      const weight = state.metric === "leaves"
        ? node.subtreeLeaves
        : state.metric === "weighted_signals"
          ? subtreeWeightedBits(node)
        : state.metric === "signals"
          ? node.subtreeSignalBits
          : node.subtreeInstances;
      return Math.max(1, weight || 1);
    }

    function localWeightForNode(nodeId: number) {
      const node = getNode(nodeId);
      if (node.parent === null || node.parent === undefined) {
        return 0;
      }
      if (state.metric === "leaves") {
        return node.children.length === 0 ? 1 : 0;
      }
      if (state.metric === "signals") {
        return Math.max(0, node.moduleSignalBits || 0);
      }
      if (state.metric === "weighted_signals") {
        return Math.max(0, localWeightedBits(node));
      }
      return 1;
    }

    function nodeColor(level: number) {
      const theme = currentThemeVisuals();
      if (analysisActive()) {
        const neutral = mixHexColors(theme.canvasBase, theme.panel, theme.dark ? 0.28 : 0.20);
        return neutral;
      }
      const accent = themeNodeAccent(level);
      const ratio = theme.dark
        ? Math.min(0.58, 0.28 + level * 0.045)
        : Math.min(0.44, 0.18 + level * 0.04);
      return mixHexColors(theme.canvasBase, accent, ratio);
    }

    function selfAreaColor(level: number) {
      const theme = currentThemeVisuals();
      if (analysisActive()) {
        return hexToRgba(mixHexColors(theme.panel, theme.canvasBase, theme.dark ? 0.54 : 0.34), theme.dark ? 0.92 : 0.94);
      }
      const accent = themeNodeAccent(level);
      const fill = mixHexColors(theme.panel, accent, theme.dark ? 0.18 : 0.10);
      return hexToRgba(fill, theme.dark ? 0.86 : 0.92);
    }

    function nodeStroke(level: number) {
      const theme = currentThemeVisuals();
      if (analysisActive()) {
        return mixHexColors(theme.text, theme.canvasBase, theme.dark ? 0.34 : 0.26);
      }
      return theme.dark
        ? mixHexColors(theme.text, themeNodeAccent(level), 0.48)
        : mixHexColors(theme.canvasBase, themeNodeAccent(level), 0.65);
    }

    function selfAreaStroke(level: number) {
      const theme = currentThemeVisuals();
      if (analysisActive()) {
        return hexToRgba(mixHexColors(theme.text, theme.canvasBase, theme.dark ? 0.28 : 0.24), 0.92);
      }
      return hexToRgba(mixHexColors(theme.text, themeNodeAccent(level), theme.dark ? 0.38 : 0.30), 0.90);
    }

    function analysisBucketIndex(nodeId: number) {
      const normalized = analysisNormalizedValue(nodeId);
      if (normalized <= 0) {
        return 0;
      }
      if (normalized < 0.18) {
        return 1;
      }
      if (normalized < 0.42) {
        return 2;
      }
      if (normalized < 0.72) {
        return 3;
      }
      return 4;
    }

    function analysisLocalBucketStyle(nodeId: number) {
      const bucket = analysisBucketIndex(nodeId);
      const buckets = themeAnalysisBuckets();
      return buckets[Math.max(1, bucket)] || buckets[1];
    }

    function analysisContentFillColor(nodeId: number) {
      const highlightState = analysisNodeHighlightState(nodeId);
      if (highlightState === "local") {
        return analysisLocalBucketStyle(nodeId).contentFill;
      }
      if (highlightState === "descendant") {
        const theme = currentThemeVisuals();
        return mixHexColors(theme.canvasBase, theme.panel, theme.dark ? 0.36 : 0.24);
      }
      return currentThemeVisuals().canvasAccurate;
    }

    function analysisContentStrokeColor(nodeId: number) {
      const highlightState = analysisNodeHighlightState(nodeId);
      if (highlightState === "local") {
        return analysisLocalBucketStyle(nodeId).contentStroke;
      }
      if (highlightState === "descendant") {
        const theme = currentThemeVisuals();
        return mixHexColors(theme.text, theme.match, theme.dark ? 0.32 : 0.22);
      }
      return mixHexColors(currentThemeVisuals().text, currentThemeVisuals().canvasBase, currentThemeVisuals().dark ? 0.34 : 0.18);
    }

    function analysisLocalShellFill(nodeId: number) {
      return analysisLocalBucketStyle(nodeId).shellFill;
    }

    function analysisLocalShellStroke(nodeId: number) {
      return analysisLocalBucketStyle(nodeId).shellStroke;
    }

    function analysisLocalLabelColor(nodeId: number) {
      return analysisLocalBucketStyle(nodeId).labelText;
    }

    function analysisDescendantShellFill() {
      return mixHexColors(currentThemeVisuals().canvasBase, currentThemeVisuals().match, currentThemeVisuals().dark ? 0.56 : 0.42);
    }

    function analysisDescendantShellStroke() {
      return mixHexColors(currentThemeVisuals().text, currentThemeVisuals().match, currentThemeVisuals().dark ? 0.54 : 0.44);
    }

    function analysisBadgeFill(nodeId: number) {
      return analysisNodeHighlightState(nodeId) === "local"
        ? analysisLocalShellFill(nodeId)
        : analysisDescendantShellFill();
    }

    function analysisBadgeTextColor(nodeId: number) {
      return analysisNodeHighlightState(nodeId) === "local"
        ? analysisLocalBucketStyle(nodeId).badgeText
        : (currentThemeVisuals().dark ? "rgba(236, 239, 244, 0.96)" : "rgba(46, 27, 11, 0.96)");
    }

    function analysisHeaderStripHeight(areaHeight: number) {
      return clampValue(areaHeight * 0.16, 8, 22);
    }

    function analysisValueText(nodeId: number) {
      if (state.analysisMode === "count") {
        return formatMetricValue(state.analysisLocalCounts[nodeId] || 0);
      }
      if (state.analysisMode === "loc") {
        return formatMetricValue(state.analysisLocalLocs[nodeId] || 0);
      }
      return `${formatMetricValue((state.analysisLocalRatios[nodeId] || 0) * 100)}%`;
    }

    function analysisLabel() {
      if (state.analysisMode === "count") return "local pattern count";
      if (state.analysisMode === "loc") return "local module loc";
      if (state.analysisMode === "ratio") return "local pattern ratio";
      return "disabled";
    }

    function analysisValueForNode(nodeId: number) {
      return analysisLocalValue(nodeId);
    }

    function analysisNormalizedValue(nodeId: number) {
      if (!analysisNodeQualified(nodeId)) {
        return 0;
      }
      if (state.analysisMode === "count") {
        const maxCount = Math.max(1, state.analysisVisibleMaxCount || 0);
        const count = state.analysisLocalCounts[nodeId] || 0;
        return clampValue(
          Math.log10(count + 1) / Math.log10(maxCount + 1),
          0,
          1
        );
      }
      if (state.analysisMode === "loc") {
        const maxLoc = Math.max(1, state.analysisVisibleMaxLoc || 0);
        const loc = state.analysisLocalLocs[nodeId] || 0;
        return clampValue(
          Math.log10(loc + 1) / Math.log10(maxLoc + 1),
          0,
          1
        );
      }
      const maxRatio = Math.max(0, state.analysisVisibleMaxRatio || 0);
      if (maxRatio <= 0) {
        return 0;
      }
      const ratio = state.analysisLocalRatios[nodeId] || 0;
      return clampValue(ratio / maxRatio, 0, 1);
    }

    function analysisOverlayAlpha(nodeId: number) {
      const normalized = analysisNormalizedValue(nodeId);
      return Math.max(0, Math.min(0.7, normalized * 0.7));
    }

    function selectedAnalysisLegendBuckets() {
      return normalizeAnalysisLegendFilter(state.analysisLegendFilter)
        .map((entry) => {
          const match = /^bucket-([1-4])$/.exec(entry);
          return match ? Number(match[1]) : null;
        })
        .filter((bucket) => bucket !== null);
    }

    function analysisLegendLocalBucketMatches(nodeId: number) {
      const buckets = selectedAnalysisLegendBuckets();
      return buckets.length > 0
        && analysisNodeQualified(nodeId)
        && buckets.includes(analysisBucketIndex(nodeId));
    }

    function analysisBaseHighlightState(nodeId: number) {
      if (!analysisActive()) {
        return "none";
      }
      if (analysisNodeQualified(nodeId)) {
        return "local";
      }
      return state.analysisVisibleSubtreeQualified[nodeId] ? "descendant" : "none";
    }

    function analysisNodeHighlightState(nodeId: number) {
      const baseState = analysisBaseHighlightState(nodeId);
      const activeFilters = normalizeAnalysisLegendFilter(state.analysisLegendFilter);
      if (!analysisActive() || !activeFilters.length) {
        return baseState;
      }
      const descendantSelected = activeFilters.includes("descendant");
      const localSelected = analysisLegendLocalBucketMatches(nodeId);
      if (localSelected) {
        return "local";
      }
      if (descendantSelected && baseState === "descendant") {
        return "descendant";
      }
      if (!descendantSelected && state.analysisLegendVisibleSubtree[nodeId]) {
        return "descendant";
      }
      return "none";
    }

    function getAnalysisHatchPattern(kind: AreaKind) {
      const key = kind === "self" ? "self" : "node";
      if (analysisHatchPatternCache.has(key)) {
        return analysisHatchPatternCache.get(key);
      }

      const tile = document.createElement("canvas");
      tile.width = 12;
      tile.height = 12;
      const tileCtx = tile.getContext("2d")!;
      tileCtx.clearRect(0, 0, tile.width, tile.height);
      tileCtx.strokeStyle = key === "self" ? "#8f3a2d" : "#8b2015";
      tileCtx.lineWidth = key === "self" ? 1.25 : 1.45;
      tileCtx.beginPath();
      tileCtx.moveTo(-3, 11);
      tileCtx.lineTo(5, 3);
      tileCtx.moveTo(1, 15);
      tileCtx.lineTo(9, 7);
      tileCtx.moveTo(5, 11);
      tileCtx.lineTo(13, 3);
      tileCtx.stroke();

      const pattern = ctx.createPattern(tile, "repeat");
      analysisHatchPatternCache.set(key, pattern);
      return pattern;
    }

    function suspendAnalysisHatch(durationMs = 120) {
      state.analysisHatchDisabledUntil = Math.max(
        state.analysisHatchDisabledUntil,
        performance.now() + durationMs
      );
    }

    function analysisHatchEnabled() {
      return performance.now() >= state.analysisHatchDisabledUntil;
    }

    function shouldDrawAnalysisHatch(area: TreemapArea, width: number, height: number, alpha: number) {
      if (!analysisHatchEnabled()) {
        return false;
      }
      if (width * height < 1800) {
        return false;
      }
      if (Math.min(width, height) < 16) {
        return false;
      }
      if (alpha < 0.08) {
        return false;
      }
      if (area.kind === "self" && height < 20) {
        return false;
      }
      return true;
    }

    function resizeCanvas() {
      const rect = canvas.getBoundingClientRect();
      const ratio = Math.max(1, window.devicePixelRatio || 1);
      state.devicePixelRatio = ratio;
      const nextWidth = Math.max(1, Math.round(rect.width * ratio));
      const nextHeight = Math.max(1, Math.round(rect.height * ratio));
      if (canvas.width !== nextWidth || canvas.height !== nextHeight) {
        canvas.width = nextWidth;
        canvas.height = nextHeight;
      }
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    }

    function clampView() {
      return;
    }

    function resetView() {
      state.zoom = 1;
      state.viewX = 0;
      state.viewY = 0;
      state.isDragging = false;
      state.dragMoved = false;
      canvas.style.cursor = "default";
      hideTreemapToggleTooltip();
    }

    function changeZoom(factor: number, anchorX: number, anchorY: number) {
      const oldZoom = state.zoom;
      const nextZoom = clamp(oldZoom * factor, 0.01, 2048);
      if (Math.abs(nextZoom - oldZoom) < 0.0001) {
        return;
      }

      suspendAnalysisHatch(150);
      state.viewX = (state.viewX + anchorX) * (nextZoom / oldZoom) - anchorX;
      state.viewY = (state.viewY + anchorY) * (nextZoom / oldZoom) - anchorY;
      state.zoom = nextZoom;
      savePersistedState();
      zoomStatusDirty = true;
      requestInteractionPaint();
    }

    function setRootAndReset(rootId: number) {
      cancelScheduledHoverUpdate();
      clearPendingSelectClick();
      hideTreemapToggleTooltip();
      const preservedSelectedId = state.selectedId;
      const preservedSelectedAreaKind = state.selectedAreaKind;
      const preserveSelection =
        hasLockedSelection() &&
        nodeIsVisibleDescendantOf(rootId, state.selectedId!);
      if (!preserveSelection) {
        resetLockedSelection();
      }
      state.currentRoot = rootId;
      expandTreePath(rootId);
      if (preserveSelection) {
        expandTreePath(preservedSelectedId!);
      }
      state.treePanelDirty = true;
      resetView();
      if (preserveSelection) {
        updateHover(preservedSelectedId, preservedSelectedAreaKind, { force: true });
      } else {
        state.hoverId = null;
        state.hoverAreaKind = "node";
        hoverCard.classList.add("hidden");
        clearUiAnnotationHoverTargetWithin(hoverCard);
      }
      savePersistedState();
      draw();
    }

    function syncDepthControl() {
      const maxDepth = currentMaxDepth();
      if (state.depthLimit !== null && state.depthLimit > maxDepth) {
        state.depthLimit = maxDepth > 0 ? maxDepth : null;
      }

      const selectedValue = state.depthLimit === null ? "max" : String(state.depthLimit);
      depthSelect.innerHTML = "";

      const maxOption = document.createElement("option");
      maxOption.value = "max";
      maxOption.textContent = maxDepth > 0 ? `Max (${maxDepth})` : "Max";
      depthSelect.appendChild(maxOption);

      for (let depth = 1; depth <= maxDepth; depth += 1) {
        const option = document.createElement("option");
        option.value = String(depth);
        option.textContent = String(depth);
        depthSelect.appendChild(option);
      }

      depthSelect.value = selectedValue;
      depthSelect.disabled = maxDepth === 0;
    }

    function rectIntersectsViewport(rect: Rect, width: number, height: number) {
      return !(
        rect.x + rect.w < 0 ||
        rect.y + rect.h < 0 ||
        rect.x > width ||
        rect.y > height
      );
    }

    function layoutItemsForNode(nodeId: number): LayoutItem[] {
      const node = getNode(nodeId);
      const items: LayoutItem[] = [];

      for (const childId of node.children) {
        items.push({
          nodeId: childId,
          kind: "node",
          weight: weightForNode(childId)
        });
      }

      if (state.decomposition === "self") {
        const selfWeight = localWeightForNode(nodeId);
        if (selfWeight > 0) {
          items.push({
            nodeId,
            kind: "self",
            weight: selfWeight
          });
        }
      }

      return items.filter((item) => item.weight > 0);
    }

    function fillRoundedBadge(x: number, y: number, width: number, height: number, radius: number) {
      if (typeof ctx.roundRect === "function") {
        ctx.beginPath();
        ctx.roundRect(x, y, width, height, radius);
        ctx.fill();
        return;
      }

      const r = Math.max(0, Math.min(radius, width / 2, height / 2));
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + width - r, y);
      ctx.quadraticCurveTo(x + width, y, x + width, y + r);
      ctx.lineTo(x + width, y + height - r);
      ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
      ctx.lineTo(x + r, y + height);
      ctx.quadraticCurveTo(x, y + height, x, y + height - r);
      ctx.lineTo(x, y + r);
      ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.closePath();
      ctx.fill();
    }

    function orderedAccurateItems(nodeId: number) {
      return layoutItemsForNode(nodeId)
        .map((item, index) => ({ ...item, originalIndex: index }))
        .sort((left, right) => {
          if (left.kind !== right.kind) {
            return left.kind === "node" ? -1 : 1;
          }
          const diff = right.weight - left.weight;
          if (diff !== 0) {
            return diff;
          }
          return left.originalIndex - right.originalIndex;
        });
    }

    function buildClassicDivTree(childIds: number[]): ClassicDivTree | null {
      if (!childIds.length) {
        return null;
      }
      if (childIds.length === 1) {
        return { nodeId: childIds[0], kind: "node", size: weightForNode(childIds[0]) };
      }

      const sorted = childIds.slice().sort((a, b) => {
        const diff = weightForNode(b) - weightForNode(a);
        if (diff !== 0) return diff;
        return getNode(a).name.localeCompare(getNode(b).name);
      });

      const left: number[] = [];
      const right: number[] = [];
      let leftSize = 0;
      let rightSize = 0;

      for (const id of sorted) {
        if (leftSize < rightSize) {
          left.push(id);
          leftSize += weightForNode(id);
        } else {
          right.push(id);
          rightSize += weightForNode(id);
        }
      }

      return {
        size: leftSize + rightSize,
        children: [buildClassicDivTree(left)!, buildClassicDivTree(right)!]
      };
    }

    function divideClassicRects(divNode: ClassicDivTree | null, rect: Rect, out: LayoutArea[]) {
      if (!divNode) return;
      if (divNode.nodeId !== undefined) {
        out.push({ nodeId: divNode.nodeId, kind: "node", rect });
        return;
      }

      const [leftTree, rightTree] = divNode.children;
      const total = Math.max(1, divNode.size);
      const ratio = leftTree.size / total;

      const left = rect.x;
      const top = rect.y;
      const width = rect.w;
      const height = rect.h;

      let rectA: Rect;
      let rectB: Rect;
      if (width * 1.02 > height) {
        const split = width * ratio;
        rectA = { x: left, y: top, w: split, h: height };
        rectB = { x: left + split, y: top, w: width - split, h: height };
      } else {
        const split = height * ratio;
        rectA = { x: left, y: top, w: width, h: split };
        rectB = { x: left, y: top + split, w: width, h: height - split };
      }

      divideClassicRects(leftTree, rectA, out);
      divideClassicRects(rightTree, rectB, out);
    }

    function layoutChildrenClassic(nodeId: number, rect: Rect) {
      const childIds = getNode(nodeId).children;
      const divTree = buildClassicDivTree(childIds);
      const areas: LayoutArea[] = [];
      divideClassicRects(divTree, rect, areas);
      return areas;
    }

    function sumItemWeight(items: LayoutItem[]) {
      return items.reduce((sum, item) => sum + item.weight, 0);
    }

    function accurateOrientation(rect: Rect) {
      return rect.w >= rect.h ? "columns" : "rows";
    }

    function splitRect(rect: Rect, orientation: string, firstRatio: number) {
      const ratio = Math.max(0, Math.min(1, firstRatio));
      if (orientation === "columns") {
        const firstWidth = rect.w * ratio;
        const secondX = rect.x + firstWidth;
        return [
          { x: rect.x, y: rect.y, w: firstWidth, h: rect.h },
          { x: secondX, y: rect.y, w: Math.max(0, rect.x + rect.w - secondX), h: rect.h }
        ];
      }

      const firstHeight = rect.h * ratio;
      const secondY = rect.y + firstHeight;
      return [
        { x: rect.x, y: rect.y, w: rect.w, h: firstHeight },
        { x: rect.x, y: secondY, w: rect.w, h: Math.max(0, rect.y + rect.h - secondY) }
      ];
    }

    function makeAccurateLeaf(item: LayoutItem): AccurateDivTree {
      return {
        kind: "leaf",
        areaKind: item.kind,
        nodeId: item.nodeId,
        size: item.weight
      };
    }

    function buildAccurateDivTree(items: LayoutItem[]): AccurateDivTree | null {
      if (!items.length) {
        return null;
      }

      if (items.length === 1) {
        return makeAccurateLeaf(items[0]);
      }

      const totalWeight = sumItemWeight(items);
      const dominant = items[0];
      const dominantRatio = dominant.weight / Math.max(totalWeight, 1e-9);
      const remainingRatio = 1 - dominantRatio;

      if (items.length >= 4 && dominantRatio >= 0.72 && remainingRatio >= 0.015) {
        return {
          kind: "pivot",
          size: totalWeight,
          primary: makeAccurateLeaf(dominant),
          rest: buildAccurateDivTree(items.slice(1))
        };
      }

      const left: LayoutItem[] = [];
      const right: LayoutItem[] = [];
      let leftSize = 0;
      let rightSize = 0;

      for (const item of items) {
        if (leftSize <= rightSize) {
          left.push(item);
          leftSize += item.weight;
        } else {
          right.push(item);
          rightSize += item.weight;
        }
      }

      if (!left.length || !right.length) {
        const midpoint = Math.max(1, Math.floor(items.length / 2));
        return {
          kind: "split",
          size: totalWeight,
          children: [
            buildAccurateDivTree(items.slice(0, midpoint))!,
            buildAccurateDivTree(items.slice(midpoint))!
          ]
        };
      }

      return {
        kind: "split",
        size: totalWeight,
        children: [buildAccurateDivTree(left)!, buildAccurateDivTree(right)!]
      };
    }

    function divideAccurateRects(divNode: AccurateDivTree | null, rect: Rect, out: LayoutArea[]) {
      if (!divNode || rect.w <= 0 || rect.h <= 0) {
        return;
      }

      if (divNode.kind === "leaf") {
        out.push({
          nodeId: divNode.nodeId,
          kind: divNode.areaKind,
          rect
        });
        return;
      }

      if (divNode.kind === "pivot") {
        const orientation = accurateOrientation(rect);
        const [primaryRect, restRect] = splitRect(
          rect,
          orientation,
          divNode.primary.size / Math.max(divNode.size, 1e-9)
        );
        divideAccurateRects(divNode.primary, primaryRect, out);
        divideAccurateRects(divNode.rest, restRect, out);
        return;
      }

      const [leftTree, rightTree] = divNode.children;
      const total = Math.max(1, divNode.size);
      const ratio = leftTree.size / total;

      let rectA: Rect;
      let rectB: Rect;
      if (rect.w * 1.02 > rect.h) {
        const split = rect.w * ratio;
        rectA = { x: rect.x, y: rect.y, w: split, h: rect.h };
        rectB = { x: rect.x + split, y: rect.y, w: rect.w - split, h: rect.h };
      } else {
        const split = rect.h * ratio;
        rectA = { x: rect.x, y: rect.y, w: rect.w, h: split };
        rectB = { x: rect.x, y: rect.y + split, w: rect.w, h: rect.h - split };
      }

      divideAccurateRects(leftTree, rectA, out);
      divideAccurateRects(rightTree, rectB, out);
    }

    function reserveSelfStrip(items: LayoutItem[], rect: Rect, out: LayoutArea[]) {
      if (!items.length) {
        return { items, rect };
      }

      const lastItem = items[items.length - 1];
      if (lastItem.kind !== "self") {
        return { items, rect };
      }

      if (items.length === 1) {
        out.push({ nodeId: lastItem.nodeId, kind: "self", rect: { ...rect } });
        return { items: [], rect: null };
      }

      const totalWeight = sumItemWeight(items);
      const selfRatio = lastItem.weight / Math.max(totalWeight, 1e-9);
      const orientation = accurateOrientation(rect);
      const childRectRatio = Math.max(0, 1 - selfRatio);
      const [childRect, selfRect] = splitRect(rect, orientation, childRectRatio);

      out.push({ nodeId: lastItem.nodeId, kind: "self", rect: selfRect });
      return { items: items.slice(0, -1), rect: childRect };
    }

    function layoutChildrenAccurate(nodeId: number, rect: Rect, level: number) {
      const items = orderedAccurateItems(nodeId);
      if (!items.length || rect.w <= 0 || rect.h <= 0) {
        return [];
      }

      const areas: LayoutArea[] = [];
      const reserved = reserveSelfStrip(items, rect, areas);
      if (!reserved.rect || !reserved.items.length) {
        return areas;
      }

      const divTree = buildAccurateDivTree(reserved.items);
      divideAccurateRects(divTree, reserved.rect, areas);
      return areas;
    }

    function layoutChildren(nodeId: number, rect: Rect, level: number) {
      if (state.layoutMode === "classic") {
        return layoutChildrenClassic(nodeId, rect);
      }
      return layoutChildrenAccurate(nodeId, rect, level);
    }

    function createAreas(rootId: number, width: number, height: number): TreemapArea[] {
      const margin = { left: 8, top: 28, right: 8, bottom: 8 };
      const rootArea: TreemapArea = {
        nodeId: rootId,
        kind: "node",
        level: 0,
        rect: { x: 0, y: 0, w: width, h: height }
      };
      const allAreas = [rootArea];
      let frontier = [rootArea];
      const rootMaxDepth = subtreeDepth(rootId);
      const maxLevels = state.depthLimit === null
        ? rootMaxDepth
        : Math.min(state.depthLimit, rootMaxDepth);

      for (let level = 1; level <= maxLevels; level += 1) {
        const next: TreemapArea[] = [];
        for (const area of frontier) {
          if (area.kind !== "node") continue;
          const node = getNode(area.nodeId);
          if (!node.children.length) continue;
          if (state.treeCollapsedIds.has(area.nodeId)) continue;

          const inner = {
            x: area.rect.x + margin.left,
            y: area.rect.y + margin.top,
            w: area.rect.w - margin.left - margin.right,
            h: area.rect.h - margin.top - margin.bottom
          };
          if (inner.w < 42 || inner.h < 42) continue;

          const laidOut = layoutChildren(area.nodeId, inner, area.level);
          for (const childArea of laidOut) {
            if (childArea.rect.w < 2 || childArea.rect.h < 2) continue;
            const entry = {
              nodeId: childArea.nodeId,
              kind: childArea.kind,
              level,
              rect: childArea.rect
            };
            next.push(entry);
            allAreas.push(entry);
          }
        }
        if (!next.length) break;
        frontier = next;
      }

      return allAreas;
    }

    function isMatch(nodeId: number) {
      return (!!state.search || coverageFilterActive(state.coverage)) && state.matchIds.has(nodeId);
    }

    function shouldDim(nodeId: number) {
      const filterDimmed = (
        (state.search || coverageFilterActive(state.coverage)) &&
        !state.searchError &&
        (state.matches.length > 0 || coverageFilterActive(state.coverage)) &&
        !state.matchSubtreeIds.has(nodeId)
      );
      const analysisDimmed = analysisActive() && analysisNodeHighlightState(nodeId) === "none";
      return filterDimmed || analysisDimmed;
    }

    function hasMatchedDescendant(nodeId: number) {
      return (
        (state.search || coverageFilterActive(state.coverage)) &&
        !state.searchError &&
        state.matches.length > 0 &&
        state.matchSubtreeIds.has(nodeId) &&
        !isMatch(nodeId)
      );
    }

    function hiddenSelectedMarkerIds(worldAreas: TreemapArea[]) {
      const markerIds = new Set<number>();
      if (!hasLockedSelection()) {
        return markerIds;
      }

      let selectedAreaVisible = false;
      let selectedNodeVisible = false;
      for (const area of worldAreas) {
        if (area.nodeId !== state.selectedId) {
          continue;
        }
        if (area.kind === "node") {
          selectedNodeVisible = true;
        }
        if (area.kind === state.selectedAreaKind) {
          selectedAreaVisible = true;
          break;
        }
      }

      if (selectedAreaVisible) {
        return markerIds;
      }

      let cursor = state.selectedAreaKind === "self" && selectedNodeVisible
        ? state.selectedId
        : visibleParent(state.selectedId!);
      while (cursor !== null && cursor !== undefined) {
        markerIds.add(cursor);
        if (cursor === state.currentRoot) {
          break;
        }
        cursor = visibleParent(cursor);
      }

      return markerIds;
    }

    function isHoveredArea(area: TreemapArea) {
      return area.nodeId === state.hoverId && area.kind === state.hoverAreaKind;
    }

    function setHoveredTreemapToggle(nodeId: number | null) {
      if (state.hoveredTreemapToggleId === nodeId) {
        return false;
      }
      state.hoveredTreemapToggleId = nodeId;
      return true;
    }

    function hasLockedSelection() {
      return state.selectedId !== null && state.selectedId !== undefined;
    }

    function isSelectedArea(area: TreemapArea | null) {
      return !!(
        area &&
        hasLockedSelection() &&
        area.nodeId === state.selectedId &&
        area.kind === state.selectedAreaKind
      );
    }

    function clearPendingSelectClick() {
      if (state.selectClickTimer !== null) {
        window.clearTimeout(state.selectClickTimer);
        state.selectClickTimer = null;
      }
    }

    function resetLockedSelection() {
      clearPendingSelectClick();
      state.selectedId = null;
      state.selectedAreaKind = "node";
    }

    function applySelectModeState() {
      if (!selectModeBtn) {
        return;
      }
      selectModeBtn.classList.toggle("active", state.selectMode);
      selectModeBtn.setAttribute("aria-pressed", state.selectMode ? "true" : "false");
    }

    function applyHoverCardLockState() {
      const locked =
        hasLockedSelection() &&
        state.hoverId === state.selectedId &&
        state.hoverAreaKind === state.selectedAreaKind;
      hoverCard.classList.toggle("locked", locked);
      hoverTopbar.classList.toggle("hidden", !locked);
      hoverSelectedPill.classList.toggle("hidden", !locked);
      hoverDismissBtn.classList.toggle("hidden", !locked);
    }

    function lockSelectedArea(nodeId: number, areaKind: AreaKind = "node") {
      state.selectedId = nodeId;
      state.selectedAreaKind = areaKind;
      updateHover(nodeId, areaKind, { force: true });
    }

    function clearSelectedArea() {
      const hadSelection = hasLockedSelection();
      resetLockedSelection();
      if (!hadSelection) {
        updateHover(null, "node", { force: true });
        return;
      }
      updateHover(null, "node", { force: true });
    }

    function visibleAreaRect(area: TreemapArea) {
      const inset = state.layoutMode === "accurate"
        ? area.kind === "self" ? 1.5 : 0.9
        : 0;
      return {
        x: area.rect.x + inset,
        y: area.rect.y + inset,
        w: Math.max(0, area.rect.w - inset * 2),
        h: Math.max(0, area.rect.h - inset * 2)
      };
    }

    function visibleNodeContentRect(area: TreemapArea, outerRect: Rect | null = null) {
      const outer = outerRect || visibleAreaRect(area);
      return {
        x: outer.x + 8,
        y: outer.y + 28,
        w: Math.max(0, outer.w - 16),
        h: Math.max(0, outer.h - 36)
      };
    }

    function isTreemapCollapsibleNode(area: TreemapArea | null) {
      return !!(
        area &&
        area.kind === "node" &&
        getNode(area.nodeId).children.length > 0
      );
    }

    function treemapCollapseToggleRect(area: TreemapArea) {
      if (!isTreemapCollapsibleNode(area)) {
        return null;
      }
      const { x, y, w, h } = visibleAreaRect(area);
      if (w < 26 || h < 26) {
        return null;
      }
      const size = clampValue(Math.min(w, h) * 0.13, 10, 15);
      const inset = clampValue(size * 0.54, 3, 7);
      return {
        x: x + w - inset - size,
        y: y + h - inset - size,
        w: size,
        h: size,
      };
    }

    function isTreemapNodeCollapsed(nodeId: number) {
      return state.treeCollapsedIds.has(nodeId);
    }

    function clearAllTreemapCollapsedNodes() {
      if (!state.treeCollapsedIds.size) {
        return;
      }
      state.treeCollapsedIds.clear();
      state.treePanelDirty = true;
      savePersistedState();
      draw();
    }

    function toggleTreemapCollapsedNode(nodeId: number) {
      if (!(Number.isInteger as (value: unknown) => value is number)(nodeId) || nodeId < 0 || nodeId >= nodes.length) {
        return;
      }
      if (getNode(nodeId).children.length === 0) {
        return;
      }
      if (state.treeCollapsedIds.has(nodeId)) {
        state.treeCollapsedIds.delete(nodeId);
      } else {
        state.treeCollapsedIds.add(nodeId);
      }
      state.treePanelDirty = true;
      savePersistedState();
      draw();
    }

    function fitLabel(text: string, maxWidth: number) {
      if (!text || maxWidth <= 8) {
        return "";
      }
      if (ctx.measureText(text).width <= maxWidth) {
        return text;
      }

      let end = text.length;
      while (end > 1) {
        const candidate = `${text.slice(0, end)}...`;
        if (ctx.measureText(candidate).width <= maxWidth) {
          return candidate;
        }
        end -= 1;
      }
      return "";
    }

    function drawLabels(area: TreemapArea) {
      const node = getNode(area.nodeId);
      const { x, y, w, h } = visibleAreaRect(area);
      if (w <= 0 || h <= 0) {
        return;
      }

      const hovered = isHoveredArea(area);
      if (area.kind === "self") {
        if (!hovered || w < 88 || h < 22) {
          return;
        }
      } else if (state.layoutMode === "accurate") {
        if ((w < 118 || h < 52) && !hovered) {
          return;
        }
      } else if ((w < 88 || h < 40) && !hovered) {
        return;
      }

      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
      const analysisHighlightState = analysisNodeHighlightState(area.nodeId);
      const theme = currentThemeVisuals();
      ctx.fillStyle = shouldDim(area.nodeId)
        ? hexToRgba(theme.text, theme.dark ? 0.36 : 0.34)
        : state.layoutMode === "accurate"
          ? hexToRgba(theme.text, theme.dark ? 0.86 : 0.82)
          : hexToRgba(theme.text, theme.dark ? 0.92 : 0.88);
      if (
        analysisActive() &&
        area.kind === "node" &&
        analysisHighlightState !== "none" &&
        !shouldDim(area.nodeId)
      ) {
        ctx.fillStyle = analysisHighlightState === "local"
          ? analysisLocalLabelColor(area.nodeId)
          : hexToRgba(theme.text, 0.96);
      }
      if (area.kind === "self") {
        ctx.fillStyle = shouldDim(area.nodeId)
          ? hexToRgba(theme.textSoft, theme.dark ? 0.42 : 0.46)
          : hexToRgba(theme.panel, theme.dark ? 0.72 : 0.78);
        const badgeWidth = Math.min(84, Math.max(48, w - 14));
        fillRoundedBadge(x + 8, y + 8, badgeWidth, 18, 9);
        ctx.fillStyle = shouldDim(area.nodeId) ? hexToRgba(theme.text, 0.5) : hexToRgba(theme.text, 0.72);
        ctx.font = "600 11px system-ui, sans-serif";
        const label = fitLabel("local self", badgeWidth - 16);
        if (label) {
          ctx.fillText(label, x + 16, y + 21);
        }
      } else {
        ctx.font = state.layoutMode === "accurate"
          ? (hovered
            ? "600 13px system-ui, sans-serif"
            : "600 12px system-ui, sans-serif")
          : "600 13px system-ui, sans-serif";
        const label = fitLabel(node.name, w - 16);
        if (label) {
          ctx.fillText(
            label,
            x + 8,
            y + (state.layoutMode === "accurate" ? 17 : 18)
          );
        }
      }
      ctx.restore();
    }

    function nodeIsLeaf(nodeId: number) {
      return getNode(nodeId).children.length === 0;
    }

    function shouldDrawLeafBadge(area: TreemapArea, width: number, height: number) {
      return area.kind === "node" && nodeIsLeaf(area.nodeId) && width >= 18 && height >= 18;
    }

    function drawLeafBadge(area: TreemapArea) {
      const { x, y, w, h } = visibleAreaRect(area);
      if (!shouldDrawLeafBadge(area, w, h)) {
        return;
      }

      const size = clampValue(Math.min(w, h) * 0.16, 6, 10);
      const inset = clampValue(size * 0.9, 6, 10);
      const centerX = x + inset;
      const centerY = y + h - inset;

      ctx.save();
      ctx.beginPath();
      ctx.moveTo(centerX, centerY - size / 2);
      ctx.lineTo(centerX + size / 2, centerY);
      ctx.lineTo(centerX, centerY + size / 2);
      ctx.lineTo(centerX - size / 2, centerY);
      ctx.closePath();
      ctx.fillStyle = shouldDim(area.nodeId)
        ? hexToRgba(currentThemeVisuals().textSoft, currentThemeVisuals().dark ? 0.72 : 0.74)
        : hexToRgba(currentThemeVisuals().text, currentThemeVisuals().dark ? 0.88 : 0.88);
      ctx.fill();
      ctx.strokeStyle = shouldDim(area.nodeId)
        ? hexToRgba(currentThemeVisuals().panel, currentThemeVisuals().dark ? 0.62 : 0.68)
        : hexToRgba(currentThemeVisuals().panel, currentThemeVisuals().dark ? 0.88 : 0.94);
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.restore();
    }

    function drawTreemapCollapseToggle(area: TreemapArea) {
      const toggleRect = treemapCollapseToggleRect(area);
      if (!toggleRect) {
        return;
      }
      const collapsed = isTreemapNodeCollapsed(area.nodeId);
      const toggleHovered = state.hoveredTreemapToggleId === area.nodeId;
      const hovered = toggleHovered || isHoveredArea(area);
      const dimmed = shouldDim(area.nodeId);
      const theme = currentThemeVisuals();
      const fillBase = collapsed
        ? mixHexColors(theme.panel, theme.match, theme.dark ? 0.34 : 0.16)
        : mixHexColors(theme.panel, theme.canvasBase, theme.dark ? 0.22 : 0.08);
      const strokeBase = collapsed
        ? mixHexColors(theme.text, theme.match, theme.dark ? 0.22 : 0.12)
        : mixHexColors(theme.text, theme.panel, theme.dark ? 0.10 : 0.05);
      const fillAlphaBase = collapsed
        ? (toggleHovered ? 0.72 : (hovered ? 0.54 : 0.36))
        : (toggleHovered ? 0.42 : (hovered ? 0.24 : 0.12));
      const strokeAlphaBase = collapsed
        ? (toggleHovered ? 0.92 : (hovered ? 0.66 : 0.44))
        : (toggleHovered ? 0.58 : (hovered ? 0.34 : 0.18));
      const symbolAlphaBase = collapsed
        ? (toggleHovered ? 1 : (hovered ? 0.96 : 0.84))
        : (toggleHovered ? 0.96 : (hovered ? 0.82 : 0.58));
      const alphaScale = dimmed ? 0.82 : 1;
      const fillAlpha = fillAlphaBase * alphaScale;
      const strokeAlpha = strokeAlphaBase * alphaScale;
      const symbolAlpha = symbolAlphaBase * alphaScale;
      const symbolBase = collapsed
        ? (theme.dark ? "#f7f3ea" : mixHexColors(theme.text, theme.match, 0.18))
        : theme.text;
      const centerX = toggleRect.x + toggleRect.w / 2;
      const centerY = toggleRect.y + toggleRect.h / 2;
      const radius = Math.max(4.5, toggleRect.w / 2 - 0.7);
      const half = Math.max(2.2, Math.floor(toggleRect.w * 0.18));

      ctx.save();
      ctx.beginPath();
      ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
      if (toggleHovered) {
        ctx.shadowColor = hexToRgba(theme.match, theme.dark ? 0.34 : 0.24);
        ctx.shadowBlur = collapsed ? 14 : 10;
      }
      ctx.fillStyle = hexToRgba(fillBase, fillAlpha);
      ctx.fill();
      ctx.lineWidth = toggleHovered ? 1.45 : (hovered ? 1.2 : 0.95);
      ctx.strokeStyle = hexToRgba(strokeBase, strokeAlpha);
      ctx.stroke();
      ctx.strokeStyle = hexToRgba(symbolBase, symbolAlpha);
      ctx.lineWidth = Math.max(toggleHovered ? 1.35 : 1.1, toggleRect.w * (toggleHovered ? 0.11 : 0.09));
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(centerX - half, centerY);
      ctx.lineTo(centerX + half, centerY);
      if (collapsed) {
        ctx.moveTo(centerX, centerY - half);
        ctx.lineTo(centerX, centerY + half);
      }
      ctx.stroke();
      ctx.restore();
    }

    function drawTreemapCornerIndicator(area: TreemapArea, slotIndex: number, fillStyle: string, outlineStyle: string, radius: number = 4.5) {
      const { x, y, w, h } = visibleAreaRect(area);
      if (w <= 0 || h <= 0) {
        return;
      }
      const insetX = 11 + slotIndex * (radius * 2 + 4);
      const dotX = x + w - insetX;
      const dotY = y + Math.max(11, radius + 6);
      ctx.fillStyle = fillStyle;
      ctx.beginPath();
      ctx.arc(dotX, dotY, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = outlineStyle;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // External callers may mutate any content state before drawing, including sets
    // and analysis arrays in place. A full draw always invalidates cached geometry.
    function draw() {
      if (interactionFrame !== null) {
        window.cancelAnimationFrame(interactionFrame);
        interactionFrame = null;
      }
      zoomStatusDirty = false;
      worldAreas = null;
      applyMainViewMode();
      applyZenModeState();
      syncDepthControl();
      updateAnalysisVisibleExtents();
      updateAnalysisLegendVisibleSubtree();
      renderTreemapAnalysisLegend();
      if (state.mainViewMode === "treemap") {
        paintTreemap();
      } else {
        state.areas = [];
      }

      buildBreadcrumbs(state.currentRoot);
      updateStatus();
      renderTreePanel();
      renderMatchPanel();
      if (deps.chartController) {
        deps.chartController.render();
      }
      applyHoverCardPosition();
      homeBtn.disabled = state.currentRoot === state.homeRoot;
      upBtn.disabled = visibleParent(state.currentRoot) === null;
      scheduleUiAnnotations();
    }

    // Pan and hover do not change content. Wheel zoom changes pixel-sized layout
    // margins and depth cutoffs, so geometry is rebuilt once at the latest zoom.
    function requestInteractionPaint() {
      if (interactionFrame !== null || state.mainViewMode !== "treemap") {
        return;
      }
      interactionFrame = window.requestAnimationFrame(() => {
        interactionFrame = null;
        if (state.mainViewMode !== "treemap") {
          return;
        }
        paintTreemap();
        if (zoomStatusDirty) {
          zoomStatusDirty = false;
          updateStatus();
        }
        applyHoverCardPosition();
      });
    }

    // Hit testing also calls this before the next animation frame. Keep projected
    // areas current without forcing a canvas paint or rebuilding unchanged layout.
    function updateAreaGeometry(width = canvas.clientWidth, height = canvas.clientHeight) {
      if (state.mainViewMode !== "treemap") {
        return;
      }
      if (!worldAreas || layoutWidth !== width || layoutHeight !== height || layoutZoom !== state.zoom) {
        worldAreas = createAreas(state.currentRoot, width * state.zoom, height * state.zoom);
        layoutWidth = width;
        layoutHeight = height;
        layoutZoom = state.zoom;
        projectedViewX = NaN;
        projectedViewY = NaN;
      }
      if (projectedViewX === state.viewX && projectedViewY === state.viewY) {
        return;
      }
      projectedViewX = state.viewX;
      projectedViewY = state.viewY;
      const visibleAreas: TreemapArea[] = [];
      for (const area of worldAreas) {
        const rect = {
          x: area.rect.x - state.viewX,
          y: area.rect.y - state.viewY,
          w: area.rect.w,
          h: area.rect.h
        };
        if (area.level === 0 || rectIntersectsViewport(rect, width, height)) {
          visibleAreas.push({ nodeId: area.nodeId, kind: area.kind, level: area.level, rect });
        }
      }
      state.areas = visibleAreas;
    }

    function paintTreemap() {
      resizeCanvas();
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      updateAreaGeometry(width, height);
      const selectedHiddenMarkerIds = hiddenSelectedMarkerIds(worldAreas!);

      ctx.clearRect(0, 0, width, height);
      const rootCoverageColor = coverageColor(state.coverage, state.currentRoot);
      ctx.fillStyle = rootCoverageColor
        ? mixHexColors(currentThemeVisuals().canvasBase, rootCoverageColor, currentThemeVisuals().dark ? 0.45 : 0.3)
        : state.layoutMode === "accurate" ? currentThemeVisuals().canvasAccurate : currentThemeVisuals().canvasClassic;
      ctx.fillRect(0, 0, width, height);

      for (const area of state.areas) {
        if (area.level === 0) continue;
        const { x, y, w, h } = visibleAreaRect(area);
        if (w <= 0 || h <= 0) continue;
        const analysisHighlightState = analysisNodeHighlightState(area.nodeId);
        const fillCoverage = area.kind === "node" ? coverageColor(state.coverage, area.nodeId) : null;
        ctx.fillStyle = fillCoverage
          ? mixHexColors(currentThemeVisuals().canvasBase, fillCoverage, currentThemeVisuals().dark ? 0.6 : 0.42)
          : area.kind === "self" ? selfAreaColor(area.level) : nodeColor(area.level);
        ctx.fillRect(x, y, w, h);
        if (analysisActive() && area.kind === "node" && getNode(area.nodeId).children.length > 0) {
          const contentRect = visibleNodeContentRect(area, { x, y, w, h });
          if (contentRect.w > 0 && contentRect.h > 0) {
            ctx.fillStyle = analysisContentFillColor(area.nodeId);
            ctx.fillRect(contentRect.x, contentRect.y, contentRect.w, contentRect.h);
            ctx.lineWidth = 1;
            ctx.strokeStyle = analysisContentStrokeColor(area.nodeId);
            ctx.strokeRect(
              contentRect.x + 0.5,
              contentRect.y + 0.5,
              Math.max(0, contentRect.w - 1),
              Math.max(0, contentRect.h - 1)
            );
          }
        }
        if (area.kind === "self" && !analysisActive()) {
          ctx.fillStyle = hexToRgba(currentThemeVisuals().panel, currentThemeVisuals().dark ? 0.06 : 0.09);
          ctx.fillRect(x, y, w, 1.2);
        }
        if (analysisActive() && area.kind === "node" && analysisHighlightState !== "none") {
          const stripHeight = Math.min(h - 1, analysisHeaderStripHeight(h));
          if (stripHeight > 0) {
            ctx.fillStyle = analysisHighlightState === "local"
              ? analysisLocalShellFill(area.nodeId)
              : analysisDescendantShellFill();
            ctx.fillRect(x, y, w, stripHeight);
          }
          const railWidth = analysisHighlightState === "local"
            ? clampValue(w * 0.03, 3, 6)
            : clampValue(w * 0.018, 2, 4);
          if (railWidth > 0) {
            ctx.fillStyle = analysisHighlightState === "local"
              ? analysisLocalShellStroke(area.nodeId)
              : analysisDescendantShellStroke();
            ctx.fillRect(x, y, railWidth, h);
          }
          if (analysisHighlightState === "local" && w >= 96 && h >= 42) {
            const badgeText = analysisValueText(area.nodeId);
            ctx.font = "600 11px system-ui, sans-serif";
            const badgeWidth = clampValue(ctx.measureText(badgeText).width + 18, 42, Math.max(42, w - 20));
            const badgeHeight = 18;
            const badgeX = x + w - badgeWidth - 8;
            const badgeY = y + Math.max(4, (stripHeight - badgeHeight) / 2);
            ctx.fillStyle = analysisBadgeFill(area.nodeId);
            fillRoundedBadge(badgeX, badgeY, badgeWidth, badgeHeight, 9);
            ctx.fillStyle = analysisBadgeTextColor(area.nodeId);
            ctx.fillText(badgeText, badgeX + 9, badgeY + 12.5);
          } else if (analysisHighlightState === "descendant" && w >= 28 && h >= 18) {
            const dotX = x + w - 10;
            const dotY = y + Math.max(6, stripHeight / 2);
            ctx.fillStyle = analysisDescendantShellStroke();
            ctx.beginPath();
            ctx.arc(dotX, dotY, 4, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = "rgba(255, 248, 240, 0.92)";
            ctx.strokeStyle = hexToRgba(currentThemeVisuals().panel, currentThemeVisuals().dark ? 0.86 : 0.92);
            ctx.lineWidth = 1.2;
            ctx.stroke();
          }
        }
        if (shouldDim(area.nodeId)) {
          ctx.fillStyle = state.layoutMode === "accurate"
            ? hexToRgba(currentThemeVisuals().panel, currentThemeVisuals().dark ? 0.22 : 0.74)
            : hexToRgba(currentThemeVisuals().panel, currentThemeVisuals().dark ? 0.28 : 0.88);
          ctx.fillRect(x, y, w, h);
        }
      }

      for (const area of state.areas) {
        if (area.level === 0) continue;
        const { x, y, w, h } = visibleAreaRect(area);
        if (w <= 0 || h <= 0) continue;
        ctx.setLineDash(area.kind === "self" && !isHoveredArea(area) && state.layoutMode !== "accurate" ? [5, 4] : []);
        const analysisHighlightState = analysisNodeHighlightState(area.nodeId);
        ctx.lineWidth = isHoveredArea(area)
          ? 3.2
          : analysisActive() && area.kind === "node" && analysisHighlightState === "local"
            ? 2.8
            : analysisActive() && area.kind === "node" && analysisHighlightState === "descendant"
              ? 2
              : area.kind === "self"
                ? (state.layoutMode === "accurate" ? 1.2 : 2)
                : 1;
        ctx.strokeStyle = isHoveredArea(area)
          ? mixHexColors(currentThemeVisuals().text, currentThemeVisuals().match, currentThemeVisuals().dark ? 0.18 : 0.10)
          : analysisActive() && area.kind === "node" && analysisHighlightState === "local"
            ? analysisLocalShellStroke(area.nodeId)
            : analysisActive() && area.kind === "node" && analysisHighlightState === "descendant"
              ? analysisDescendantShellStroke()
              : area.kind === "self"
                ? selfAreaStroke(area.level)
                : nodeStroke(area.level);
        ctx.strokeRect(x + 0.5, y + 0.5, Math.max(0, w - 1), Math.max(0, h - 1));
        ctx.setLineDash([]);

        let cornerIndicatorSlot = 0;
        if (isMatch(area.nodeId)) {
          ctx.fillStyle = state.layoutMode === "accurate"
            ? hexToRgba(currentThemeVisuals().match, currentThemeVisuals().dark ? 0.18 : 0.20)
            : hexToRgba(currentThemeVisuals().match, currentThemeVisuals().dark ? 0.28 : 0.34);
          ctx.fillRect(x, y, w, h);
          ctx.lineWidth = 3;
          ctx.strokeStyle = currentThemeVisuals().match;
          ctx.strokeRect(x + 1, y + 1, Math.max(0, w - 2), Math.max(0, h - 2));
        } else if (hasMatchedDescendant(area.nodeId)) {
          drawTreemapCornerIndicator(
            area,
            cornerIndicatorSlot,
            currentThemeVisuals().match,
            hexToRgba(currentThemeVisuals().panel, currentThemeVisuals().dark ? 0.88 : 0.95),
            4.5
          );
          cornerIndicatorSlot += 1;
        }

        if (selectedHiddenMarkerIds.has(area.nodeId) && !isSelectedArea(area)) {
          const selectedNode = getNode(state.selectedId!);
          const selectedMarkerFill = mixHexColors(
            themeNodeAccent(selectedNode.depth),
            currentThemeVisuals().text,
            currentThemeVisuals().dark ? 0.18 : 0.08
          );
          drawTreemapCornerIndicator(
            area,
            cornerIndicatorSlot,
            hexToRgba(selectedMarkerFill, currentThemeVisuals().dark ? 0.98 : 0.94),
            hexToRgba(currentThemeVisuals().panel, currentThemeVisuals().dark ? 0.92 : 0.97),
            5
          );
        }

        if (isSelectedArea(area)) {
          const selectStroke = mixHexColors(
            themeNodeAccent(area.level),
            currentThemeVisuals().text,
            currentThemeVisuals().dark ? 0.26 : 0.12
          );
          ctx.lineWidth = 1.6;
          ctx.strokeStyle = hexToRgba(selectStroke, currentThemeVisuals().dark ? 0.96 : 0.88);
          ctx.strokeRect(x + 3, y + 3, Math.max(0, w - 6), Math.max(0, h - 6));
        }
      }

      for (const area of state.areas) {
        if (area.level === 0) continue;
        drawLabels(area);
      }

      for (const area of state.areas) {
        if (area.level === 0) continue;
        drawTreemapCollapseToggle(area);
      }

      for (const area of state.areas) {
        if (area.level === 0) continue;
        drawLeafBadge(area);
      }
    }

    function hitTestArea(clientX: number, clientY: number) {
      if (state.mainViewMode !== "treemap") return null;
      updateAreaGeometry();
      const rect = canvas.getBoundingClientRect();
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      for (let index = state.areas.length - 1; index >= 0; index -= 1) {
        const area = state.areas[index];
        if (area.level === 0) continue;
        const r = area.rect;
        if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
          return area;
        }
      }
      return null;
    }

    function hitTestTreemapCollapseToggle(clientX: number, clientY: number) {
      if (state.mainViewMode !== "treemap") return null;
      updateAreaGeometry();
      const rect = canvas.getBoundingClientRect();
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      for (let index = state.areas.length - 1; index >= 0; index -= 1) {
        const area = state.areas[index];
        if (area.level === 0) continue;
        const toggleRect = treemapCollapseToggleRect(area);
        if (!toggleRect) {
          continue;
        }
        if (
          x >= toggleRect.x &&
          x <= toggleRect.x + toggleRect.w &&
          y >= toggleRect.y &&
          y <= toggleRect.y + toggleRect.h
        ) {
          return area;
        }
      }
      return null;
    }

    function isHoverCardVisible() {
      return !hoverCard.classList.contains("hidden");
    }

    function isPointInsideElement(element: HTMLElement | null, clientX: number, clientY: number) {
      if (!element || !(Number.isFinite as (value: unknown) => value is number)(clientX) || !(Number.isFinite as (value: unknown) => value is number)(clientY)) {
        return false;
      }
      const rect = element.getBoundingClientRect();
      return (
        clientX >= rect.left &&
        clientX <= rect.right &&
        clientY >= rect.top &&
        clientY <= rect.bottom
      );
    }

    function currentHoverArea() {
      if (state.hoverId === null || state.hoverId === undefined) {
        return null;
      }
      for (let index = state.areas.length - 1; index >= 0; index -= 1) {
        const area = state.areas[index];
        if (area.nodeId === state.hoverId && area.kind === state.hoverAreaKind) {
          return area;
        }
      }
      return null;
    }

    function pointInPolygon(points: { x: number; y: number }[], x: number, y: number) {
      let inside = false;
      for (let index = 0, previous = points.length - 1; index < points.length; previous = index, index += 1) {
        const xi = points[index].x;
        const yi = points[index].y;
        const xj = points[previous].x;
        const yj = points[previous].y;
        const intersects = ((yi > y) !== (yj > y)) &&
          (x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-9) + xi);
        if (intersects) {
          inside = !inside;
        }
      }
      return inside;
    }

    function isPointInsideHoverBridge(clientX: number, clientY: number) {
      if (!isHoverCardVisible() || sourcePanel.classList.contains("visible")) {
        return false;
      }
      const hoverArea = currentHoverArea();
      if (!hoverArea) {
        return false;
      }

      const canvasRect = canvas.getBoundingClientRect();
      const hoverRect = hoverCard.getBoundingClientRect();
      const areaRect = {
        left: canvasRect.left + hoverArea.rect.x,
        top: canvasRect.top + hoverArea.rect.y,
        right: canvasRect.left + hoverArea.rect.x + hoverArea.rect.w,
        bottom: canvasRect.top + hoverArea.rect.y + hoverArea.rect.h
      };
      const areaCenterX = (areaRect.left + areaRect.right) / 2;
      const areaCenterY = (areaRect.top + areaRect.bottom) / 2;
      const hoverCenterX = (hoverRect.left + hoverRect.right) / 2;
      const hoverCenterY = (hoverRect.top + hoverRect.bottom) / 2;
      const padding = 10;

      if (Math.abs(hoverCenterX - areaCenterX) >= Math.abs(hoverCenterY - areaCenterY)) {
        const movingRight = hoverCenterX >= areaCenterX;
        const sourceX = movingRight ? areaRect.right : areaRect.left;
        const targetX = movingRight ? hoverRect.left : hoverRect.right;
        if ((movingRight && targetX <= sourceX) || (!movingRight && targetX >= sourceX)) {
          return false;
        }
        const sourceSpan = Math.max(30, Math.min(areaRect.bottom - areaRect.top + 12, 84));
        const targetSpan = Math.max(48, Math.min(hoverRect.bottom - hoverRect.top - 14, 156));
        const sourceCenterY = clampValue(
          hoverCenterY,
          areaRect.top + sourceSpan / 2,
          areaRect.bottom - sourceSpan / 2
        );
        const targetCenterY = clampValue(
          areaCenterY,
          hoverRect.top + targetSpan / 2,
          hoverRect.bottom - targetSpan / 2
        );
        const polygon = [
          { x: sourceX, y: sourceCenterY - sourceSpan / 2 - padding },
          { x: sourceX, y: sourceCenterY + sourceSpan / 2 + padding },
          { x: targetX, y: targetCenterY + targetSpan / 2 + padding },
          { x: targetX, y: targetCenterY - targetSpan / 2 - padding }
        ];
        return pointInPolygon(polygon, clientX, clientY);
      }

      const movingDown = hoverCenterY >= areaCenterY;
      const sourceY = movingDown ? areaRect.bottom : areaRect.top;
      const targetY = movingDown ? hoverRect.top : hoverRect.bottom;
      if ((movingDown && targetY <= sourceY) || (!movingDown && targetY >= sourceY)) {
        return false;
      }
      const sourceSpan = Math.max(30, Math.min(areaRect.right - areaRect.left + 12, 120));
      const targetSpan = Math.max(56, Math.min(hoverRect.right - hoverRect.left - 18, 180));
      const sourceCenterX = clampValue(
        hoverCenterX,
        areaRect.left + sourceSpan / 2,
        areaRect.right - sourceSpan / 2
      );
      const targetCenterX = clampValue(
        areaCenterX,
        hoverRect.left + targetSpan / 2,
        hoverRect.right - targetSpan / 2
      );
      const polygon = [
        { x: sourceCenterX - sourceSpan / 2 - padding, y: sourceY },
        { x: sourceCenterX + sourceSpan / 2 + padding, y: sourceY },
        { x: targetCenterX + targetSpan / 2 + padding, y: targetY },
        { x: targetCenterX - targetSpan / 2 - padding, y: targetY }
      ];
      return pointInPolygon(polygon, clientX, clientY);
    }

    function updateHover(nodeId: number | null, areaKind: AreaKind = "node", options: { force?: boolean } = {}) {
      const force = !!options.force;
      cancelScheduledHoverUpdate();
      if (
        !force &&
        hasLockedSelection() &&
        (nodeId !== state.selectedId || areaKind !== state.selectedAreaKind)
      ) {
        return;
      }
      state.hoverId = nodeId;
      state.hoverAreaKind = areaKind;
      requestInteractionPaint();
      if (nodeId === null || nodeId === undefined) {
        state.hoverCardActive = false;
        hoverActions.classList.add("hidden");
        applyHoverCardLockState();
        if (!sourcePanel.classList.contains("visible")) {
          hoverCard.classList.add("hidden");
          clearUiAnnotationHoverTargetWithin(hoverCard);
        }
        return;
      }

      const node = getNode(nodeId);
      hoverPath.textContent = areaKind === "self"
        ? `${node.path || "(root)"} · self`
        : (node.path || "(root)");
      hoverTitle.textContent = areaKind === "self"
        ? `${node.name} <${node.module}> · Local Self`
        : `${node.name} <${node.module}>`;
      const hoverMetaLines: string[] = [];
      if (nodeHasInstanceSource(node)) {
        hoverMetaLines.push(hoverMetaLine("Instantiation", formatLocation(node)));
      }
      if (nodeHasDefinitionSource(node)) {
        hoverMetaLines.push(hoverMetaLine("Module Source", formatSourceLocation(buildSourceTarget(node, "definition"))));
      }
      if (!hoverMetaLines.length) {
        hoverMetaLines.push(hoverMetaLine("Source", "Source location unavailable"));
      }
      if (!DATA.debugUiLabels) {
        hoverMetaLines.push(
          hoverMetaLine(
            "Signal Bits",
            areaKind === "self"
              ? `local ${formatMetricValue(node.moduleSignalBits)} (vars ${formatMetricValue(node.moduleVariableBits)}, nets ${formatMetricValue(node.moduleNetBits)})`
              : node.children.length > 0
                ? `subtree ${formatMetricValue(node.subtreeSignalBits)}, local ${formatMetricValue(node.moduleSignalBits)}`
                : `local ${formatMetricValue(node.moduleSignalBits)} (vars ${formatMetricValue(node.moduleVariableBits)}, nets ${formatMetricValue(node.moduleNetBits)})`
          )
        );
      }
      if (DATA.debugUiLabels) {
        hoverMetaLines.unshift(
          hoverMetaLine(
            "Pattern",
            analysisActive()
              ? state.analysisMode === "loc"
                ? `module loc -> local ${state.analysisLocalLocs[nodeId] || 0}, subtree ${state.analysisSubtreeLocs[nodeId] || 0}`
                : `${state.analysisPattern} -> local count ${state.analysisLocalCounts[nodeId] || 0}, local ratio ${formatMetricValue((state.analysisLocalRatios[nodeId] || 0) * 100)}%, subtree count ${state.analysisSubtreeCounts[nodeId] || 0}`
              : "disabled"
          ),
          hoverMetaLine(
            "Local",
            `signal bits ${node.moduleSignalBits} (vars ${node.moduleVariableBits}, nets ${node.moduleNetBits}), objects ${node.moduleSignalCount} (vars ${node.moduleVariableCount}, nets ${node.moduleNetCount})`
          ),
          hoverMetaLine(
            "Weighted",
            `subtree ${formatMetricValue(subtreeWeightedBits(node))} and local ${formatMetricValue(localWeightedBits(node))} with var x${formatMetricValue(state.weightedVariableWeight)}, net x${formatMetricValue(state.weightedNetWeight)}`
          ),
          hoverMetaLine(
            "Subtree",
            `instances ${node.subtreeInstances}, leaves ${node.subtreeLeaves}, signal bits ${node.subtreeSignalBits}, objects ${node.subtreeSignalCount}`
          ),
          hoverMetaLine(
            "Leaf",
            nodeIsLeaf(nodeId) ? "terminal hierarchy node" : "has child hierarchy nodes"
          ),
          hoverMetaLine(
            "Hierarchy",
            `depth ${node.depth}, ${node.children.length} direct children, decomp ${decompositionLabel()}`
          ),
        );
      }
      hoverMeta.innerHTML = hoverMetaLines.join("");
      const coverageDetails = document.getElementById("coverage-node-details");
      if (coverageDetails) {
        coverageDetails.hidden = !state.coverage;
        coverageDetails.innerHTML = coverageDetailsHtml(state.coverage, nodeId);
      }
      hoverSelectedPill.textContent = areaKind === "self" ? "Selected Self" : "Selected";
      applyHoverCardLockState();
      const hasInstanceSource = nodeHasInstanceSource(node);
      const hasDefinitionSource = nodeHasDefinitionSource(node);
      openInstanceSourceBtn.hidden = !hasInstanceSource;
      openModuleSourceBtn.hidden = !hasDefinitionSource;
      if (hasInstanceSource || hasDefinitionSource) {
        hoverActions.classList.remove("hidden");
      } else {
        hoverActions.classList.add("hidden");
      }
      if (!sourcePanel.classList.contains("visible")) {
        hoverCard.classList.remove("hidden");
        applyHoverCardPosition();
      }
    }

    function cancelScheduledHoverUpdate() {
      if (state.hoverUpdateTimer !== null) {
        window.clearTimeout(state.hoverUpdateTimer);
        state.hoverUpdateTimer = null;
      }
    }

    function scheduleHoverUpdate(area: TreemapArea | null) {
      cancelScheduledHoverUpdate();
      const nodeId = area ? area.nodeId : null;
      const areaKind = area ? area.kind : "node";
      if (state.hoverId !== nodeId || state.hoverAreaKind !== areaKind) {
        updateHover(nodeId, areaKind);
      }
    }

    function activateTreemapArea(area: TreemapArea | null) {
      if (!area) {
        return;
      }
      const nodeId = area.nodeId;
      const node = getNode(nodeId);
      if (area.kind === "self") {
        if (nodeId !== state.currentRoot) {
          setRootAndReset(nodeId);
          return;
        }
        if (nodeHasAnySource(node)) {
          renderSource(nodeId);
        }
        return;
      }
      if (node.children.length) {
        setRootAndReset(nodeId);
        return;
      }
      if (nodeHasAnySource(node)) {
        renderSource(nodeId);
      }
    }

    function bindTreemapEvents() {

      hoverCard.addEventListener("mouseenter", () => {
        if (!isHoverCardVisible()) {
          return;
        }
        cancelScheduledHoverUpdate();
        state.hoverCardActive = true;
      });

      hoverCard.addEventListener("mouseleave", (event) => {
        state.hoverCardActive = false;
        if (sourcePanel.classList.contains("visible") || hasLockedSelection()) {
          return;
        }
        const nextHoverArea = hitTestArea(event.clientX, event.clientY);
        scheduleHoverUpdate(nextHoverArea);
      });

      hoverCard.addEventListener("mousedown", (event) => {
        if (event.button !== 0) {
          return;
        }
        if ((event.target as HTMLElement).closest<HTMLElement>("button, a, input, select, textarea")) {
          return;
        }
        const rect = hoverCard.getBoundingClientRect();
        const panelRect = canvasPanel.getBoundingClientRect();
        if (state.hoverCardLeft === null || state.hoverCardLeft === undefined) {
          state.hoverCardLeft = rect.left - panelRect.left;
          state.hoverCardTop = rect.top - panelRect.top;
        }
        state.draggingHoverCard = true;
        state.hoverCardActive = true;
        state.hoverCardDragOffsetX = event.clientX - panelRect.left - state.hoverCardLeft;
        state.hoverCardDragOffsetY = event.clientY - panelRect.top - state.hoverCardTop;
        applyHoverCardPosition();
        event.preventDefault();
      });

      if (treemapAnalysisLegendHead) {
        treemapAnalysisLegendHead.addEventListener("mousedown", (event) => {
          if (event.button !== 0) {
            return;
          }
          if (treemapAnalysisLegend.classList.contains("hidden")) {
            return;
          }
          const rect = treemapAnalysisLegend.getBoundingClientRect();
          const stageRect = treemapStage.getBoundingClientRect();
          if (state.treemapAnalysisLegendLeft === null || state.treemapAnalysisLegendTop === null) {
            state.treemapAnalysisLegendLeft = rect.left - stageRect.left;
            state.treemapAnalysisLegendTop = rect.top - stageRect.top;
          }
          state.draggingTreemapAnalysisLegend = true;
          state.treemapAnalysisLegendDragOffsetX = event.clientX - stageRect.left - state.treemapAnalysisLegendLeft;
          state.treemapAnalysisLegendDragOffsetY = event.clientY - stageRect.top - state.treemapAnalysisLegendTop;
          applyTreemapAnalysisLegendPosition();
          event.preventDefault();
          event.stopPropagation();
        });
      }

      canvas.addEventListener("mousemove", (event) => {
        if (state.isDragging) {
          hideTreemapToggleTooltip();
          const dx = event.clientX - state.lastPointerX;
          const dy = event.clientY - state.lastPointerY;
          if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
            state.dragMoved = true;
          }
          state.lastPointerX = event.clientX;
          state.lastPointerY = event.clientY;
          suspendAnalysisHatch(120);
          state.viewX -= dx;
          state.viewY -= dy;
          clampView();
          requestInteractionPaint();
          return;
        }
        const toggleArea = hitTestTreemapCollapseToggle(event.clientX, event.clientY);
        const toggleChanged = setHoveredTreemapToggle(toggleArea ? toggleArea.nodeId : null);
        if (toggleArea) {
          showTreemapToggleTooltip(toggleArea.nodeId, event.clientX, event.clientY);
        } else {
          hideTreemapToggleTooltip();
        }
        canvas.style.cursor = toggleArea ? "pointer" : "default";
        if (toggleChanged) {
          requestInteractionPaint();
        }
        if (hasLockedSelection()) {
          return;
        }
        if (state.hoverCardActive || isPointInsideElement(hoverCard, event.clientX, event.clientY)) {
          return;
        }
        if (isPointInsideHoverBridge(event.clientX, event.clientY)) {
          return;
        }
        scheduleHoverUpdate(hitTestArea(event.clientX, event.clientY));
      });

      canvas.addEventListener("mouseleave", (event) => {
        const toggleChanged = setHoveredTreemapToggle(null);
        hideTreemapToggleTooltip();
        canvas.style.cursor = "default";
        if (toggleChanged) {
          requestInteractionPaint();
        }
        if (
          isHoverCardVisible() &&
          event.relatedTarget &&
          hoverCard.contains(event.relatedTarget as Node | null)
        ) {
          return;
        }
        if (hasLockedSelection()) {
          return;
        }
        if (!state.isDragging) {
          if (isPointInsideHoverBridge(event.clientX, event.clientY)) {
            return;
          }
          scheduleHoverUpdate(null);
        }
      });

      canvas.addEventListener("click", (event) => {
        if (state.isDragging || state.dragMoved) {
          state.dragMoved = false;
          return;
        }
        if (state.hoverCardActive || isPointInsideElement(hoverCard, event.clientX, event.clientY)) {
          return;
        }
        cancelScheduledHoverUpdate();
        const toggleArea = hitTestTreemapCollapseToggle(event.clientX, event.clientY);
        if (toggleArea) {
          toggleTreemapCollapsedNode(toggleArea.nodeId);
          if (!hasLockedSelection()) {
            updateHover(toggleArea.nodeId, toggleArea.kind);
          }
          return;
        }
        const area = hitTestArea(event.clientX, event.clientY);
        if (state.selectMode) {
          clearPendingSelectClick();
          if (!area) {
            clearSelectedArea();
            return;
          }
          state.selectClickTimer = window.setTimeout(() => {
            state.selectClickTimer = null;
            lockSelectedArea(area.nodeId, area.kind);
          }, 220);
          return;
        }
        if (!area) {
          updateHover(null);
          return;
        }
        activateTreemapArea(area);
      });

      canvas.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        const parentId = visibleParent(state.currentRoot);
        if (parentId !== null && parentId !== undefined) {
          setRootAndReset(parentId);
        }
      });

      canvas.addEventListener("mousedown", (event) => {
        if (event.button !== 0) return;
        if (hitTestTreemapCollapseToggle(event.clientX, event.clientY)) {
          event.preventDefault();
          return;
        }
        hideTreemapToggleTooltip();
        setHoveredTreemapToggle(null);
        state.isDragging = true;
        state.dragMoved = false;
        state.lastPointerX = event.clientX;
        state.lastPointerY = event.clientY;
        canvas.style.cursor = "grabbing";
      });

      canvas.addEventListener("wheel", (event) => {
        event.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const anchorX = event.clientX - rect.left;
        const anchorY = event.clientY - rect.top;
        changeZoom(event.deltaY < 0 ? 1.12 : 1 / 1.12, anchorX, anchorY);
      }, { passive: false });

      canvas.addEventListener("dblclick", (event) => {
        clearPendingSelectClick();
        if (state.selectMode) {
          if (state.isDragging || state.dragMoved) {
            state.dragMoved = false;
            return;
          }
          if (hitTestTreemapCollapseToggle(event.clientX, event.clientY)) {
            return;
          }
          const area = hitTestArea(event.clientX, event.clientY);
          if (!area) {
            return;
          }
          activateTreemapArea(area);
          return;
        }
        const rect = canvas.getBoundingClientRect();
        const anchorX = event.clientX - rect.left;
        const anchorY = event.clientY - rect.top;
        changeZoom(event.shiftKey ? 1 / 1.25 : 1.25, anchorX, anchorY);
      });
    }

    return {
      currentThemeVisuals,
      subtreeWeightedBits,
      themeNodeAccent,
      draw,
      selectedAnalysisLegendBuckets,
      analysisLegendLocalBucketMatches,
      applyTheme,
      applySelectModeState,
      resetLockedSelection,
      updateHover,
      cancelScheduledHoverUpdate,
      hasAnalysisLegendFilter,
      toggleAnalysisLegendFilter,
      themeAnalysisBuckets,
      analysisDescendantShellFill,
      weightForNode,
      analysisLabel,
      analysisValueForNode,
      setRootAndReset,
      isMatch,
      shouldDim,
      hasMatchedDescendant,
      isHoverCardVisible,
      changeZoom,
      resetView,
      clearAllTreemapCollapsedNodes,
      clearSelectedArea,
      bindTreemapEvents
    };
}
