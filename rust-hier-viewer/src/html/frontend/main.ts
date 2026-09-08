import {
  formatLoadingBytes,
  afterPaint,
  escapeHtml,
  clamp,
  nodeInstanceLabel,
  mixHexColors,
  formatMetricValue,
  validTheme,
  buildSubtitleText,
  hexToRgba,
  sanitizeWeight,
} from "./ui.js";
import { createPersistence } from "./persistence.js";
import type { PersistenceDependencies } from "./persistence.js";
import { createSourceReader } from "./source-reader.js";
import type { SourceReaderDependencies } from "./source-reader.js";
import { createTreemapRuntime } from "./treemap.js";
import type { createCoverageImport } from "./coverage-import.js";
import { disposeCoverage } from "./coverage-display.js";
import type { CoverageSelection } from "./coverage-types.js";

import { decodeCoreBundle, decodeAnalysisBundle } from "./binary.js";
import { createViewerState } from "./state.js";
import { createHierarchyRuntime } from "./hierarchy-core.js";
import type { HierarchyNode, ViewerData, ViewerState } from "./types.js";
import type { LegendRow } from "./main-types.js";
import type { ChartApi } from "./chart-types.js";

declare global {
  interface Window { HierarchyCoverage?: { createCoverageImport: typeof createCoverageImport } }
}

    (async () => {
    const loadingOverlay = (document.getElementById("loading-overlay") as HTMLDivElement);
    const loadingStage = (document.getElementById("loading-stage") as HTMLDivElement);
    const loadingDetail = (document.getElementById("loading-detail") as HTMLDivElement);
    const loadingBarFill = (document.getElementById("loading-bar-fill") as HTMLDivElement);
    const uiAnnotationLayer = (document.getElementById("ui-annotation-layer") as HTMLDivElement);
    let uiAnnotationFrame = 0;
    let uiAnnotationHoverTarget: HTMLElement | null = null;

    function setLoadingState(percent: number, stage: string, detail = "") {
      const clamped = Math.max(0, Math.min(100, percent));
      loadingBarFill.style.width = `${clamped}%`;
      loadingStage.textContent = stage;
      loadingDetail.textContent = detail;
    }

    function scheduleUiAnnotations() {
      if (!DATA?.debugUiLabels) {
        if (uiAnnotationLayer) {
          uiAnnotationLayer.replaceChildren();
        }
        return;
      }
      if (uiAnnotationFrame) {
        return;
      }
      uiAnnotationFrame = requestAnimationFrame(() => {
        uiAnnotationFrame = 0;
        renderUiAnnotations();
      });
    }

    function findUiNamedElement(element: unknown): HTMLElement | null {
      if (!element || !(element instanceof Element)) {
        return null;
      }
      return element.closest<HTMLElement>("[data-ui-name]");
    }

    function setUiAnnotationHoverTarget(element: unknown) {
      const next = findUiNamedElement(element);
      if (next === uiAnnotationHoverTarget) {
        return;
      }
      uiAnnotationHoverTarget = next;
      scheduleUiAnnotations();
    }

    function clearUiAnnotationHoverTargetWithin(container: Element | null) {
      if (!container || !uiAnnotationHoverTarget) {
        return;
      }
      if (uiAnnotationHoverTarget === container || container.contains(uiAnnotationHoverTarget)) {
        uiAnnotationHoverTarget = null;
        scheduleUiAnnotations();
      }
    }

    function shouldRenderUiAnnotation(element: HTMLElement | null): element is HTMLElement {
      if (!element || !element.isConnected) {
        return false;
      }
      const style = window.getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
        return false;
      }
      const rect = element.getBoundingClientRect();
      return rect.width >= 18 && rect.height >= 14;
    }

    function appendUiAnnotationTag(fragment: DocumentFragment, element: HTMLElement | null, hovered = false) {
      if (!shouldRenderUiAnnotation(element)) {
        return;
      }
      const rect = element.getBoundingClientRect();
      if (rect.right < 0 || rect.bottom < 0 || rect.left > window.innerWidth || rect.top > window.innerHeight) {
        return;
      }
      const tag = document.createElement("div");
      tag.className = hovered ? "ui-annotation-tag hovered" : "ui-annotation-tag";
      tag.textContent = `<${element.dataset.uiName}>`;
      tag.style.left = `${Math.min(window.innerWidth - 6, rect.right - 4)}px`;
      tag.style.top = `${Math.min(window.innerHeight - 6, rect.bottom - 4)}px`;
      fragment.appendChild(tag);
    }

    function renderUiAnnotations() {
      if (!uiAnnotationLayer || !DATA?.debugUiLabels) {
        if (uiAnnotationLayer) {
          uiAnnotationLayer.replaceChildren();
        }
        return;
      }
      const fragment = document.createDocumentFragment();
      const elements = document.querySelectorAll<HTMLElement>('[data-ui-name][data-ui-label="always"]');
      for (const element of elements) {
        appendUiAnnotationTag(fragment, element, false);
      }
      if (uiAnnotationHoverTarget && !uiAnnotationHoverTarget.matches('[data-ui-label="always"]')) {
        appendUiAnnotationTag(fragment, uiAnnotationHoverTarget, true);
      }
      const focusedElement = findUiNamedElement(document.activeElement);
      if (
        focusedElement &&
        focusedElement !== uiAnnotationHoverTarget &&
        !focusedElement.matches('[data-ui-label="always"]')
      ) {
        appendUiAnnotationTag(fragment, focusedElement, true);
      }
      uiAnnotationLayer.replaceChildren(fragment);
    }

    const VIEWER_META_URL = "./viewer-meta.json";

    async function fetchBinaryFile(url: string, startPercent: number, endPercent: number, stageTitle: string, waitingMessage: string) {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} while loading ${url}`);
      }
      const totalBytes = Number(response.headers.get("content-length")) || 0;
      let fetchedBytes = 0;

      if (response.body && typeof response.body.getReader === "function") {
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let preallocated = totalBytes > 0 ? new Uint8Array(totalBytes) : null;
        setLoadingState(
          totalBytes > 0 ? startPercent : Math.min(endPercent, startPercent + 6),
          stageTitle,
          totalBytes > 0 ? `0 / ${formatLoadingBytes(totalBytes)}` : waitingMessage
        );
        await afterPaint();
        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }
          fetchedBytes += value.byteLength;
          if (preallocated) {
            preallocated.set(value, fetchedBytes - value.byteLength);
          } else {
            chunks.push(value);
          }
          const progress = totalBytes > 0
            ? startPercent + (fetchedBytes / totalBytes) * (endPercent - startPercent)
            : Math.min(endPercent, startPercent + chunks.length * 2.2);
          setLoadingState(
            progress,
            stageTitle,
            totalBytes > 0
              ? `${formatLoadingBytes(fetchedBytes)} / ${formatLoadingBytes(totalBytes)}`
              : `${formatLoadingBytes(fetchedBytes)} received`
          );
        }

        let bytes: Uint8Array<ArrayBuffer>;
        if (preallocated) {
          bytes = fetchedBytes === preallocated.length ? preallocated : preallocated.slice(0, fetchedBytes);
        } else {
          bytes = new Uint8Array(fetchedBytes);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
          }
        }
        return { buffer: bytes.buffer, fetchedBytes: bytes.byteLength };
      }

      setLoadingState(startPercent, stageTitle, "Streaming progress is unavailable in this browser.");
      await afterPaint();
      const buffer = await response.arrayBuffer();
      return { buffer, fetchedBytes: buffer.byteLength };
    }

    let DATA: ViewerData;
    try {
      setLoadingState(4, "Opening bundle...", "Loading viewer-meta.json.");
      await afterPaint();
      const metaResponse = await fetch(VIEWER_META_URL, { cache: "no-store" });
      if (!metaResponse.ok) {
        throw new Error(`HTTP ${metaResponse.status} while loading viewer-meta.json`);
      }
      const meta: Record<string, unknown> = await metaResponse.json();
      const coreFile = typeof meta.coreFile === "string" ? meta.coreFile : "viewer-core.bin";

      setLoadingState(10, "Opening bundle...", `Preparing ${coreFile} request.`);
      await afterPaint();
      const { buffer, fetchedBytes } = await fetchBinaryFile(
        `./${coreFile}`,
        12,
        82,
        "Downloading hierarchy data...",
        `Receiving ${coreFile}...`
      );
      setLoadingState(86, "Decoding hierarchy data...", `${formatLoadingBytes(fetchedBytes)} fetched`);
      await afterPaint();
      DATA = decodeCoreBundle(buffer, meta);
      setLoadingState(91, "Preparing viewer...", `${(DATA.nodes || []).length} hierarchy nodes loaded`);
      await afterPaint();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      document.body.innerHTML = `<div style="padding: 32px; font: 16px/1.5 system-ui, sans-serif; color: #26180e;"><h1 style="margin-top: 0;">Failed to load viewer data</h1><p>Open this bundle through a static server such as VSCode Live Server, and make sure <code>viewer-meta.json</code> and <code>viewer-core.bin</code> are next to <code>index.html</code>.</p><p><strong>Detail:</strong> ${escapeHtml(message)}</p></div>`;
      return;
    }
    const nodes = DATA.nodes;
    const app = document.querySelector<HTMLElement>(".app")!;
    const canvas = (document.getElementById("treemap") as HTMLCanvasElement);
    const canvasPanel = canvas.closest<HTMLElement>(".canvas-panel")!;
    const treemapStage = (document.getElementById("treemap-stage") as HTMLDivElement);
    const treemapAnalysisLegend = (document.getElementById("treemap-analysis-legend") as HTMLDivElement);
    const treemapAnalysisLegendTitle = (document.getElementById("treemap-analysis-legend-title") as HTMLDivElement);
    const treemapAnalysisLegendSubtitle = (document.getElementById("treemap-analysis-legend-subtitle") as HTMLDivElement);
    const treemapAnalysisLegendList = (document.getElementById("treemap-analysis-legend-list") as HTMLDivElement);
    const treemapAnalysisLegendHead = treemapAnalysisLegend
      ? treemapAnalysisLegend.querySelector<HTMLElement>(".treemap-analysis-legend-head")
      : null;
    const chartPanel = (document.getElementById("chart-panel") as HTMLElement);
    const viewTreemapBtn = (document.getElementById("view-treemap-btn") as HTMLButtonElement);
    const viewPieBtn = (document.getElementById("view-pie-btn") as HTMLButtonElement);
    const viewThreeBtn = (document.getElementById("view-three-btn") as HTMLButtonElement);
    const zenToggleBtn = (document.getElementById("zen-toggle-btn") as HTMLButtonElement);
    const zenOverlayShell = (document.getElementById("zen-overlay-shell") as HTMLDivElement);
    const zenViewTreemapBtn = (document.getElementById("zen-view-treemap-btn") as HTMLButtonElement);
    const zenViewPieBtn = (document.getElementById("zen-view-pie-btn") as HTMLButtonElement);
    const zenViewThreeBtn = (document.getElementById("zen-view-three-btn") as HTMLButtonElement);
    const zenExitBtn = (document.getElementById("zen-exit-btn") as HTMLButtonElement);
    const hoverCard = (document.getElementById("hover-card") as HTMLDivElement);
    const hoverTopbar = (document.getElementById("hover-topbar") as HTMLDivElement);
    const hoverSelectedPill = (document.getElementById("hover-selected-pill") as HTMLDivElement);
    const hoverDismissBtn = (document.getElementById("hover-dismiss-btn") as HTMLButtonElement);
    const hoverPath = (document.getElementById("hover-path") as HTMLDivElement);
    const hoverTitle = (document.getElementById("hover-title") as HTMLDivElement);
    const hoverMeta = (document.getElementById("hover-meta") as HTMLDivElement);
    const hoverActions = (document.getElementById("hover-actions") as HTMLDivElement);
    const treemapToggleTooltip = (document.getElementById("treemap-toggle-tooltip") as HTMLDivElement);
    const treemapToggleTooltipInstance = (document.getElementById("treemap-toggle-tooltip-instance") as HTMLElement);
    const treemapToggleTooltipModule = (document.getElementById("treemap-toggle-tooltip-module") as HTMLElement);
    const openInstanceSourceBtn = (document.getElementById("open-instance-source-btn") as HTMLButtonElement);
    const openModuleSourceBtn = (document.getElementById("open-module-source-btn") as HTMLButtonElement);
    const pageTitle = (document.getElementById("page-title") as HTMLHeadingElement);
    const pageSubtitle = (document.getElementById("page-subtitle") as HTMLDivElement);
    const breadcrumbs = (document.getElementById("breadcrumbs") as HTMLElement);
    const statusLeft = (document.getElementById("status-left") as HTMLDivElement);
    const statusRight = (document.getElementById("status-right") as HTMLDivElement);
    const homeBtn = (document.getElementById("home-btn") as HTMLButtonElement);
    const upBtn = (document.getElementById("up-btn") as HTMLButtonElement);
    const zoomOutBtn = (document.getElementById("zoom-out-btn") as HTMLButtonElement);
    const zoomInBtn = (document.getElementById("zoom-in-btn") as HTMLButtonElement);
    const fitBtn = (document.getElementById("fit-btn") as HTMLButtonElement);
    const clearTreemapCollapsesBtn = (document.getElementById("clear-treemap-collapses-btn") as HTMLButtonElement);
    const selectModeBtn = (document.getElementById("select-mode-btn") as HTMLButtonElement);
    const toggleTreeBtn = (document.getElementById("toggle-tree-btn") as HTMLButtonElement);
    const toggleMatchBtn = (document.getElementById("toggle-match-btn") as HTMLButtonElement);
    const advancedControlsBtn = (document.getElementById("advanced-controls-btn") as HTMLButtonElement);
    const advancedPopover = (document.getElementById("advanced-popover") as HTMLDivElement);
    const advancedPopoverHeader = (document.getElementById("advanced-popover-header") as HTMLDivElement);
    const filterScopeSelect = (document.getElementById("filter-scope-select") as HTMLSelectElement);
    const filterModeSelect = (document.getElementById("filter-mode-select") as HTMLSelectElement);
    const depthSelect = (document.getElementById("depth-select") as HTMLSelectElement);
    const metricSelect = (document.getElementById("metric-select") as HTMLSelectElement);
    const weightedMetricGroup = (document.getElementById("weighted-metric-group") as HTMLDivElement);
    const weightedVariableInput = (document.getElementById("weighted-variable-input") as HTMLInputElement);
    const weightedNetInput = (document.getElementById("weighted-net-input") as HTMLInputElement);
    const themeSelect = (document.getElementById("theme-select") as HTMLSelectElement);
    const layoutSelect = (document.getElementById("layout-select") as HTMLSelectElement);
    const decompositionSelect = (document.getElementById("decomposition-select") as HTMLSelectElement);
    const analysisSelect = (document.getElementById("analysis-select") as HTMLSelectElement);
    const analysisPatternGroup = (document.getElementById("analysis-pattern-group") as HTMLDivElement);
    const analysisPatternModeSelect = (document.getElementById("analysis-pattern-mode-select") as HTMLSelectElement);
    const analysisPatternInput = (document.getElementById("analysis-pattern-input") as HTMLInputElement);
    const analysisPatternModeField = analysisPatternModeSelect ? analysisPatternModeSelect.closest<HTMLElement>(".metric-group") : null;
    const analysisPatternInputField = analysisPatternInput ? analysisPatternInput.closest<HTMLElement>(".metric-group") : null;
    const metricTooltipItems = Array.from(document.querySelectorAll<HTMLElement>(".metric-tooltip-item"));
    const searchInput = (document.getElementById("search-input") as HTMLInputElement);
    const treePanel = (document.getElementById("tree-panel") as HTMLElement);
    const treePanelSubtitle = (document.getElementById("tree-panel-subtitle") as HTMLDivElement);
    const treePanelBody = (document.getElementById("tree-panel-body") as HTMLDivElement);
    const expandTreeBtn = (document.getElementById("expand-tree-btn") as HTMLButtonElement);
    const collapseTreeBtn = (document.getElementById("collapse-tree-btn") as HTMLButtonElement);
    const closeTreeBtn = (document.getElementById("close-tree-btn") as HTMLButtonElement);
    const treePanelResizer = (document.getElementById("tree-panel-resizer") as HTMLDivElement);
    const matchPanel = (document.getElementById("match-panel") as HTMLElement);
    const matchPanelSubtitle = (document.getElementById("match-panel-subtitle") as HTMLDivElement);
    const matchPanelBody = (document.getElementById("match-panel-body") as HTMLDivElement);
    const copyMatchesBtn = (document.getElementById("copy-matches-btn") as HTMLButtonElement);
    const closeMatchBtn = (document.getElementById("close-match-btn") as HTMLButtonElement);
    const matchPanelResizerX = (document.getElementById("match-panel-resizer-x") as HTMLDivElement);
    const matchPanelResizerY = (document.getElementById("match-panel-resizer-y") as HTMLDivElement);
    const matchPanelResizerCorner = (document.getElementById("match-panel-resizer-corner") as HTMLDivElement);
    const toolbar = (document.getElementById("toolbar") as HTMLElement);
    const toggleToolbarBtn = (document.getElementById("toggle-toolbar-btn") as HTMLButtonElement);
    const ctx = canvas.getContext("2d")!;
    const ADVANCED_POPOVER_MIN_VISIBLE_WIDTH = 160;
    const ADVANCED_POPOVER_MIN_VISIBLE_HEADER = 72;
    const state = createViewerState(DATA);
    let activeCoverage: CoverageSelection | null = null;
    let coverageImport: ReturnType<typeof createCoverageImport> | null = null;
    let coverageLoadError = "";
    const {
      getNode,
      getAnalysisDefinitionMap,
      subtreeDepth,
      visibleParent,
      wildcardToRegExp,
      splitSearchTerms,
      buildSignalMatcher,
      moduleLocalLoc,
      computeAnalysisSubtree,
      ensureAnalysisDefinitionsRequested,
      buildSignalAnalysis,
      analysisActive,
      analysisLocalValue,
      analysisNodeQualified,
      updateAnalysisVisibleExtents,
      updateAnalysisLegendVisibleSubtree,
      filterTargetText,
      buildMatcher,
      buildMatches,
      forEachVisibleTreeNode
    } = createHierarchyRuntime(nodes, state, {
      analysisDefinitions: Array.isArray(DATA.analysisDefinitions) ? DATA.analysisDefinitions : null,
      analysisFile: DATA.analysisFile,
      loadAnalysisDefinitions,
      draw: (): void => draw(),
      selectedAnalysisLegendBuckets: (): number[] => selectedAnalysisLegendBuckets(),
      analysisLegendLocalBucketMatches: (nodeId): boolean => analysisLegendLocalBucketMatches(nodeId),
    });
    const {
      restorePersistedState,
      savePersistedState,
      registerSearchHistoryInput
    } = createPersistence({
      state,
      normalizeSourceBookmarks: (raw): ReturnType<PersistenceDependencies["normalizeSourceBookmarks"]> => normalizeSourceBookmarks(raw),
      nodes,
      expandTreePath,
    });

    const {
      normalizeSourceBookmarks,
      sourceSearchModeSelect,
      sourceSearchInput,
      sourcePanel,
      closeSourcePanel,
      nodeHasAnySource,
      renderSource,
      nodeHasInstanceSource,
      nodeHasDefinitionSource,
      formatSourceLocation,
      buildSourceTarget,
      applySourcePanelWindowState,
      scheduleSourceVirtualRender,
      updateSourceSearchStatus,
      renderSourceLines,
      applySourceSearchValue,
      moveSourceSearch,
      bindSourceEvents,
      refreshCoverage,
    } = createSourceReader({
      getCoverage: () => activeCoverage,
      state,
      getNode,
      savePersistedState,
      scheduleUiAnnotations,
      cancelScheduledHoverUpdate: (): ReturnType<SourceReaderDependencies["cancelScheduledHoverUpdate"]> => cancelScheduledHoverUpdate(),
      hoverCard,
      clearUiAnnotationHoverTargetWithin,
      updateHover: (nodeId, areaKind, options): ReturnType<SourceReaderDependencies["updateHover"]> => updateHover(nodeId, areaKind, options),
      registerSearchHistoryInput,
    });

    const {
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
    } = createTreemapRuntime({
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
      get chartController() {
        return chartController;
      },
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
      showTreemapToggleTooltip,
    });

    function applyLegacyMetricAlias() {
      if (state.metric === "signals") {
        state.metric = "weighted_signals";
        state.weightedVariableWeight = 1;
        state.weightedNetWeight = 1;
      }
    }

    async function loadAnalysisDefinitions() {
      if (!DATA.analysisFile) {
        return [];
      }
      const response = await fetch(`./${DATA.analysisFile}`, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} while loading ${DATA.analysisFile}`);
      }
      const buffer = await response.arrayBuffer();
      return decodeAnalysisBundle(buffer);
    }

    function hideTreemapToggleTooltip() {
      state.treemapToggleTooltipNodeId = null;
      if (!treemapToggleTooltip) {
        return;
      }
      treemapToggleTooltip.classList.add("hidden");
    }

    function positionTreemapToggleTooltip(clientX: number = state.treemapToggleTooltipClientX, clientY: number = state.treemapToggleTooltipClientY) {
      if (!treemapToggleTooltip || state.treemapToggleTooltipNodeId === null) {
        return;
      }
      const offsetX = 16;
      const offsetY = 20;
      const margin = 10;
      const tooltipWidth = treemapToggleTooltip.offsetWidth || 0;
      const tooltipHeight = treemapToggleTooltip.offsetHeight || 0;
      const maxLeft = Math.max(margin, window.innerWidth - tooltipWidth - margin);
      const maxTop = Math.max(margin, window.innerHeight - tooltipHeight - margin);
      const left = clamp(clientX + offsetX, margin, maxLeft);
      const top = clamp(clientY + offsetY, margin, maxTop);
      treemapToggleTooltip.style.left = `${left}px`;
      treemapToggleTooltip.style.top = `${top}px`;
    }

    function showTreemapToggleTooltip(nodeId: number, clientX: number, clientY: number) {
      if (!(Number.isInteger as (value: unknown) => value is number)(nodeId) || nodeId < 0 || nodeId >= nodes.length || !treemapToggleTooltip) {
        hideTreemapToggleTooltip();
        return;
      }
      state.treemapToggleTooltipNodeId = nodeId;
      state.treemapToggleTooltipClientX = clientX;
      state.treemapToggleTooltipClientY = clientY;
      const node = getNode(nodeId);
      treemapToggleTooltipInstance.textContent = nodeInstanceLabel(node);
      treemapToggleTooltipModule.textContent = node.module || "(unknown)";
      treemapToggleTooltip.classList.remove("hidden");
      positionTreemapToggleTooltip(clientX, clientY);
    }

    function metricLabel() {
      if (state.metric === "leaves") return "leaf count";
      if (state.metric === "signals") return "subtree signal bits";
      if (state.metric === "weighted_signals") return "weighted signal bits";
      return "subtree instances";
    }

    function decompositionLabel() {
      if (state.layoutMode !== "accurate") {
        return "n/a";
      }
      return state.decomposition === "self" ? "subtree + local self" : "subtree only";
    }

    function layoutModeLabel() {
      return state.layoutMode === "accurate" ? "accurate" : "classic";
    }

    function layoutModeDescription() {
      if (state.layoutMode === "accurate") {
        return "Use a floorplan-style weighted slicing layout that anchors dominant blocks and packs smaller ones to the side, closer to backend hierarchy viewers.";
      }
      return "Use the original binary-split treemap layout and preserve the previous visual style.";
    }

    function decompositionDescription() {
      if (state.decomposition === "self") {
        return "Reserve a dedicated edge strip for the current module's local-only contribution, while child instances stay in the main hierarchy region.";
      }
      return "Use subtree-only weights so the main hierarchy region is composed entirely of child instances.";
    }

    function metricDescription(metric: string) {
      if (metric === "leaves") {
        return "Treemap area is based on leaf-instance count under the current node.";
      }
      if (metric === "signals") {
        return "Treemap area is based on this node plus descendant modules' variable and net bit totals.";
      }
      if (metric === "weighted_signals") {
        return `Treemap area is based on subtree variable bits * ${formatMetricValue(state.weightedVariableWeight)} + subtree net bits * ${formatMetricValue(state.weightedNetWeight)}.`;
      }
      return "Treemap area is based on subtree instance count under the current node.";
    }

    function syncMetricHelp() {
      metricSelect.removeAttribute("title");
      weightedMetricGroup.classList.toggle("hidden", state.metric !== "weighted_signals");
      weightedVariableInput.value = state.weightedVariableWeight.toFixed(2);
      weightedNetInput.value = state.weightedNetWeight.toFixed(2);
      weightedVariableInput.title = "Weighted signal metric coefficient for variable-backed bits.";
      weightedNetInput.title = "Weighted signal metric coefficient for net-backed bits.";
      layoutSelect.title = layoutModeDescription();
      decompositionSelect.disabled = state.layoutMode !== "accurate";
      decompositionSelect.title = state.layoutMode === "accurate"
        ? decompositionDescription()
        : "Decomposition is only used in Accurate layout mode. Switch Layout to Accurate to enable it.";
      for (const item of metricTooltipItems) {
        item.classList.toggle("current", item.dataset.metric === state.metric);
      }
    }

    function syncAnalysisControls() {
      if (state.analysisMode !== "none" && state.coverage) {
        state.coverage.metric = "off";
        coverageImport?.disableColor();
      }
      const usesSignalPattern = state.analysisMode === "count" || state.analysisMode === "ratio";
      analysisPatternGroup.classList.toggle("hidden", state.analysisMode === "none");
      if (analysisPatternModeField) {
        analysisPatternModeField.classList.toggle("hidden", !usesSignalPattern);
      }
      if (analysisPatternInputField) {
        analysisPatternInputField.classList.toggle("hidden", !usesSignalPattern);
      }
      analysisSelect.title = state.analysisMode === "loc"
        ? "Color the hierarchy by each module definition's source LOC."
        : "Color the hierarchy by matched internal signal statistics.";
      analysisPatternModeSelect.title = "Choose wildcard, text, or regex matching for signal names.";
      analysisPatternInput.title = "Use ';' to combine multiple signal-name patterns. Example: _GEN* ; foo_*";
      analysisPatternModeSelect.disabled = !usesSignalPattern;
      analysisPatternInput.disabled = !usesSignalPattern;
    }

    function setAdvancedPopoverOpen(open: boolean) {
      state.advancedPopoverOpen = !!open;
      toolbar.classList.toggle("advanced-open", state.advancedPopoverOpen);
      advancedPopover.classList.toggle("hidden", !state.advancedPopoverOpen);
      advancedControlsBtn.classList.toggle("active", state.advancedPopoverOpen);
      advancedControlsBtn.setAttribute("aria-expanded", state.advancedPopoverOpen ? "true" : "false");
      if (!state.advancedPopoverOpen) {
        state.draggingAdvancedPopover = false;
      }
      applyAdvancedPopoverPosition();
    }

    function clampAdvancedPopoverPosition() {
      if (
        state.advancedPopoverLeft === null ||
        state.advancedPopoverLeft === undefined ||
        state.advancedPopoverTop === null ||
        state.advancedPopoverTop === undefined
      ) {
        return;
      }
      const panelWidth = advancedPopover.offsetWidth || Math.min(760, Math.max(280, window.innerWidth - 24));
      const panelHeight = advancedPopover.offsetHeight || Math.min(window.innerHeight - 24, 720);
      const minLeft = ADVANCED_POPOVER_MIN_VISIBLE_WIDTH - panelWidth;
      const maxLeft = window.innerWidth - ADVANCED_POPOVER_MIN_VISIBLE_WIDTH;
      const minTop = ADVANCED_POPOVER_MIN_VISIBLE_HEADER - panelHeight;
      const maxTop = window.innerHeight - ADVANCED_POPOVER_MIN_VISIBLE_HEADER;
      state.advancedPopoverLeft = clamp(state.advancedPopoverLeft, minLeft, maxLeft);
      state.advancedPopoverTop = clamp(state.advancedPopoverTop, minTop, maxTop);
    }

    function applyAdvancedPopoverPosition() {
      advancedPopover.classList.toggle("dragging", state.draggingAdvancedPopover);
      const floating = state.advancedPopoverLeft !== null && state.advancedPopoverTop !== null;
      advancedPopover.classList.toggle("floating", floating);
      if (!floating) {
        advancedPopover.style.left = "";
        advancedPopover.style.top = "";
        advancedPopover.style.right = "";
        scheduleUiAnnotations();
        return;
      }
      clampAdvancedPopoverPosition();
      advancedPopover.style.left = `${state.advancedPopoverLeft}px`;
      advancedPopover.style.top = `${state.advancedPopoverTop}px`;
      advancedPopover.style.right = "auto";
      scheduleUiAnnotations();
    }

    function clampTreemapAnalysisLegendPosition() {
      if (
        state.treemapAnalysisLegendLeft === null ||
        state.treemapAnalysisLegendTop === null
      ) {
        return;
      }
      const stageWidth = treemapStage.clientWidth || canvasPanel.clientWidth || window.innerWidth;
      const stageHeight = treemapStage.clientHeight || canvasPanel.clientHeight || window.innerHeight;
      const legendWidth = treemapAnalysisLegend.offsetWidth || Math.min(stageWidth - 24, 520);
      const legendHeight = treemapAnalysisLegend.offsetHeight || 52;
      const minLeft = 12;
      const minTop = 12;
      const maxLeft = Math.max(minLeft, stageWidth - legendWidth - 12);
      const maxTop = Math.max(minTop, stageHeight - legendHeight - 12);
      state.treemapAnalysisLegendLeft = clamp(state.treemapAnalysisLegendLeft, minLeft, maxLeft);
      state.treemapAnalysisLegendTop = clamp(state.treemapAnalysisLegendTop, minTop, maxTop);
    }

    function applyTreemapAnalysisLegendPosition() {
      if (!treemapAnalysisLegend) {
        return;
      }
      treemapAnalysisLegend.classList.toggle("dragging", state.draggingTreemapAnalysisLegend);
      const floating = state.treemapAnalysisLegendLeft !== null && state.treemapAnalysisLegendTop !== null;
      if (!floating) {
        treemapAnalysisLegend.style.left = "";
        treemapAnalysisLegend.style.top = "";
        scheduleUiAnnotations();
        return;
      }
      clampTreemapAnalysisLegendPosition();
      treemapAnalysisLegend.style.left = `${state.treemapAnalysisLegendLeft}px`;
      treemapAnalysisLegend.style.top = `${state.treemapAnalysisLegendTop}px`;
      scheduleUiAnnotations();
    }

    function applyToolbarCollapsedState() {
      toolbar.classList.toggle("collapsed", state.toolbarCollapsed);
      toggleToolbarBtn.setAttribute("aria-expanded", state.toolbarCollapsed ? "false" : "true");
      toggleToolbarBtn.setAttribute(
        "aria-label",
        state.toolbarCollapsed ? "Expand header controls" : "Collapse header controls"
      );
      if (state.toolbarCollapsed && state.advancedPopoverOpen) {
        setAdvancedPopoverOpen(false);
      }
    }

    function formatLocation(node: HierarchyNode) {
      if (!node.filePath) {
        return "Source location unavailable";
      }
      const line = node.line || 1;
      const column = node.column || 1;
      return `${node.filePath}:${line}:${column}`;
    }

    restorePersistedState();
    applyLegacyMetricAlias();
    state.chartPanelOpen = state.mainViewMode !== "treemap";
    if (state.mainViewMode === "pie2d" || state.mainViewMode === "three3d") {
      state.chartRenderMode = state.mainViewMode;
    }
    applyTheme();
    applyToolbarCollapsedState();
    applyZenModeState();
    pageTitle.textContent = "hier-viewer";
    pageSubtitle.textContent = buildSubtitleText(DATA.title, Number(DATA.builtAtUnixMs));
    metricSelect.value = state.metric;
    weightedVariableInput.value = state.weightedVariableWeight.toFixed(2);
    weightedNetInput.value = state.weightedNetWeight.toFixed(2);
    themeSelect.value = state.theme;
    layoutSelect.value = state.layoutMode;
    decompositionSelect.value = state.decomposition;
    analysisSelect.value = state.analysisMode;
    analysisPatternModeSelect.value = state.analysisPatternMode;
    analysisPatternInput.value = state.analysisPattern;
    filterScopeSelect.value = state.filterScope;
    filterModeSelect.value = state.filterMode;
    searchInput.value = state.search;
    sourceSearchModeSelect.value = state.sourceSearchMode;
    sourceSearchInput.value = state.sourceSearch;

    function syncLinkedAnalysisPatternInputs(value: string, source: HTMLInputElement | null = null) {
      analysisPatternInput.value = value;
      const chartInput = (document.getElementById("chart-analysis-pattern-input") as HTMLInputElement);
      if (chartInput && chartInput !== source) {
        chartInput.value = value;
      }
    }

    function applyFilterSearchValue(value: string) {
      state.search = value;
      searchInput.value = value;
      buildMatches();
      savePersistedState();
      draw();
    }

    function applyAnalysisPatternValue(value: string, source: HTMLInputElement | null = null) {
      state.analysisPattern = value;
      syncLinkedAnalysisPatternInputs(value, source);
      buildSignalAnalysis();
      syncAnalysisControls();
      savePersistedState();
      draw();
    }

    window.applySharedAnalysisPatternValue = (value: string, source: HTMLInputElement | null = null) => {
      applyAnalysisPatternValue(value, source);
    };

    function applyMainViewMode() {
      coverageImport?.setViewVisible(state.mainViewMode === "treemap");
      state.chartPanelOpen = state.mainViewMode !== "treemap";
      treemapStage.classList.toggle("active", state.mainViewMode === "treemap");
      chartPanel.classList.toggle("active", state.chartPanelOpen);
      applySelectModeState();
      viewTreemapBtn.classList.toggle("active", state.mainViewMode === "treemap");
      viewPieBtn.classList.toggle("active", state.mainViewMode === "pie2d");
      viewThreeBtn.classList.toggle("active", state.mainViewMode === "three3d");
      zenViewTreemapBtn.classList.toggle("active", state.mainViewMode === "treemap");
      zenViewPieBtn.classList.toggle("active", state.mainViewMode === "pie2d");
      zenViewThreeBtn.classList.toggle("active", state.mainViewMode === "three3d");
      viewTreemapBtn.setAttribute("aria-pressed", state.mainViewMode === "treemap" ? "true" : "false");
      viewPieBtn.setAttribute("aria-pressed", state.mainViewMode === "pie2d" ? "true" : "false");
      viewThreeBtn.setAttribute("aria-pressed", state.mainViewMode === "three3d" ? "true" : "false");
      zenViewTreemapBtn.setAttribute("aria-pressed", state.mainViewMode === "treemap" ? "true" : "false");
      zenViewPieBtn.setAttribute("aria-pressed", state.mainViewMode === "pie2d" ? "true" : "false");
      zenViewThreeBtn.setAttribute("aria-pressed", state.mainViewMode === "three3d" ? "true" : "false");
    }

    function applyZenModeState() {
      app.classList.toggle("zen-active", state.zenMode);
      document.body.classList.toggle("zen-active", state.zenMode);
      zenToggleBtn.classList.toggle("active", state.zenMode);
      zenToggleBtn.setAttribute("aria-pressed", state.zenMode ? "true" : "false");
      zenToggleBtn.textContent = state.zenMode ? "Zen On" : "Zen";
      zenExitBtn.setAttribute("aria-pressed", state.zenMode ? "true" : "false");
      if (zenOverlayShell) {
        applyZenOverlayPosition();
      }
    }

    function setZenMode(enabled: boolean) {
      const next = !!enabled;
      if (state.zenMode === next) {
        return;
      }
      if (next && state.advancedPopoverOpen) {
        setAdvancedPopoverOpen(false);
      }
      if (next && sourcePanel.classList.contains("visible")) {
        closeSourcePanel();
      }
      state.zenMode = next;
      applyZenModeState();
      requestAnimationFrame(() => draw());
    }

    function setMainViewMode(mode: string) {
      const nextMode = ["treemap", "pie2d", "three3d"].includes(mode) ? mode : "treemap";
      state.mainViewMode = nextMode as ViewerState["mainViewMode"];
      if (nextMode === "three3d" && state.coverage && state.coverage.metric !== "off") state.chartMode = "coverage";
      else if (state.chartMode === "coverage") state.chartMode = "weighted_bits";
      hideTreemapToggleTooltip();
      if (nextMode !== "treemap") {
        resetLockedSelection();
      }
      if (nextMode === "pie2d" || nextMode === "three3d") {
        state.chartRenderMode = nextMode;
        state.chartPanelDirty = true;
        updateHover(null, "node", { force: true });
      } else {
        updateHover(null, "node", { force: true });
      }
      applyMainViewMode();
      savePersistedState();
      draw();
    }

    window.registerSearchHistoryInput = registerSearchHistoryInput;

    function currentMaxDepth() {
      return subtreeDepth(state.currentRoot);
    }

    function visibleDepthLabel() {
      return state.depthLimit === null ? "max" : `${state.depthLimit}/${currentMaxDepth()}`;
    }

    function expandTreePath(nodeId: number) {
      let cursor: number | null = nodeId;
      while (cursor !== null && cursor !== undefined) {
        state.treeCollapsedIds.delete(cursor);
        if (cursor === state.homeRoot) {
          break;
        }
        cursor = visibleParent(cursor);
      }
    }

    function nodeIsVisibleDescendantOf(rootId: number, nodeId: number) {
      let cursor: number | null = nodeId;
      while (cursor !== null && cursor !== undefined) {
        if (cursor === rootId) {
          return true;
        }
        cursor = visibleParent(cursor);
      }
      return false;
    }

    function buildBreadcrumbs(nodeId: number) {
      const chain: number[] = [];
      let cursor: number | null = nodeId;
      while (cursor !== null && cursor !== undefined) {
        chain.push(cursor);
        cursor = visibleParent(cursor);
      }
      chain.reverse();
      breadcrumbs.innerHTML = "";

      chain.forEach((id, index) => {
        const node = getNode(id);
        const button = document.createElement("button");
        button.type = "button";
        button.className = "crumb" + (index === chain.length - 1 ? " current" : "");
        button.textContent = node.name || "(root)";
        button.dataset.module = `<${node.module}>`;
        if (index !== chain.length - 1) {
          button.addEventListener("click", () => {
            state.currentRoot = id;
            expandTreePath(id);
            state.treePanelDirty = true;
            draw();
          });
        } else {
          button.setAttribute("aria-current", "page");
        }
        breadcrumbs.appendChild(button);
      });
    }

    function analysisLegendTitleText() {
      if (state.analysisMode === "count") {
        return "Pattern Count";
      }
      if (state.analysisMode === "ratio") {
        return "Pattern Ratio";
      }
      if (state.analysisMode === "loc") {
        return "Module LOC";
      }
      return "Analysis";
    }

    function analysisLegendSubtitleText() {
      if (state.analysisMode === "loc") {
        return "Local module LOC, bucketed against the current visible view.";
      }
      const pattern = state.analysisPattern.trim();
      if (!pattern) {
        return "Local signal-name matches, bucketed against the current visible view.";
      }
      return `Pattern: ${pattern}`;
    }

    function appendTreemapAnalysisLegendRow({ shellFill, contentFill, label, meta, descendant = false, filterKey = "" }: LegendRow) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "treemap-analysis-legend-row";
      const isActive = hasAnalysisLegendFilter(filterKey);
      if (isActive) {
        row.classList.add("active");
      }
      row.title = meta;
      row.setAttribute("aria-pressed", isActive ? "true" : "false");
      row.addEventListener("click", () => {
        toggleAnalysisLegendFilter(filterKey);
        savePersistedState();
        draw();
      });

      const swatch = document.createElement("div");
      swatch.className = "treemap-analysis-legend-swatch";
      if (descendant) {
        swatch.classList.add("descendant");
      }
      swatch.style.background = shellFill;
      swatch.style.setProperty("--legend-content-fill", contentFill);

      const copy = document.createElement("div");
      copy.className = "treemap-analysis-legend-copy";

      const title = document.createElement("div");
      title.className = "treemap-analysis-legend-label";
      title.textContent = label;

      const detail = document.createElement("div");
      detail.className = "treemap-analysis-legend-meta";
      detail.textContent = meta;

      copy.appendChild(title);
      copy.appendChild(detail);
      row.appendChild(swatch);
      row.appendChild(copy);
      treemapAnalysisLegendList.appendChild(row);
    }

    function renderTreemapAnalysisLegend() {
      if (
        !treemapAnalysisLegend ||
        !treemapAnalysisLegendTitle ||
        !treemapAnalysisLegendSubtitle ||
        !treemapAnalysisLegendList
      ) {
        return;
      }

      if (!analysisActive()) {
        state.draggingTreemapAnalysisLegend = false;
        treemapAnalysisLegend.classList.add("hidden");
        treemapAnalysisLegendList.innerHTML = "";
        return;
      }

      const buckets = themeAnalysisBuckets();
      treemapAnalysisLegendTitle.textContent = analysisLegendTitleText();
      treemapAnalysisLegendSubtitle.textContent = analysisLegendSubtitleText();
      treemapAnalysisLegendList.innerHTML = "";

      appendTreemapAnalysisLegendRow({
        shellFill: buckets[1].shellFill,
        contentFill: buckets[1].contentFill,
        label: "Low",
        meta: "Local value is present, but near the low end of the current view.",
        filterKey: "bucket-1"
      });
      appendTreemapAnalysisLegendRow({
        shellFill: buckets[2].shellFill,
        contentFill: buckets[2].contentFill,
        label: "Medium",
        meta: "Local value is clearly visible within the current view range.",
        filterKey: "bucket-2"
      });
      appendTreemapAnalysisLegendRow({
        shellFill: buckets[3].shellFill,
        contentFill: buckets[3].contentFill,
        label: "High",
        meta: "Local value is strong compared with other visible nodes.",
        filterKey: "bucket-3"
      });
      appendTreemapAnalysisLegendRow({
        shellFill: buckets[4].shellFill,
        contentFill: buckets[4].contentFill,
        label: "Peak",
        meta: "Local value is near the current visible maximum.",
        filterKey: "bucket-4"
      });
      appendTreemapAnalysisLegendRow({
        shellFill: analysisDescendantShellFill(),
        contentFill: analysisDescendantShellFill(),
        label: "Descendant only",
        meta: "No local hit here; a qualified match exists deeper below.",
        descendant: true,
        filterKey: "descendant"
      });

      treemapAnalysisLegend.classList.remove("hidden");
      applyTreemapAnalysisLegendPosition();
    }

    function updateStatus() {
      const root = getNode(state.currentRoot);
      const metricValue = formatMetricValue(weightForNode(state.currentRoot));
      const matchText = state.search
        ? `, <strong>${state.matches.length}</strong> search matches`
        : "";
      const analysisText = analysisActive()
        ? ` · ${analysisLabel()}: <strong>${formatMetricValue(analysisValueForNode(state.currentRoot))}</strong>`
        : "";
      const selectText = state.mainViewMode === "treemap" && state.selectMode
        ? " · select <strong>on</strong>"
        : "";
      const mainViewStatus = state.mainViewMode !== "treemap" && chartController && typeof chartController.viewStatus === "function"
        ? chartController.viewStatus()
        : null;
      const zoomLabel = mainViewStatus && mainViewStatus.zoomLabel
        ? mainViewStatus.zoomLabel
        : `${state.zoom.toFixed(2)}x`;
      statusLeft.innerHTML =
        `<strong>${escapeHtml(root.path || root.name || "(root)")}</strong> · ${root.children.length} children · ` +
        `${metricLabel()}: <strong>${metricValue}</strong> · <strong>${layoutModeLabel()}</strong> · depth <strong>${visibleDepthLabel()}</strong> · ` +
        `zoom <strong>${zoomLabel}</strong>${analysisText}${selectText}${matchText}`;
      const statusError = state.searchError || state.analysisError || coverageLoadError;
      statusRight.textContent = statusError;
      statusRight.classList.toggle("error", Boolean(statusError));
      if (clearTreemapCollapsesBtn) {
        clearTreemapCollapsesBtn.disabled = state.treeCollapsedIds.size === 0;
      }
    }

    function revealNodeInMainView(nodeId: number) {
      const node = getNode(nodeId);
      if (node.children.length) {
        setRootAndReset(nodeId);
        return;
      }
      const parentId = visibleParent(nodeId);
      setRootAndReset(parentId !== null && parentId !== undefined ? parentId : nodeId);
    }

    function focusNodeInMainView(nodeId: number) {
      const node = getNode(nodeId);
      if (!node.children.length && nodeHasAnySource(node)) {
        revealNodeInMainView(nodeId);
        renderSource(nodeId);
        return;
      }
      revealNodeInMainView(nodeId);
    }

    async function copyText(text: string) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return;
      }
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "absolute";
      textarea.style.left = "-9999px";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    }

    function renderTreePanel() {
      treePanel.classList.toggle("visible", state.treePanelOpen);
      toggleTreeBtn.classList.toggle("active", state.treePanelOpen);
      treePanel.classList.toggle("resizing", state.draggingTreePanelResize);
      expandTreeBtn.disabled = !state.treePanelOpen;
      collapseTreeBtn.disabled = !state.treePanelOpen;
      applyTreePanelSize();
      if (!state.treePanelOpen) {
        return;
      }
      if (!state.treePanelDirty) {
        return;
      }

      const treeRootId = state.homeRoot;
      const root = getNode(treeRootId);
      const current = getNode(state.currentRoot);
      const maxDepth = state.depthLimit === null ? Infinity : state.depthLimit;
      const currentPathIds = new Set();
      let cursor: number | null = state.currentRoot;
      while (cursor !== null && cursor !== undefined) {
        currentPathIds.add(cursor);
        if (cursor === treeRootId) {
          break;
        }
        cursor = visibleParent(cursor);
      }
      let rowCount = 0;

      function isExpanded(nodeId: number, depth: number) {
        const node = getNode(nodeId);
        if (!node.children.length) {
          return false;
        }
        if (depth >= maxDepth && !currentPathIds.has(nodeId)) {
          return false;
        }
        return !state.treeCollapsedIds.has(nodeId);
      }

      forEachVisibleTreeNode(() => { rowCount += 1; });

      treePanelSubtitle.textContent = state.currentRoot === treeRootId
        ? `${root.path || "(root)"} · ${rowCount} rows`
        : `${root.path || "(root)"} · current ${current.path || current.name || "(root)"} · ${rowCount} rows`;
      treePanelBody.innerHTML = "";
      if (!rowCount) {
        treePanelBody.innerHTML = '<div class="side-empty">No hierarchy rows.</div>';
        return;
      }

      const fragment = document.createDocumentFragment();

      function appendRow(nodeId: number, depth: number) {
        const node = getNode(nodeId);
        const row = document.createElement("div");
        row.className = "tree-row";
        row.style.paddingLeft = `${depth * 18}px`;

        const hasChildren = node.children.length > 0;
        const childrenVisible = hasChildren && (depth < maxDepth || currentPathIds.has(nodeId));
        const isTruncated = hasChildren && depth >= maxDepth && !currentPathIds.has(nodeId);
        const isLeaf = !hasChildren;
        if (childrenVisible) {
          const toggle = document.createElement("button");
          toggle.type = "button";
          toggle.className = "tree-toggle";
          const expanded = isExpanded(nodeId, depth);
          toggle.textContent = expanded ? "▾" : "▸";
          toggle.title = expanded ? "Collapse" : "Expand";
          toggle.addEventListener("click", (event) => {
            event.stopPropagation();
            if (expanded) {
              state.treeCollapsedIds.add(nodeId);
            } else {
              state.treeCollapsedIds.delete(nodeId);
            }
            state.treePanelDirty = true;
            savePersistedState();
            renderTreePanel();
          });
          row.appendChild(toggle);
        } else {
          const indicator = document.createElement("div");
          indicator.className = isLeaf ? "tree-indicator leaf" : "tree-indicator truncated";
          indicator.setAttribute("aria-hidden", "true");
          indicator.title = isLeaf
            ? "Leaf node: no child hierarchy below this instance"
            : "More children exist below this node, hidden by the current Level limit";
          row.appendChild(indicator);
        }

        const button = document.createElement("button");
        button.type = "button";
        button.className = "tree-entry";
        if (nodeId === state.currentRoot) {
          button.classList.add("current");
        }
        if (isMatch(nodeId)) {
          button.classList.add("match");
        }
        if (shouldDim(nodeId)) {
          button.classList.add("dimmed");
        }

        const label = document.createElement("span");
        label.className = "tree-entry-label";
        label.textContent = hasChildren ? `${node.name}/` : node.name;
        button.appendChild(label);

        if (hasMatchedDescendant(nodeId)) {
          const marker = document.createElement("span");
          marker.className = "tree-marker";
          marker.title = "Contains deeper filter matches";
          button.appendChild(marker);
        }

        const module = document.createElement("span");
        module.className = "tree-entry-module";
        module.textContent = `<${node.module}>`;
        button.appendChild(module);

        button.title = node.path || node.name;
        button.addEventListener("click", () => focusNodeInMainView(nodeId));
        row.appendChild(button);
        fragment.appendChild(row);
      }

      forEachVisibleTreeNode(appendRow);
      treePanelBody.appendChild(fragment);
      state.treePanelDirty = false;
    }

    function clampTreePanelWidth() {
      const maxWidth = Math.max(260, canvasPanel.clientWidth - 48);
      state.treePanelWidth = clamp(state.treePanelWidth, 260, maxWidth);
    }

    function applyTreePanelSize() {
      clampTreePanelWidth();
      treePanel.style.width = `${state.treePanelWidth}px`;
      scheduleUiAnnotations();
    }

    function clampMatchPanelPosition() {
      const panelWidth = state.matchPanelWidth;
      const panelHeight = state.matchPanelHeight;
      const maxLeft = Math.max(12, canvasPanel.clientWidth - panelWidth - 12);
      const maxTop = Math.max(12, canvasPanel.clientHeight - panelHeight - 12);
      if (state.matchPanelLeft === null || state.matchPanelLeft === undefined) {
        state.matchPanelLeft = maxLeft;
      }
      state.matchPanelLeft = clamp(state.matchPanelLeft, 12, maxLeft);
      state.matchPanelTop = clamp(state.matchPanelTop, 12, maxTop);
    }

    function clampMatchPanelSize() {
      const maxWidth = Math.max(280, canvasPanel.clientWidth - 24);
      const maxHeight = Math.max(180, canvasPanel.clientHeight - 24);
      state.matchPanelWidth = clamp(state.matchPanelWidth, 280, maxWidth);
      state.matchPanelHeight = clamp(state.matchPanelHeight, 180, maxHeight);
    }

    function applyMatchPanelSize() {
      clampMatchPanelSize();
      matchPanel.style.width = `${state.matchPanelWidth}px`;
      matchPanel.style.height = `${state.matchPanelHeight}px`;
      matchPanel.style.maxHeight = `${Math.max(180, canvasPanel.clientHeight - 24)}px`;
      scheduleUiAnnotations();
    }

    function applyMatchPanelPosition() {
      if (!state.matchPanelOpen) {
        scheduleUiAnnotations();
        return;
      }
      applyMatchPanelSize();
      clampMatchPanelPosition();
      matchPanel.style.left = `${state.matchPanelLeft}px`;
      matchPanel.style.top = `${state.matchPanelTop}px`;
      matchPanel.style.right = "auto";
      scheduleUiAnnotations();
    }

    function clampHoverCardPosition() {
      if (state.hoverCardLeft === null || state.hoverCardLeft === undefined) {
        return;
      }
      const panelWidth = hoverCard.offsetWidth;
      const panelHeight = hoverCard.offsetHeight;
      const maxLeft = Math.max(12, canvasPanel.clientWidth - panelWidth - 12);
      const maxTop = Math.max(12, canvasPanel.clientHeight - panelHeight - 12);
      state.hoverCardLeft = clamp(state.hoverCardLeft, 12, maxLeft);
      state.hoverCardTop = clamp(state.hoverCardTop, 12, maxTop);
    }

    function applyHoverCardPosition() {
      hoverCard.classList.toggle("dragging", state.draggingHoverCard);
      if (!isHoverCardVisible()) {
        scheduleUiAnnotations();
        return;
      }
      if (state.hoverCardLeft === null || state.hoverCardLeft === undefined) {
        hoverCard.style.left = "";
        hoverCard.style.top = "18px";
        hoverCard.style.right = "18px";
        scheduleUiAnnotations();
        return;
      }
      clampHoverCardPosition();
      hoverCard.style.left = `${state.hoverCardLeft}px`;
      hoverCard.style.top = `${state.hoverCardTop}px`;
      hoverCard.style.right = "auto";
      scheduleUiAnnotations();
    }

    function clampZenOverlayPosition() {
      if (!zenOverlayShell) {
        return;
      }
      if (state.zenOverlayLeft === null || state.zenOverlayTop === null) {
        return;
      }
      const panelWidth = zenOverlayShell.offsetWidth;
      const panelHeight = zenOverlayShell.offsetHeight;
      const maxLeft = Math.max(12, canvasPanel.clientWidth - panelWidth - 12);
      const maxTop = Math.max(12, canvasPanel.clientHeight - panelHeight - 12);
      state.zenOverlayLeft = clamp(state.zenOverlayLeft, 12, maxLeft);
      state.zenOverlayTop = clamp(state.zenOverlayTop, 12, maxTop);
    }

    function applyZenOverlayPosition() {
      if (!zenOverlayShell) {
        scheduleUiAnnotations();
        return;
      }
      zenOverlayShell.classList.toggle("dragging", state.draggingZenOverlay);
      if (state.zenOverlayLeft === null || state.zenOverlayTop === null) {
        zenOverlayShell.style.left = "";
        zenOverlayShell.style.top = "";
        scheduleUiAnnotations();
        return;
      }
      clampZenOverlayPosition();
      zenOverlayShell.style.left = `${state.zenOverlayLeft}px`;
      zenOverlayShell.style.top = `${state.zenOverlayTop}px`;
      scheduleUiAnnotations();
    }

    function renderMatchPanel() {
      matchPanel.classList.toggle("visible", state.matchPanelOpen);
      matchPanel.classList.toggle("dragging", state.draggingMatchPanel);
      matchPanel.classList.toggle(
        "resizing",
        state.draggingMatchPanelResizeX || state.draggingMatchPanelResizeY
      );
      matchPanel.classList.toggle("resizing-height", state.draggingMatchPanelResizeY);
      toggleMatchBtn.classList.toggle("active", state.matchPanelOpen);
      copyMatchesBtn.disabled = state.matchLines.length === 0;
      if (!state.matchPanelOpen) {
        matchPanel.style.left = "";
        matchPanel.style.top = "";
        matchPanel.style.right = "";
        matchPanel.style.width = "";
        matchPanel.style.height = "";
        return;
      }
      if (!state.matchPanelDirty) {
        applyMatchPanelPosition();
        return;
      }

      if (state.searchError) {
        matchPanelSubtitle.textContent = state.searchError;
      } else if (!state.search.trim()) {
        matchPanelSubtitle.textContent = `Scope: ${filterScopeSelect.options[filterScopeSelect.selectedIndex].text}`;
      } else {
        matchPanelSubtitle.textContent = `${state.matches.length} matches · ${filterScopeSelect.options[filterScopeSelect.selectedIndex].text}`;
      }

      matchPanelBody.innerHTML = "";
      if (state.searchError) {
        matchPanelBody.innerHTML = `<div class="side-empty">${escapeHtml(state.searchError)}</div>`;
        return;
      }
      if (!state.search.trim()) {
        matchPanelBody.innerHTML = '<div class="side-empty">No active filter. Example: `foo ; wc:Top.u_* ; re:^Top\\\\.dbg`</div>';
        return;
      }
      if (!state.matches.length) {
        matchPanelBody.innerHTML = '<div class="side-empty">No nodes matched the current filter.</div>';
        return;
      }

      const fragment = document.createDocumentFragment();
      for (const id of state.matches) {
        const node = getNode(id);
        const button = document.createElement("button");
        button.type = "button";
        button.className = "match-item";
        const path = document.createElement("div");
        path.className = "match-path";
        path.textContent = node.path;
        const module = document.createElement("div");
        module.className = "match-module";
        module.textContent = `<${node.module}>`;
        button.appendChild(path);
        button.appendChild(module);
        button.addEventListener("click", () => focusNodeInMainView(id));
        fragment.appendChild(button);
      }
      matchPanelBody.appendChild(fragment);
      state.matchPanelDirty = false;
      applyMatchPanelPosition();
    }
    bindTreemapEvents();

    const chartController = window.initHierarchyCharts
      ? window.initHierarchyCharts({
          state,
          getNode,
          currentMaxDepth,
          visibleParent,
          setRootAndReset,
          setMainViewMode,
          updateHover,
          buildSignalAnalysis,
          syncAnalysisControls,
          subtreeWeightedBits,
          analysisActive,
          currentThemeVisuals,
          themeNodeAccent,
          mixHexColors,
          hexToRgba,
          formatMetricValue,
          focusNodeInMainView,
          savePersistedState,
          requestDraw: () => draw()
        } as ChartApi & { setMainViewMode: typeof setMainViewMode; updateHover: typeof updateHover })
      : null;

    function initializeCoverageImport(factory: typeof createCoverageImport) {
    coverageImport = factory({
      nodes, homeRoot: state.homeRoot,
      getTargetRoot: () => state.selectedId ?? state.currentRoot,
      onApply: selection => {
        coverageLoadError = "";
        disposeCoverage(activeCoverage);
        activeCoverage = selection;
        state.coverage = selection.display;
        state.chartMode = state.mainViewMode === "three3d" ? "coverage" : "weighted_bits";
        state.chartPanelDirty = true;
        state.analysisMode = "none";
        analysisSelect.value = "none";
        syncAnalysisControls();
        refreshCoverage();
        updateHover(state.hoverId, state.hoverAreaKind, { force: true });
        draw();
      },
      onClear: () => {
        coverageLoadError = "";
        disposeCoverage(activeCoverage);
        activeCoverage = null;
        delete state.coverage;
        state.chartPanelDirty = true;
        refreshCoverage();
        updateHover(state.hoverId, state.hoverAreaKind, { force: true });
        draw();
      },
      onMetricChange: metric => {
        if (!state.coverage) return;
        state.coverage.metric = metric;
        state.chartPanelDirty = true;
        if (metric !== "off") {
          state.chartMode = state.mainViewMode === "three3d" ? "coverage" : "weighted_bits";
          state.analysisMode = "none";
          analysisSelect.value = "none";
          syncAnalysisControls();
        }
        draw();
      },
    });
    }
    const importCoverageButton = document.getElementById("coverage-import-btn") as HTMLButtonElement;
    async function loadCoverageImporter() {
      importCoverageButton.disabled = true;
      try {
        if (!coverageImport) {
          await new Promise<void>((resolve, reject) => {
            const script = document.createElement("script");
            script.src = "./viewer-coverage.js";
            script.onload = () => {
              try {
                const factory = window.HierarchyCoverage?.createCoverageImport;
                if (!factory) throw new Error("Coverage importer did not initialize.");
                initializeCoverageImport(factory);
                resolve();
              } catch (error) { script.remove(); reject(error); }
            };
            script.onerror = () => { script.remove(); reject(new Error("Unable to load viewer-coverage.js.")); };
            document.head.appendChild(script);
          });
        }
        return coverageImport!;
      } finally { importCoverageButton.disabled = false; }
    }
    importCoverageButton.addEventListener("click", () => {
      void loadCoverageImporter().then(importer => importer.open()).catch(error => {
        statusRight.textContent = error instanceof Error ? error.message : String(error);
      });
    });
    window.addEventListener("pagehide", () => disposeCoverage(activeCoverage));

    homeBtn.addEventListener("click", () => {
      setRootAndReset(state.homeRoot);
    });

    upBtn.addEventListener("click", () => {
      const parentId = visibleParent(state.currentRoot);
      if (parentId !== null && parentId !== undefined) {
        setRootAndReset(parentId);
      }
    });

    zoomOutBtn.addEventListener("click", () => {
      if (state.mainViewMode !== "treemap") {
        if (chartController) {
          chartController.zoomByFactor(1 / 1.25);
        }
        return;
      }
      changeZoom(1 / 1.25, canvas.clientWidth / 2, canvas.clientHeight / 2);
    });

    zoomInBtn.addEventListener("click", () => {
      if (state.mainViewMode !== "treemap") {
        if (chartController) {
          chartController.zoomByFactor(1.25);
        }
        return;
      }
      changeZoom(1.25, canvas.clientWidth / 2, canvas.clientHeight / 2);
    });

    fitBtn.addEventListener("click", () => {
      if (state.mainViewMode !== "treemap") {
        if (chartController) {
          chartController.fitView();
        }
        return;
      }
      resetView();
      savePersistedState();
      draw();
    });

    clearTreemapCollapsesBtn.addEventListener("click", () => {
      clearAllTreemapCollapsedNodes();
    });

    toggleTreeBtn.addEventListener("click", () => {
      state.treePanelOpen = !state.treePanelOpen;
      state.treePanelDirty = true;
      savePersistedState();
      draw();
    });

    viewTreemapBtn.addEventListener("click", () => {
      setMainViewMode("treemap");
    });

    viewPieBtn.addEventListener("click", () => {
      setMainViewMode("pie2d");
    });

    viewThreeBtn.addEventListener("click", () => {
      setMainViewMode("three3d");
    });

    zenToggleBtn.addEventListener("click", () => {
      setZenMode(!state.zenMode);
    });

    zenViewTreemapBtn.addEventListener("click", () => {
      setMainViewMode("treemap");
    });

    zenViewPieBtn.addEventListener("click", () => {
      setMainViewMode("pie2d");
    });

    zenViewThreeBtn.addEventListener("click", () => {
      setMainViewMode("three3d");
    });

    zenExitBtn.addEventListener("click", () => {
      setZenMode(false);
    });

    if (zenOverlayShell) {
      zenOverlayShell.addEventListener("mousedown", (event) => {
        if (event.button !== 0) {
          return;
        }
        if ((event.target as HTMLElement).closest<HTMLElement>("button, a, input, select, textarea")) {
          return;
        }
        const panelRect = canvasPanel.getBoundingClientRect();
        const rect = zenOverlayShell.getBoundingClientRect();
        if (state.zenOverlayLeft === null || state.zenOverlayTop === null) {
          state.zenOverlayLeft = rect.left - panelRect.left;
          state.zenOverlayTop = rect.top - panelRect.top;
        }
        state.draggingZenOverlay = true;
        state.zenOverlayDragOffsetX = event.clientX - panelRect.left - state.zenOverlayLeft;
        state.zenOverlayDragOffsetY = event.clientY - panelRect.top - state.zenOverlayTop;
        applyZenOverlayPosition();
        event.preventDefault();
      });
    }

    expandTreeBtn.addEventListener("click", () => {
      forEachVisibleTreeNode((nodeId) => {
        state.treeCollapsedIds.delete(nodeId);
      });
      state.treePanelDirty = true;
      savePersistedState();
      renderTreePanel();
    });

    collapseTreeBtn.addEventListener("click", () => {
      forEachVisibleTreeNode((nodeId) => {
        if (getNode(nodeId).children.length > 0) {
          state.treeCollapsedIds.add(nodeId);
        }
      });
      state.treePanelDirty = true;
      savePersistedState();
      renderTreePanel();
    });

    toggleMatchBtn.addEventListener("click", () => {
      state.matchPanelOpen = !state.matchPanelOpen;
      state.matchPanelDirty = true;
      savePersistedState();
      draw();
    });

    closeTreeBtn.addEventListener("click", () => {
      state.treePanelOpen = false;
      savePersistedState();
      draw();
    });

    closeMatchBtn.addEventListener("click", () => {
      state.matchPanelOpen = false;
      savePersistedState();
      draw();
    });

    copyMatchesBtn.addEventListener("click", async () => {
      if (!state.matchLines.length) return;
      try {
        await copyText(state.matchLines.join("\n"));
        statusRight.textContent = `Copied ${state.matchLines.length} matches`;
        statusRight.classList.remove("error");
      } catch (error) {
        statusRight.textContent = `Copy failed: ${(error as { message?: unknown }).message || error}`;
        statusRight.classList.add("error");
      }
    });

    openInstanceSourceBtn.addEventListener("click", () => {
      if (state.hoverId === null || state.hoverId === undefined) return;
      renderSource(state.hoverId, "instance");
    });

    openModuleSourceBtn.addEventListener("click", () => {
      if (state.hoverId === null || state.hoverId === undefined) return;
      renderSource(state.hoverId, "definition");
    });

    if (hoverDismissBtn) {
      hoverDismissBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        clearSelectedArea();
      });
    }

    if (selectModeBtn) {
      selectModeBtn.addEventListener("click", () => {
        state.selectMode = !state.selectMode;
        if (!state.selectMode) {
          clearSelectedArea();
          savePersistedState();
        } else {
          applySelectModeState();
          savePersistedState();
          draw();
        }
      });
    }

    advancedControlsBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      setAdvancedPopoverOpen(!state.advancedPopoverOpen);
    });

    (document.getElementById("close-advanced-btn") as HTMLButtonElement).addEventListener("click", () => {
      setAdvancedPopoverOpen(false);
    });

    toggleToolbarBtn.addEventListener("click", () => {
      state.toolbarCollapsed = !state.toolbarCollapsed;
      applyToolbarCollapsedState();
      savePersistedState();
      draw();
    });

    advancedPopover.addEventListener("mousedown", (event) => {
      event.stopPropagation();
    });

    advancedPopoverHeader.addEventListener("mousedown", (event) => {
      if (event.button !== 0 || (event.target as HTMLElement).closest<HTMLElement>("button")) {
        return;
      }
      const rect = advancedPopover.getBoundingClientRect();
      if (state.advancedPopoverLeft === null || state.advancedPopoverTop === null) {
        state.advancedPopoverLeft = rect.left;
        state.advancedPopoverTop = rect.top;
      }
      state.draggingAdvancedPopover = true;
      state.advancedPopoverDragOffsetX = event.clientX - state.advancedPopoverLeft;
      state.advancedPopoverDragOffsetY = event.clientY - state.advancedPopoverTop;
      applyAdvancedPopoverPosition();
      event.preventDefault();
      event.stopPropagation();
    });

    document.addEventListener("mousedown", (event) => {
      if (!state.advancedPopoverOpen) {
        return;
      }
      if (advancedPopover.contains(event.target as Node | null) || advancedControlsBtn.contains(event.target as Node | null)) {
        return;
      }
      setAdvancedPopoverOpen(false);
    });
    bindSourceEvents();

    window.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") {
        return;
      }
      if (state.advancedPopoverOpen) {
        setAdvancedPopoverOpen(false);
        return;
      }
      if (sourcePanel.classList.contains("visible")) {
        if (state.sourcePanelFullscreen) {
          state.sourcePanelFullscreen = false;
          applySourcePanelWindowState();
          return;
        }
        closeSourcePanel();
        return;
      }
      if (state.zenMode) {
        setZenMode(false);
      }
    });

    depthSelect.addEventListener("change", () => {
      state.depthLimit = depthSelect.value === "max" ? null : Number(depthSelect.value);
      state.treePanelDirty = true;
      savePersistedState();
      draw();
    });

    metricSelect.addEventListener("change", () => {
      state.metric = metricSelect.value as ViewerState["metric"];
      if (state.metric === "weighted_signals") {
        state.layoutMode = "accurate";
        layoutSelect.value = state.layoutMode;
      }
      syncMetricHelp();
      savePersistedState();
      draw();
    });

    function updateWeightedMetricParameter(input: HTMLInputElement, fieldName: "weightedVariableWeight" | "weightedNetWeight", fallback: number) {
      state[fieldName] = sanitizeWeight(input.value, fallback);
      syncMetricHelp();
      savePersistedState();
      draw();
    }

    weightedVariableInput.addEventListener("input", () => {
      updateWeightedMetricParameter(
        weightedVariableInput,
        "weightedVariableWeight",
        state.weightedVariableWeight
      );
    });

    weightedNetInput.addEventListener("input", () => {
      updateWeightedMetricParameter(
        weightedNetInput,
        "weightedNetWeight",
        state.weightedNetWeight
      );
    });

    weightedVariableInput.addEventListener("blur", () => {
      weightedVariableInput.value = state.weightedVariableWeight.toFixed(2);
    });

    weightedNetInput.addEventListener("blur", () => {
      weightedNetInput.value = state.weightedNetWeight.toFixed(2);
    });

    themeSelect.addEventListener("change", () => {
      state.theme = validTheme(themeSelect.value) ? themeSelect.value : "solarized-light";
      applyTheme();
      savePersistedState();
      draw();
    });

    layoutSelect.addEventListener("change", () => {
      state.layoutMode = layoutSelect.value as ViewerState["layoutMode"];
      syncMetricHelp();
      savePersistedState();
      draw();
    });

    decompositionSelect.addEventListener("change", () => {
      state.decomposition = decompositionSelect.value as ViewerState["decomposition"];
      syncMetricHelp();
      savePersistedState();
      draw();
    });

    analysisSelect.addEventListener("change", () => {
      state.analysisMode = analysisSelect.value as ViewerState["analysisMode"];
      syncAnalysisControls();
      buildSignalAnalysis();
      savePersistedState();
      draw();
    });

    analysisPatternModeSelect.addEventListener("change", () => {
      state.analysisPatternMode = analysisPatternModeSelect.value as ViewerState["analysisPatternMode"];
      buildSignalAnalysis();
      savePersistedState();
      draw();
    });

    analysisPatternInput.addEventListener("input", () => {
      applyAnalysisPatternValue(analysisPatternInput.value, analysisPatternInput);
    });

    filterScopeSelect.addEventListener("change", () => {
      state.filterScope = filterScopeSelect.value as ViewerState["filterScope"];
      buildMatches();
      savePersistedState();
      draw();
    });

    filterModeSelect.addEventListener("change", () => {
      state.filterMode = filterModeSelect.value as ViewerState["filterMode"];
      buildMatches();
      savePersistedState();
      draw();
    });

    searchInput.addEventListener("input", () => {
      applyFilterSearchValue(searchInput.value);
    });

    searchInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      buildMatches();
      if (!state.matches.length) return;
      revealNodeInMainView(state.matches[0]);
    });

    registerSearchHistoryInput(searchInput, "filter-search", {
      apply: (value) => {
        applyFilterSearchValue(value);
      },
      getValue: () => state.search
    });

    registerSearchHistoryInput(analysisPatternInput, "analysis-pattern", {
      apply: (value) => {
        applyAnalysisPatternValue(value, analysisPatternInput);
      },
      getValue: () => state.analysisPattern
    });

    const observer = new ResizeObserver(() => draw());
    observer.observe(canvas);

    window.addEventListener("resize", () => {
      positionTreemapToggleTooltip();
    });

    treePanelResizer.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      if (!state.treePanelOpen) return;
      applyTreePanelSize();
      state.draggingTreePanelResize = true;
      state.treePanelResizeStartX = event.clientX;
      state.treePanelResizeStartWidth = state.treePanelWidth;
      event.preventDefault();
    });

    const matchPanelHeader = matchPanel.querySelector<HTMLElement>(".side-header")!;
    matchPanelHeader.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      if ((event.target as HTMLElement).closest<HTMLElement>("button, a, input, select, textarea")) {
        return;
      }
      if (!state.matchPanelOpen) {
        return;
      }
      applyMatchPanelPosition();
      const panelRect = canvasPanel.getBoundingClientRect();
      state.draggingMatchPanel = true;
      state.matchPanelDragOffsetX = event.clientX - panelRect.left - state.matchPanelLeft!;
      state.matchPanelDragOffsetY = event.clientY - panelRect.top - state.matchPanelTop;
      renderMatchPanel();
      event.preventDefault();
    });

    matchPanelResizerX.addEventListener("mousedown", (event) => {
      if (event.button !== 0 || !state.matchPanelOpen) return;
      applyMatchPanelSize();
      state.draggingMatchPanelResizeX = true;
      state.draggingMatchPanelResizeY = false;
      state.matchPanelResizeStartX = event.clientX;
      state.matchPanelResizeStartWidth = state.matchPanelWidth;
      event.preventDefault();
    });

    matchPanelResizerY.addEventListener("mousedown", (event) => {
      if (event.button !== 0 || !state.matchPanelOpen) return;
      applyMatchPanelSize();
      state.draggingMatchPanelResizeY = true;
      state.draggingMatchPanelResizeX = false;
      state.matchPanelResizeStartY = event.clientY;
      state.matchPanelResizeStartHeight = state.matchPanelHeight;
      event.preventDefault();
    });

    matchPanelResizerCorner.addEventListener("mousedown", (event) => {
      if (event.button !== 0 || !state.matchPanelOpen) return;
      applyMatchPanelSize();
      state.draggingMatchPanelResizeX = true;
      state.draggingMatchPanelResizeY = true;
      state.matchPanelResizeStartX = event.clientX;
      state.matchPanelResizeStartY = event.clientY;
      state.matchPanelResizeStartWidth = state.matchPanelWidth;
      state.matchPanelResizeStartHeight = state.matchPanelHeight;
      event.preventDefault();
    });

    window.addEventListener("mousemove", (event) => {
      if (state.draggingAdvancedPopover) {
        state.advancedPopoverLeft = event.clientX - state.advancedPopoverDragOffsetX;
        state.advancedPopoverTop = event.clientY - state.advancedPopoverDragOffsetY;
        applyAdvancedPopoverPosition();
        return;
      }
      if (state.draggingTreemapAnalysisLegend) {
        const stageRect = treemapStage.getBoundingClientRect();
        state.treemapAnalysisLegendLeft = event.clientX - stageRect.left - state.treemapAnalysisLegendDragOffsetX;
        state.treemapAnalysisLegendTop = event.clientY - stageRect.top - state.treemapAnalysisLegendDragOffsetY;
        applyTreemapAnalysisLegendPosition();
        return;
      }
      if (state.draggingZenOverlay) {
        const panelRect = canvasPanel.getBoundingClientRect();
        state.zenOverlayLeft = event.clientX - panelRect.left - state.zenOverlayDragOffsetX;
        state.zenOverlayTop = event.clientY - panelRect.top - state.zenOverlayDragOffsetY;
        applyZenOverlayPosition();
        return;
      }
      if (state.draggingHoverCard) {
        const panelRect = canvasPanel.getBoundingClientRect();
        state.hoverCardLeft = event.clientX - panelRect.left - state.hoverCardDragOffsetX;
        state.hoverCardTop = event.clientY - panelRect.top - state.hoverCardDragOffsetY;
        applyHoverCardPosition();
        return;
      }
      if (state.draggingTreePanelResize) {
        state.treePanelWidth = state.treePanelResizeStartWidth + (event.clientX - state.treePanelResizeStartX);
        applyTreePanelSize();
        return;
      }
      if (state.draggingMatchPanelResizeX || state.draggingMatchPanelResizeY) {
        if (state.draggingMatchPanelResizeX) {
          state.matchPanelWidth = state.matchPanelResizeStartWidth - (event.clientX - state.matchPanelResizeStartX);
        }
        if (state.draggingMatchPanelResizeY) {
          state.matchPanelHeight = state.matchPanelResizeStartHeight + (event.clientY - state.matchPanelResizeStartY);
        }
        applyMatchPanelPosition();
        return;
      }
      if (!state.draggingMatchPanel) {
        return;
      }
      const panelRect = canvasPanel.getBoundingClientRect();
      state.matchPanelLeft = event.clientX - panelRect.left - state.matchPanelDragOffsetX;
      state.matchPanelTop = event.clientY - panelRect.top - state.matchPanelDragOffsetY;
      applyMatchPanelPosition();
    });

    window.addEventListener("mouseup", () => {
      let shouldPersist = false;

      if (state.draggingAdvancedPopover) {
        state.draggingAdvancedPopover = false;
        applyAdvancedPopoverPosition();
        shouldPersist = true;
      }
      if (state.draggingTreemapAnalysisLegend) {
        state.draggingTreemapAnalysisLegend = false;
        applyTreemapAnalysisLegendPosition();
        shouldPersist = true;
      }
      if (state.draggingZenOverlay) {
        state.draggingZenOverlay = false;
        applyZenOverlayPosition();
        shouldPersist = true;
      }
      if (state.draggingHoverCard) {
        state.draggingHoverCard = false;
        applyHoverCardPosition();
        shouldPersist = true;
      }
      if (state.draggingTreePanelResize) {
        state.draggingTreePanelResize = false;
        applyTreePanelSize();
        shouldPersist = true;
      }
      if (state.draggingMatchPanelResizeX || state.draggingMatchPanelResizeY) {
        state.draggingMatchPanelResizeX = false;
        state.draggingMatchPanelResizeY = false;
        applyMatchPanelPosition();
        shouldPersist = true;
      }

      if (state.draggingMatchPanel) {
        state.draggingMatchPanel = false;
        renderMatchPanel();
        shouldPersist = true;
      }

      if (state.isDragging) {
        state.isDragging = false;
        canvas.style.cursor = "default";
        draw();
        shouldPersist = true;
      }

      if (shouldPersist) {
        savePersistedState();
      }
    });

    window.addEventListener("beforeunload", () => {
      savePersistedState();
    });

    window.addEventListener("resize", () => {
      applyAdvancedPopoverPosition();
      applyTreemapAnalysisLegendPosition();
      applyZenOverlayPosition();
      scheduleUiAnnotations();
      scheduleSourceVirtualRender(true);
    });

    if (DATA.debugUiLabels) {
      document.addEventListener("mousemove", (event) => {
        setUiAnnotationHoverTarget(event.target);
      }, true);

      document.addEventListener("focusin", (event) => {
        setUiAnnotationHoverTarget(event.target);
      });

      document.addEventListener("mouseout", (event) => {
        if (!event.relatedTarget) {
          setUiAnnotationHoverTarget(null);
        }
      });
    }

    syncMetricHelp();
    syncAnalysisControls();
    updateSourceSearchStatus();
    applySourcePanelWindowState();
    buildSignalAnalysis();
    buildMatches();
    applyTreePanelSize();
    applyMatchPanelSize();
    setLoadingState(97, "Rendering first view...", "Computing the initial hierarchy layout.");
    await afterPaint();
    draw();
    const bundledCoverage = document.body.dataset.coverageManifest;
    if (bundledCoverage) {
      setLoadingState(97, "Loading bundled coverage...", "Matching coverage instances.");
      try {
        await (await loadCoverageImporter()).loadBundled(bundledCoverage);
      } catch (error) {
        // Keep preload diagnostics visible through subsequent layout redraws.
        coverageLoadError = `Coverage import failed: ${error instanceof Error ? error.message : String(error)}`;
        updateStatus();
      }
    }
    setLoadingState(100, "Ready", `${nodes.length} hierarchy nodes ready.`);
    requestAnimationFrame(() => {
      loadingOverlay.classList.add("hidden");
      if (DATA.debugUiLabels) {
        scheduleUiAnnotations();
      }
    });
    })();
