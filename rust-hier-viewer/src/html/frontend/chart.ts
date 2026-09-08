import type {
  ChartApi,
  ChartController,
  Chart,
  ChartEntry,
  ChartEntryStyle,
  ChartMode,
  AnalysisMode,
  PieViewState,
  ThreeViewState,
  ThreeContext,
  PieHoverBinding,
  ViewStatus,
  ChartNode,
} from "./chart-types.js";
import {
  filterActive,
  collectLevelNodes,
  createThreeViewState,
  threeBarVisualRatio,
  coverageBarHeight,
} from "./chart-model.js";

import { createCanvasPie } from "./chart-pie.js";
import { pickBarGrid } from "./chart-picking.js";
import { coverageColor, coverageCounts, coverageDetailsHtml, formatCoverage, coverageFilterControls } from "./coverage-display.js";

const THREE_MODULE_URL = new URL("./viewer-three.module.js", window.location.href).href;

function escapeHtml(text: unknown): string {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function svgNode<K extends keyof SVGElementTagNameMap>(
  tag: K
): SVGElementTagNameMap[K] {
  return document.createElementNS("http://www.w3.org/2000/svg", tag);
}

function polar(
  cx: number,
  cy: number,
  radius: number,
  angle: number
): { x: number; y: number } {
  return {
    x: cx + Math.cos(angle) * radius,
    y: cy + Math.sin(angle) * radius,
  };
}

function donutPath(
  cx: number,
  cy: number,
  innerRadius: number,
  outerRadius: number,
  startAngle: number,
  endAngle: number
): string {
  const outerStart = polar(cx, cy, outerRadius, startAngle);
  const outerEnd = polar(cx, cy, outerRadius, endAngle);
  const innerEnd = polar(cx, cy, innerRadius, endAngle);
  const innerStart = polar(cx, cy, innerRadius, startAngle);
  const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;
  return [
    `M ${outerStart.x} ${outerStart.y}`,
    `A ${outerRadius} ${outerRadius} 0 ${largeArc} 1 ${outerEnd.x} ${outerEnd.y}`,
    `L ${innerEnd.x} ${innerEnd.y}`,
    `A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${innerStart.x} ${innerStart.y}`,
    "Z",
  ].join(" ");
}

function fullDonutPath(
  cx: number,
  cy: number,
  innerRadius: number,
  outerRadius: number
): string {
  return [
    `M ${cx + outerRadius} ${cy}`,
    `A ${outerRadius} ${outerRadius} 0 1 1 ${cx - outerRadius} ${cy}`,
    `A ${outerRadius} ${outerRadius} 0 1 1 ${cx + outerRadius} ${cy}`,
    `M ${cx + innerRadius} ${cy}`,
    `A ${innerRadius} ${innerRadius} 0 1 0 ${cx - innerRadius} ${cy}`,
    `A ${innerRadius} ${innerRadius} 0 1 0 ${cx + innerRadius} ${cy}`,
    "Z",
  ].join(" ");
}

function formatPercent(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "0%";
  }
  const percent = value * 100;
  if (percent >= 10) {
    return `${percent.toFixed(1)}%`;
  }
  return `${percent.toFixed(2)}%`;
}

function truncateLabel(text: string, maxChars: number): string {
  if (!text || maxChars <= 0) {
    return "";
  }
  if (text.length <= maxChars) {
    return text;
  }
  if (maxChars <= 2) {
    return "";
  }
  return `${text.slice(0, maxChars - 1)}…`;
}

type THREE = typeof import("three");
type THREESprite = InstanceType<THREE["Sprite"]>;

function makeLabelTexture(
  THREE: THREE,
  text: string,
  theme: { dark: boolean }
): InstanceType<THREE["CanvasTexture"]> | null {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return null;
  }

  const pixelRatio = Math.max(2, Math.ceil(window.devicePixelRatio || 1));
  const fontSize = 26;
  const horizontalPadding = 18;
  const verticalPadding = 12;
  const fontSpec = `700 ${fontSize}px system-ui, sans-serif`;
  ctx.font = fontSpec;
  const metrics = ctx.measureText(text);
  const textWidth = Math.max(1, Math.ceil(metrics.width));
  canvas.width = (textWidth + horizontalPadding * 2) * pixelRatio;
  canvas.height = (fontSize + verticalPadding * 2) * pixelRatio;

  ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  ctx.font = fontSpec;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.clearRect(
    0,
    0,
    textWidth + horizontalPadding * 2,
    fontSize + verticalPadding * 2
  );
  ctx.fillStyle = theme.dark
    ? "rgba(10, 14, 24, 0.96)"
    : "rgba(255, 252, 247, 0.96)";
  ctx.strokeStyle = theme.dark
    ? "rgba(225, 233, 255, 0.48)"
    : "rgba(54, 34, 18, 0.24)";
  ctx.lineWidth = 1.5;
  const logicalHeight = fontSize + verticalPadding * 2;
  const logicalWidth = textWidth + horizontalPadding * 2;
  const radius = Math.min(14, logicalHeight * 0.36);
  ctx.beginPath();
  ctx.moveTo(radius, 0);
  ctx.lineTo(logicalWidth - radius, 0);
  ctx.quadraticCurveTo(logicalWidth, 0, logicalWidth, radius);
  ctx.lineTo(logicalWidth, logicalHeight - radius);
  ctx.quadraticCurveTo(
    logicalWidth,
    logicalHeight,
    logicalWidth - radius,
    logicalHeight
  );
  ctx.lineTo(radius, logicalHeight);
  ctx.quadraticCurveTo(0, logicalHeight, 0, logicalHeight - radius);
  ctx.lineTo(0, radius);
  ctx.quadraticCurveTo(0, 0, radius, 0);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.shadowColor = theme.dark
    ? "rgba(0, 0, 0, 0.38)"
    : "rgba(255, 255, 255, 0.7)";
  ctx.shadowBlur = 5;
  ctx.fillStyle = theme.dark ? "#f5f8ff" : "#26170b";
  ctx.fillText(text, logicalWidth / 2, logicalHeight / 2 + 0.5);

  const texture = new THREE.CanvasTexture(canvas);
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

function valueDisplay(entry: { value: number; coverageMissing?: boolean }, chart: Chart): string {
  if (chart.mode === "coverage") return entry.coverageMissing ? "No data" : `${entry.value.toFixed(2)}%`;
  if (chart.mode === "analysis" && chart.analysisMode === "ratio") {
    return `${chart.formatValue(entry.value * 100)}%`;
  }
  return chart.formatValue(entry.value);
}

function totalCaption(chart: Chart): string {
  return chart.mode === "analysis" && chart.analysisMode === "ratio"
    ? "aggregate"
    : "total";
}

declare global {
  interface Window {
    initHierarchyCharts?: (api: ChartApi) => ChartController | null;
    registerSearchHistoryInput?: (
      input: HTMLInputElement,
      key: string,
      callbacks: {
        apply: (value: string) => void;
        getValue: () => string;
      }
    ) => void;
    applySharedAnalysisPatternValue?: (
      value: string,
      input: HTMLInputElement
    ) => void;
  }
}

export function initHierarchyCharts(api: ChartApi): ChartController | null {
  const chartPanel = document.getElementById("chart-panel");
  const chartPanelSubtitle = document.getElementById("chart-panel-subtitle");
  const chartLayout = chartPanel
    ? chartPanel.querySelector<HTMLElement>(".chart-layout")
    : null;
  const chartLayoutDivider = document.getElementById("chart-layout-divider");
  const chartModeSelect = document.getElementById(
    "chart-mode-select"
  ) as HTMLSelectElement | null;
  const chartLevelSelect = document.getElementById(
    "chart-level-select"
  ) as HTMLSelectElement | null;
  const chartAnalysisEditor = document.getElementById("chart-analysis-editor");
  const chartAnalysisSelect = document.getElementById(
    "chart-analysis-select"
  ) as HTMLSelectElement | null;
  const chartAnalysisPatternModeSelect = document.getElementById(
    "chart-analysis-pattern-mode-select"
  ) as HTMLSelectElement | null;
  const chartAnalysisPatternInput = document.getElementById(
    "chart-analysis-pattern-input"
  ) as HTMLInputElement | null;
  const chartAnalysisPatternModeField = chartAnalysisPatternModeSelect
    ? chartAnalysisPatternModeSelect.closest<HTMLElement>(".metric-group")
    : null;
  const chartAnalysisPatternInputField = chartAnalysisPatternInput
    ? chartAnalysisPatternInput.closest<HTMLElement>(".metric-group")
    : null;
  const chartStatus = document.getElementById("chart-status");
  const chartCrumbs = document.getElementById("chart-crumbs");
  const chartDetailCard = document.getElementById("chart-detail-card");
  const chartDetailPath = document.getElementById("chart-detail-path");
  const chartDetailTitle = document.getElementById("chart-detail-title");
  const chartDetailMeta = document.getElementById("chart-detail-meta");
  const chartVisual = document.getElementById("chart-visual");
  const chartLegend = document.getElementById("chart-legend");
  if (
    !chartPanel ||
    !chartLayout ||
    !chartLayoutDivider ||
    !chartModeSelect ||
    !chartLevelSelect ||
    !chartAnalysisEditor ||
    !chartAnalysisSelect ||
    !chartAnalysisPatternModeSelect ||
    !chartAnalysisPatternInput ||
    !chartStatus ||
    !chartCrumbs ||
    !chartDetailCard ||
    !chartDetailPath ||
    !chartDetailTitle ||
    !chartDetailMeta ||
    !chartVisual ||
    !chartLegend
  ) {
    return null;
  }

  const state = api.state;
  let lastRenderSignature = "";
  let lastCoverage = state.coverage;
  let renderGeneration = 0;
  let lastLevelSignature = "";
  let chartResizeObserver: ResizeObserver | null = null;
  let threeLoadPromise: Promise<THREE> | null = null;
  let threeContext: ThreeContext | null = null;
  let hoveredSliceId: number | null = null;
  let pieHoverBindings: Map<number, PieHoverBinding> | null = null;
  let activePieBinding: PieHoverBinding | null = null;
  let activeLegendElement: HTMLElement | null = null;
  let legendElements = new Map<number, HTMLElement>();
  let disposeLegend: (() => void) | null = null;
  let refreshPieView: (() => void) | null = null;
  let pieFrame = 0;
  let canvasPie: ReturnType<typeof createCanvasPie> | null = null;
  let pieViewState: PieViewState | null = null;
  let lastPieDataKey = "";
  let threeViewState: ThreeViewState | null = null;
  let lastThreeDataKey = "";
  let draggingChartSplit = false;
  let chartSplitRatio = 0.65;

  function clearHoverState(): void {
    hoveredSliceId = null;
  }

  function formatLocation(node: ChartNode): string {
    if (!node || !node.filePath) {
      return "Source location unavailable";
    }
    const line = node.line || 1;
    const column = node.column || 1;
    return `${node.filePath}:${line}:${column}`;
  }

  function detailMetaLine(label: string, value: string): string {
    return `<div><strong>${escapeHtml(label)}:</strong> ${escapeHtml(
      value
    )}</div>`;
  }

  function showNodeDetails(entry: ChartEntry, chart: Chart): void {
    if (!entry || !entry.node) {
      return;
    }
    const node = entry.node;
    chartDetailPath!.textContent = node.path || "(root)";
    chartDetailTitle!.textContent = `${node.name} <${node.module}>`;
    chartDetailMeta!.innerHTML = [
      detailMetaLine("Module", node.module),
      detailMetaLine(
        chart.mode === "coverage" ? "Coverage height" : "Area",
        chart.mode === "coverage" ? valueDisplay(entry, chart) : `${formatPercent(entry.fraction)} · ${valueDisplay(entry, chart)}`
      ),
    ].join("") + (coverageLabel() ? coverageDetailsHtml(state.coverage, entry.id) : "");
    chartDetailCard!.classList.remove("hidden");
  }

  function clearNodeDetails(): void {
    chartDetailCard!.classList.add("hidden");
    chartDetailPath!.textContent = "";
    chartDetailTitle!.textContent = "";
    chartDetailMeta!.innerHTML = "";
  }

  function clearPieHoverBindings(): void {
    pieHoverBindings = null;
    activePieBinding = null;
    activeLegendElement = null;
    refreshPieView = null;
  }

  function pieDataKey(): string {
    return JSON.stringify([
      state.currentRoot,
      state.chartLevel,
      state.chartMode,
      state.analysisMode,
      state.analysisPatternMode,
      state.analysisPattern,
      state.search,
      state.filterScope,
      state.filterMode,
      chartVisual!.clientWidth,
      chartVisual!.clientHeight,
    ]);
  }

  function resetPieView(width: number, height: number): PieViewState {
    const view: PieViewState = {
      x: 0,
      y: 0,
      w: width,
      h: height,
      baseW: width,
      baseH: height,
      dragging: false,
      dragMoved: false,
      lastClientX: 0,
      lastClientY: 0,
      suppressClick: false,
    };
    if (pieViewState) Object.assign(pieViewState, view);
    else pieViewState = view;
    return pieViewState;
  }

  function ensurePieView(width: number, height: number): PieViewState {
    const key = pieDataKey();
    if (
      !pieViewState ||
      lastPieDataKey !== key ||
      pieViewState.baseW !== width ||
      pieViewState.baseH !== height
    ) {
      resetPieView(width, height);
      lastPieDataKey = key;
    }
    return pieViewState!;
  }

  function threeDataKey(): string {
    return JSON.stringify([
      state.currentRoot,
      state.chartLevel,
      state.chartMode,
      state.analysisMode,
      state.analysisPatternMode,
      state.analysisPattern,
      state.search,
      state.filterScope,
      state.filterMode,
      chartVisual!.clientWidth,
      chartVisual!.clientHeight,
    ]);
  }

  function ensureThreeView(extent: number, maxHeight: number): ThreeViewState {
    const key = threeDataKey();
    if (!threeViewState || lastThreeDataKey !== key) {
      threeViewState = createThreeViewState(
        extent,
        maxHeight,
        chartVisual!.clientWidth,
        chartVisual!.clientHeight
      );
      lastThreeDataKey = key;
    }
    return threeViewState;
  }

  function resetThreeView(extent: number, maxHeight: number): ThreeViewState {
    const newView = createThreeViewState(
      extent,
      maxHeight,
      chartVisual!.clientWidth,
      chartVisual!.clientHeight
    );
    Object.assign(threeViewState as ThreeViewState, newView);
    lastThreeDataKey = threeDataKey();
    return threeViewState as ThreeViewState;
  }

  function currentThreeZoomLabel(): string {
    if (!threeViewState || !threeViewState.fitDistance) {
      return "1.00x";
    }
    return `${(
      threeViewState.fitDistance / Math.max(threeViewState.distance, 0.0001)
    ).toFixed(2)}x`;
  }

  function currentPieZoom(): number {
    if (!pieViewState) {
      return 1;
    }
    return pieViewState.baseW / pieViewState.w;
  }

  function clampPieView(): void {
    if (!pieViewState) {
      return;
    }
    const view = pieViewState;
    if (view.w >= view.baseW) {
      view.x = 0;
    } else {
      view.x = Math.max(0, Math.min(view.x, view.baseW - view.w));
    }
    if (view.h >= view.baseH) {
      view.y = 0;
    } else {
      view.y = Math.max(0, Math.min(view.y, view.baseH - view.h));
    }
  }

  function clearVisual(): void {
    canvasPie?.dispose();
    canvasPie = null;
    cancelAnimationFrame(pieFrame);
    pieFrame = 0;
    clearPieHoverBindings();
    chartVisual!.replaceChildren();
  }

  function disposeThreeContext(): void {
    if (!threeContext) {
      return;
    }
    if (typeof threeContext.dispose === "function") {
      threeContext.dispose();
    }
    threeContext = null;
  }

  function invalidate(): void {
    state.chartPanelDirty = true;
    lastRenderSignature = "";
  }

  function chartLayoutIsVertical(): boolean {
    return window.matchMedia("(max-width: 800px)").matches;
  }

  function applyChartSplitRatio(): void {
    const visualRatio = Math.max(0.22, Math.min(0.82, chartSplitRatio));
    const legendRatio = Math.max(0.18, 1 - visualRatio);
    chartLayout!.style.setProperty("--chart-visual-fr", `${visualRatio}fr`);
    chartLayout!.style.setProperty("--chart-legend-fr", `${legendRatio}fr`);
  }

  function updateChartSplitFromPointer(event: MouseEvent): void {
    const rect = chartLayout!.getBoundingClientRect();
    if (chartLayoutIsVertical()) {
      const relativeY = (event.clientY - rect.top) / Math.max(rect.height, 1);
      chartSplitRatio = Math.max(0.28, Math.min(0.82, relativeY));
    } else {
      const relativeX = (event.clientX - rect.left) / Math.max(rect.width, 1);
      chartSplitRatio = Math.max(0.28, Math.min(0.78, relativeX));
    }
    applyChartSplitRatio();
    invalidate();
    renderChart(true);
  }

  function levelMax(): number {
    return Math.max(0, api.currentMaxDepth());
  }

  function clampChartLevel(): number | null {
    const maxDepth = levelMax();
    if (maxDepth <= 0) {
      state.chartLevel = null;
      return state.chartLevel;
    }
    if (state.chartLevel === null || state.chartLevel === undefined) {
      state.chartLevel = null;
      return state.chartLevel;
    }
    const rawLevel = Number.isInteger(state.chartLevel)
      ? state.chartLevel
      : maxDepth;
    state.chartLevel = Math.max(1, Math.min(maxDepth, rawLevel));
    return state.chartLevel;
  }

  function chartLevelValue(): number {
    const maxDepth = levelMax();
    const level = clampChartLevel();
    if (maxDepth <= 0) {
      return 0;
    }
    return level === null ? maxDepth : level;
  }

  function chartLevelLabel(): string {
    const maxDepth = levelMax();
    const level = clampChartLevel();
    if (maxDepth <= 0) {
      return "Max";
    }
    return level === null ? `Max (${maxDepth})` : String(level);
  }

  function syncLevelOptions(): void {
    const maxDepth = levelMax();
    const signature = `${state.currentRoot}:${maxDepth}`;
    if (signature !== lastLevelSignature) {
      chartLevelSelect!.innerHTML = "";
      const maxOption = document.createElement("option");
      maxOption.value = "max";
      maxOption.textContent = maxDepth > 0 ? `Max (${maxDepth})` : "Max";
      chartLevelSelect!.appendChild(maxOption);
      for (let level = 1; level <= maxDepth; level += 1) {
        const option = document.createElement("option");
        option.value = String(level);
        option.textContent = String(level);
        chartLevelSelect!.appendChild(option);
      }
      lastLevelSignature = signature;
    }
    chartLevelSelect!.value =
      clampChartLevel() === null ? "max" : String(state.chartLevel);
    chartLevelSelect!.disabled = maxDepth === 0;
  }

  function syncControls(): void {
    chartPanel!.classList.toggle("active", !!state.chartPanelOpen);
    const canUseCoverage = state.chartRenderMode === "three3d" && !!state.coverage && state.coverage.metric !== "off";
    const coverageOption = chartModeSelect!.querySelector<HTMLOptionElement>('option[value="coverage"]');
    if (coverageOption) coverageOption.disabled = !canUseCoverage;
    if (state.chartMode === "coverage" && !canUseCoverage) state.chartMode = "weighted_bits";
    chartModeSelect!.value = state.chartMode;
    chartAnalysisEditor!.classList.toggle(
      "hidden",
      state.chartMode !== "analysis"
    );
    chartAnalysisSelect!.value = state.analysisMode;
    chartAnalysisPatternModeSelect!.value = state.analysisPatternMode;
    chartAnalysisPatternInput!.value = state.analysisPattern;
    const usesSignalPattern =
      state.analysisMode === "count" || state.analysisMode === "ratio";
    if (chartAnalysisPatternModeField) {
      chartAnalysisPatternModeField.classList.toggle(
        "hidden",
        !usesSignalPattern
      );
    }
    if (chartAnalysisPatternInputField) {
      chartAnalysisPatternInputField.classList.toggle(
        "hidden",
        !usesSignalPattern
      );
    }
    chartAnalysisPatternModeSelect!.disabled = !usesSignalPattern;
    chartAnalysisPatternInput!.disabled = !usesSignalPattern;
    chartAnalysisPatternModeSelect!.title =
      "Choose wildcard, text, or regex matching for signal names.";
    chartAnalysisPatternInput!.title =
      "Use ';' to combine multiple signal-name patterns. Example: _GEN* ; foo_*";
    chartLevelSelect!.title =
      "Level follows treemap semantics: descend from the current root up to this depth, and keep leaf nodes that end earlier.";
    syncLevelOptions();
    applyChartSplitRatio();
  }

  function buildBreadcrumbChain(): number[] {
    const chain: number[] = [];
    let cursor: number | null = state.currentRoot;
    while (cursor !== null && cursor !== undefined) {
      chain.push(cursor);
      cursor = api.visibleParent(cursor);
    }
    chain.reverse();
    return chain;
  }

  function renderChartBreadcrumbs(): void {
    const chain = buildBreadcrumbChain();
    chartCrumbs!.innerHTML = "";
    const fragment = document.createDocumentFragment();
    chain.forEach((nodeId, index) => {
      const node = api.getNode(nodeId);
      const button = document.createElement("button");
      button.type = "button";
      button.className =
        "chart-crumb" + (index === chain.length - 1 ? " current" : "");
      button.textContent = node.name || "(root)";
      button.title = `${node.path || "(root)"} <${node.module}>`;
      if (index !== chain.length - 1) {
        button.addEventListener("click", () => {
          clearHoverState();
          api.setRootAndReset(nodeId);
        });
      } else {
        button.disabled = true;
        button.setAttribute("aria-current", "page");
      }
      fragment.appendChild(button);
    });
    chartCrumbs!.appendChild(fragment);
  }

  function applyPieHoverState(): void {
    canvasPie?.hover(hoveredSliceId);
    const nextLegend = hoveredSliceId === null ? null : legendElements.get(hoveredSliceId) ?? null;
    if (activeLegendElement !== nextLegend) {
      activeLegendElement?.classList.remove("active");
      nextLegend?.classList.add("active");
      activeLegendElement = nextLegend;
    }
    if (!pieHoverBindings) {
      return;
    }
    const next = hoveredSliceId === null ? null : pieHoverBindings.get(hoveredSliceId) ?? null;
    if (next === activePieBinding) return;
    for (const binding of [activePieBinding, next]) {
      if (!binding) continue;
      const active = binding === next;
      binding.slice.classList.toggle("active", active);
      binding.slice.setAttribute("stroke-width", active ? "2.5" : "1.25");
      binding.slice.style.transform = binding.transform(active);
      legendElements.get(binding.id)?.classList.toggle("active", active);
    }
    activePieBinding = next;
  }

  function currentSignature(): string {
    return JSON.stringify([
      state.mainViewMode,
      state.currentRoot,
      chartLevelValue(),
      levelMax(),
      state.chartMode,
      state.chartRenderMode,
      state.search,
      state.filterScope,
      state.filterMode,
      state.analysisMode,
      state.analysisPatternMode,
      state.analysisPattern,
      state.theme,
      state.weightedVariableWeight,
      state.weightedNetWeight,
      state.coverage?.metric ?? "off",
      state.coverage?.filterMask ?? 0,
      chartVisual!.clientWidth,
      chartVisual!.clientHeight,
    ]);
  }

  function analysisValue(nodeId: number): number {
    if (!api.analysisActive()) {
      return 0;
    }
    if (state.analysisMode === "ratio") {
      return state.analysisSubtreeRatios[nodeId] || 0;
    }
    if (state.analysisMode === "loc") {
      return state.analysisSubtreeLocs[nodeId] || 0;
    }
    return state.analysisSubtreeCounts[nodeId] || 0;
  }

  function buildEntryStyle(
    entry: { id: number; value: number },
    index: number,
    maxValue: number,
    mode: ChartMode
  ): ChartEntryStyle {
    const theme = api.currentThemeVisuals();
    const coverage = coverageColor(state.coverage, entry.id);
    if (coverage) {
      return {
        fill: api.mixHexColors(theme.canvasBase, coverage, theme.dark ? 0.72 : 0.66),
        stroke: api.mixHexColors(theme.text, coverage, 0.55),
        background: api.hexToRgba(api.mixHexColors(theme.panel, coverage, theme.dark ? 0.2 : 0.08), 0.96),
      };
    }
    if (mode === "analysis") {
      const ramp = theme.analysisRamp || [theme.match];
      const normalized = maxValue > 0 ? entry.value / maxValue : 0;
      const bucketIndex = Math.max(
        0,
        Math.min(
          ramp.length - 1,
          Math.floor(normalized * ramp.length * 0.999)
        )
      );
      const accent = ramp[bucketIndex];
      return {
        fill: api.mixHexColors(
          theme.canvasBase,
          accent,
          theme.dark ? 0.62 : 0.56
        ),
        stroke: api.mixHexColors(theme.text, accent, theme.dark ? 0.52 : 0.46),
        background: api.hexToRgba(
          api.mixHexColors(theme.panel, accent, theme.dark ? 0.22 : 0.18),
          0.94
        ),
      };
    }

    const accent = api.themeNodeAccent(index);
    return {
      fill: api.mixHexColors(
        theme.canvasBase,
        accent,
        theme.dark ? 0.62 : 0.54
      ),
      stroke: api.mixHexColors(theme.text, accent, theme.dark ? 0.46 : 0.38),
      background: api.hexToRgba(
        api.mixHexColors(theme.panel, accent, theme.dark ? 0.22 : 0.16),
        0.94
      ),
    };
  }

  function coverageLabel(): string {
    const metric = state.coverage?.metric;
    if (!metric || metric === "off") return "";
    return metric.charAt(0).toUpperCase() + metric.slice(1);
  }

  function modeSummary(mode: ChartMode, analysisMode: AnalysisMode): string {
    if (mode === "coverage") return `${coverageLabel()} Coverage (0–100%)`;
    if (mode === "analysis") {
      if (analysisMode === "ratio") return "Analysis Pattern Ratio";
      if (analysisMode === "loc") return "Module LOC";
      return "Analysis Pattern Count";
    }
    return "Weighted Signal Bits";
  }

  function buildChart(): Chart | { emptyMessage: string; status: string } {
    const root = api.getNode(state.currentRoot);
    const selectedLevel = chartLevelValue();
    const mode = state.chartMode;
    const analysisMode: AnalysisMode =
      state.analysisMode === "ratio"
        ? "ratio"
        : state.analysisMode === "loc"
        ? "loc"
        : "count";
    chartPanelSubtitle!.textContent = `${root.path || "(root)"} · ${modeSummary(
      mode,
      analysisMode
    )} · level ${chartLevelLabel()}${coverageLabel() ? ` · color: ${coverageLabel()} coverage` : ""}`;
    renderChartBreadcrumbs();

    if (mode === "analysis" && !api.analysisActive()) {
      return {
        emptyMessage:
          state.analysisError ||
          "Analysis Pattern is not active. Configure it in Advanced first.",
        status: "Analysis Pattern is currently disabled.",
      };
    }

    const nodeIds = collectLevelNodes(state.currentRoot, selectedLevel, api);
    if (!nodeIds.length) {
      return {
        emptyMessage: filterActive(state)
          ? "No hierarchy nodes remain at this level after the current filter is applied."
          : "No hierarchy nodes are available at this level.",
        status: filterActive(state)
          ? "Filter active: 0 visible slices."
          : "0 visible slices.",
      };
    }

    const entries = nodeIds
      .map((nodeId) => {
        const node = api.getNode(nodeId);
        const counts = state.coverage?.metric && state.coverage.metric !== "off" ? coverageCounts(state.coverage, nodeId, state.coverage.metric) : undefined;
        const value = mode === "coverage"
          ? counts && counts.total > 0 ? counts.covered / counts.total * 100 : 0
          : mode === "analysis" ? analysisValue(nodeId) : api.subtreeWeightedBits(node);
        return {
          id: nodeId,
          node,
          value,
          coverageMissing: mode === "coverage" && (!counts || counts.total === 0),
        };
      })
      .filter((entry) => mode === "coverage" || entry.value > 0);

    if (!entries.length) {
      return {
        emptyMessage:
          mode === "analysis"
            ? "The current Analysis Pattern produced zero visible values at this level."
            : "Weighted bits are zero for all visible hierarchy nodes at this level.",
        status: "0 non-zero slices.",
      };
    }

    entries.sort((left, right) => Number(left.coverageMissing) - Number(right.coverageMissing) || right.value - left.value);
    const total = mode === "coverage" ? 0 : entries.reduce((sum, entry) => sum + entry.value, 0);
    const maxValue = mode === "coverage" ? 100 : entries.reduce(
      (max, entry) => Math.max(max, entry.value),
      0
    );
    const minValue = entries.reduce(
      (min, entry) => Math.min(min, entry.value),
      Number.POSITIVE_INFINITY
    );
    const chart: Chart = {
      root,
      level: selectedLevel,
      mode,
      analysisMode,
      total,
      maxValue,
      minValue: Number.isFinite(minValue) ? minValue : 0,
      formatValue: api.formatMetricValue,
      entries: entries.map((entry, index) => {
        const style = buildEntryStyle(entry, index, maxValue, mode);
        return {
          ...entry,
          fraction: total > 0 ? entry.value / total : 0,
          style,
        };
      }),
      status: "",
    };
    chart.status = mode === "coverage"
      ? `${chart.entries.length} instances · level ${chartLevelLabel()} · height: ${coverageLabel()} 0–100% · ${chart.entries.filter(entry => entry.coverageMissing).length} without data`
      : `${chart.entries.length} slices · level ${chartLevelLabel()} · ${totalCaption(
      chart
    )} ${valueDisplay({ value: total }, chart)}${
      filterActive(state) ? " · filter active" : ""
    }`;
    return chart;
  }

  function renderEmpty(message: string): void {
    disposeLegend?.();
    disposeLegend = null;
    legendElements.clear();
    disposeThreeContext();
    clearVisual();
    clearNodeDetails();
    const empty = document.createElement("div");
    empty.className = "chart-empty";
    empty.textContent = message;
    chartVisual!.appendChild(empty);
    chartLegend!.replaceChildren();
    const key = coverageLegend();
    if (key) chartLegend!.appendChild(key);
    const messageElement = document.createElement("div");
    messageElement.className = "side-empty";
    messageElement.textContent = "Nothing to show.";
    chartLegend!.appendChild(messageElement);
  }

  function coverageLegend(): HTMLElement | null {
    const metric = state.coverage?.metric;
    if (!metric || metric === "off") return null;

    const key = document.createElement("div");
    key.className = "chart-coverage-key";
    key.setAttribute("aria-label", "Coverage legend");
    const heading = document.createElement("div");
    heading.className = "chart-coverage-key-title";
    heading.textContent = `Subtree ${coverageLabel()}: ${formatCoverage(coverageCounts(state.coverage, state.currentRoot, metric))}`;
    key.innerHTML = coverageFilterControls(state.coverage);
    key.prepend(heading);
    return key;
  }

  function renderLegend(chart: Chart): Map<number, HTMLElement> {
    disposeLegend?.();
    disposeLegend = null;
    chartLegend!.innerHTML = "";
    const legendMap = new Map<number, HTMLElement>();
    legendElements = legendMap;
    const fragment = document.createDocumentFragment();
    const key = coverageLegend();
    if (key) fragment.appendChild(key);
    const metric = state.coverage?.metric;
    const createRow = (entry: ChartEntry) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "chart-legend-item";
      button.style.border = `1px solid ${entry.style.stroke}`;
      button.style.background = entry.style.background;
      button.title = `${entry.node.path} <${entry.node.module}>`;

      const swatch = document.createElement("span");
      swatch.className = "chart-legend-swatch";
      swatch.style.background = entry.style.fill;
      swatch.style.boxShadow = `0 0 0 1px ${entry.style.stroke}`;

      const main = document.createElement("span");
      main.className = "chart-legend-main";

      const label = document.createElement("div");
      label.className = "chart-legend-label";
      label.textContent = entry.node.path || entry.node.name || "(root)";
      main.appendChild(label);

      const module = document.createElement("div");
      module.className = "chart-legend-module";
      module.textContent = `<${entry.node.module}>`;
      main.appendChild(module);
      if (metric && metric !== "off") {
        const coverage = document.createElement("div");
        coverage.className = "chart-legend-coverage";
        coverage.textContent = `${coverageLabel()} ${formatCoverage(coverageCounts(state.coverage, entry.id, metric))}`;
        main.appendChild(coverage);
      }

      const value = document.createElement("span");
      value.className = "chart-legend-value";
      value.textContent = chart.mode === "coverage" ? valueDisplay(entry, chart) : `${valueDisplay(entry, chart)} · ${formatPercent(
        entry.fraction
      )}`;

      button.appendChild(swatch);
      button.appendChild(main);
      button.appendChild(value);
      button.addEventListener("click", () => api.focusNodeInMainView(entry.id));
      button.addEventListener("mouseenter", () => {
        hoveredSliceId = entry.id;
        applyPieHoverState();
        showNodeDetails(entry, chart);
      });
      button.addEventListener("mouseleave", () => {
        if (hoveredSliceId === entry.id) {
          clearHoverState();
          applyPieHoverState();
          clearNodeDetails();
        }
      });
      button.classList.toggle("active", hoveredSliceId === entry.id);
      legendMap.set(entry.id, button);
      return button;
    };
    if (chart.entries.length <= 200) {
      for (const entry of chart.entries) fragment.appendChild(createRow(entry));
      chartLegend!.appendChild(fragment);
      return legendMap;
    }

    // Keep the complete scroll range without laying out thousands of DOM rows.
    const rowHeight = metric && metric !== "off" ? 82 : 60;
    const rows = document.createElement("div");
    rows.className = "chart-legend-virtual";
    rows.style.cssText = `position:relative;flex:0 0 auto;height:${chart.entries.length * rowHeight}px`;
    fragment.appendChild(rows);
    chartLegend!.appendChild(fragment);
    const rowsTop = rows.getBoundingClientRect().top - chartLegend!.getBoundingClientRect().top + chartLegend!.scrollTop - chartLegend!.clientTop;
    let firstRow = -1;
    let lastRow = -1;
    let frame = 0;
    const paintRows = () => {
      frame = 0;
      const top = Math.max(0, chartLegend!.scrollTop - rowsTop);
      const first = Math.max(0, Math.floor(top / rowHeight) - 4);
      const last = Math.min(chart.entries.length, Math.ceil((top + chartLegend!.clientHeight) / rowHeight) + 4);
      if (first === firstRow && last === lastRow) return;
      firstRow = first;
      lastRow = last;
      const focusedIndex = (document.activeElement as HTMLElement | null)?.dataset.chartIndex;
      legendMap.clear();
      const visible = document.createDocumentFragment();
      for (let index = first; index < last; index++) {
        const row = createRow(chart.entries[index]);
        row.dataset.chartIndex = String(index);
        row.style.cssText += `;position:absolute;top:${index * rowHeight}px;height:${rowHeight - 2}px;box-sizing:border-box`;
        visible.appendChild(row);
      }
      rows.replaceChildren(visible);
      if (focusedIndex !== undefined) {
        rows.querySelector<HTMLElement>(`[data-chart-index="${focusedIndex}"]`)?.focus({ preventScroll: true });
      }
    };
    const scroll = () => { frame ||= requestAnimationFrame(paintRows); };
    const keydown = (event: KeyboardEvent) => {
      const index = Number((event.target as HTMLElement).closest<HTMLElement>("[data-chart-index]")?.dataset.chartIndex);
      if (!Number.isInteger(index)) return;
      let next: number;
      if (event.key === "ArrowDown") next = Math.min(chart.entries.length - 1, index + 1);
      else if (event.key === "ArrowUp") next = Math.max(0, index - 1);
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = chart.entries.length - 1;
      else return;
      event.preventDefault();
      chartLegend!.scrollTop = rowsTop + next * rowHeight;
      paintRows();
      legendMap.get(chart.entries[next].id)?.focus({ preventScroll: true });
    };
    chartLegend!.addEventListener("scroll", scroll, { passive: true });
    rows.addEventListener("keydown", keydown);
    disposeLegend = () => {
      cancelAnimationFrame(frame);
      chartLegend!.removeEventListener("scroll", scroll);
      rows.removeEventListener("keydown", keydown);
    };
    paintRows();
    return legendMap;
  }

  function sliceOffsetTransform(
    cx: number,
    cy: number,
    startAngle: number,
    endAngle: number,
    active: boolean
  ): string {
    if (!active) {
      return "";
    }
    const angle = (startAngle + endAngle) / 2;
    const dx = Math.cos(angle) * 12;
    const dy = Math.sin(angle) * 12;
    return `translate(${dx} ${dy})`;
  }

  function appendSliceLabel(
    svg: SVGElement,
    entry: ChartEntry,
    startAngle: number,
    endAngle: number,
    cx: number,
    cy: number,
    innerRadius: number,
    outerRadius: number,
    zoomFactor: number
  ): void {
    const angleSpan = Math.max(0, endAngle - startAngle);
    const radialThickness = outerRadius - innerRadius;
    const labelRadius = innerRadius + radialThickness * 0.54;
    const arcLength = labelRadius * angleSpan;
    const availableWidth = Math.max(0, (arcLength - 14) * zoomFactor);
    const availableHeight = Math.max(0, (radialThickness - 8) * zoomFactor);
    if (availableWidth < 30 || availableHeight < 14) {
      return;
    }

    const midAngle = (startAngle + endAngle) / 2;
    const position = polar(cx, cy, labelRadius, midAngle);
    const rawLabel = entry.node.name || entry.node.module || "";
    const estimatedCharWidth = 7.2;
    const maxChars = Math.floor(availableWidth / estimatedCharWidth);
    const labelText = truncateLabel(rawLabel, maxChars);
    if (!labelText) {
      return;
    }

    let rotation = (midAngle * 180) / Math.PI + 90;
    if (rotation > 90 && rotation < 270) {
      rotation += 180;
    }

    const label = svgNode("text");
    label.setAttribute("x", String(position.x));
    label.setAttribute("y", String(position.y));
    label.setAttribute("class", "chart-slice-label");
    label.setAttribute(
      "transform",
      `rotate(${rotation} ${position.x} ${position.y})`
    );
    label.textContent = labelText;
    svg.appendChild(label);
  }

  function renderPie2d(chart: Chart): void {
    disposeThreeContext();
    clearVisual();
    clearPieHoverBindings();
    const largeChart = chart.entries.length > 2000;
    const width = Math.max(largeChart ? 1 : 560, chartVisual!.clientWidth);
    const height = Math.max(largeChart ? 1 : 360, chartVisual!.clientHeight);
    const pieView = ensurePieView(width, height);
    if (largeChart) {
      renderLegend(chart);
      const theme = api.currentThemeVisuals();
      canvasPie = createCanvasPie({
        host: chartVisual!, entries: chart.entries, view: pieView,
        title: chart.root.name || "(root)",
        subtitle: `${valueDisplay({ value: chart.total }, chart)} ${totalCaption(chart)}`,
        textColor: theme.text, mutedColor: theme.textSoft,
        clampView: clampPieView,
        onHover(entry) {
          if (hoveredSliceId === (entry?.id ?? null)) return;
          if (hoveredSliceId !== null) legendElements.get(hoveredSliceId)?.classList.remove("active");
          hoveredSliceId = entry?.id ?? null;
          if (entry) {
            legendElements.get(entry.id)?.classList.add("active");
            showNodeDetails(entry, chart);
          } else clearNodeDetails();
          applyPieHoverState();
        },
        onSelect: entry => api.focusNodeInMainView(entry.id),
        onViewChange: () => api.requestDraw(),
      });
      refreshPieView = canvasPie.refresh;
      return;
    }
    const zoomFactor = currentPieZoom();
    const svg = svgNode("svg");
    svg.classList.add("chart-svg");
    svg.setAttribute("viewBox", `${pieView.x} ${pieView.y} ${pieView.w} ${pieView.h}`);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Hierarchy chart");
    svg.style.width = "100%";
    svg.style.height = "100%";
    svg.style.cursor = pieView.dragging ? "grabbing" : zoomFactor > 1 ? "grab" : "default";
    svg.addEventListener("mouseleave", () => {
      if (hoveredSliceId !== null) {
        clearHoverState();
        applyPieHoverState();
        clearNodeDetails();
      }
    });
    svg.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        const rect = svg.getBoundingClientRect();
        const pointerX = (event.clientX - rect.left) / rect.width;
        const pointerY = (event.clientY - rect.top) / rect.height;
        const anchorX = pieView.x + pointerX * pieView.w;
        const anchorY = pieView.y + pointerY * pieView.h;
        const zoomStep = event.deltaY < 0 ? 1 / 1.18 : 1.18;
        const nextW = Math.max(width / 18, Math.min(width, pieView.w * zoomStep));
        const nextH = Math.max(height / 18, Math.min(height, pieView.h * zoomStep));
        pieView.x = anchorX - pointerX * nextW;
        pieView.y = anchorY - pointerY * nextH;
        pieView.w = nextW;
        pieView.h = nextH;
        clampPieView();
        refreshPieView?.();
      },
      { passive: false }
    );
    svg.addEventListener("mousedown", (event) => {
      if (event.button !== 0) {
        return;
      }
      pieView.dragging = true;
      pieView.dragMoved = false;
      pieView.lastClientX = event.clientX;
      pieView.lastClientY = event.clientY;
      svg.style.cursor = "grabbing";
    });
    svg.addEventListener("mousemove", (event) => {
      if (!pieView.dragging) {
        return;
      }
      const rect = svg.getBoundingClientRect();
      const dx = ((event.clientX - pieView.lastClientX) / rect.width) * pieView.w;
      const dy = ((event.clientY - pieView.lastClientY) / rect.height) * pieView.h;
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
        pieView.dragMoved = true;
        pieView.suppressClick = true;
        if (event.cancelable) {
          event.preventDefault();
        }
      }
      pieView.x -= dx;
      pieView.y -= dy;
      pieView.lastClientX = event.clientX;
      pieView.lastClientY = event.clientY;
      clampPieView();
      refreshPieView?.();
    });
    const legendMap = renderLegend(chart);
    const bindings = new Map<number, PieHoverBinding>();
    const labels = svgNode("g");

    const cx = width * 0.44;
    const cy = height * 0.52;
    const outerRadius = Math.min(width, height) * 0.33;
    const innerRadius = outerRadius * 0.44;
    const isSingleSlice = chart.entries.length === 1;
    let angle = -Math.PI / 2;

    for (const entry of chart.entries) {
      const startAngle = angle;
      const nextAngle = isSingleSlice
        ? startAngle + Math.PI * 2
        : startAngle + Math.PI * 2 * entry.fraction;
      const slice = svgNode("path");
      slice.setAttribute(
        "d",
        isSingleSlice
          ? fullDonutPath(cx, cy, innerRadius, outerRadius)
          : donutPath(cx, cy, innerRadius, outerRadius, startAngle, nextAngle)
      );
      slice.setAttribute("fill", entry.style.fill);
      slice.setAttribute("fill-rule", "evenodd");
      slice.setAttribute("stroke", entry.style.stroke);
      slice.setAttribute("stroke-width", "1.25");
      slice.classList.add("chart-slice");
      slice.style.cursor = "pointer";
      slice.addEventListener("mouseenter", () => {
        hoveredSliceId = entry.id;
        applyPieHoverState();
        showNodeDetails(entry, chart);
      });
      slice.addEventListener("mouseleave", () => {
        if (hoveredSliceId === entry.id) {
          clearHoverState();
          applyPieHoverState();
          clearNodeDetails();
        }
      });
      slice.addEventListener("click", (event) => {
        if (pieView.suppressClick) {
          pieView.suppressClick = false;
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        api.focusNodeInMainView(entry.id);
      });
      svg.appendChild(slice);
      bindings.set(entry.id, {
        id: entry.id,
        slice,
        legend: legendMap.get(entry.id) || null,
        transform: (active) =>
          sliceOffsetTransform(cx, cy, startAngle, nextAngle, active),
      });
      appendSliceLabel(
        labels,
        entry,
        startAngle,
        nextAngle,
        cx,
        cy,
        innerRadius,
        outerRadius,
        zoomFactor
      );
      angle = nextAngle;
    }

    const centerTitle = svgNode("text");
    centerTitle.setAttribute("x", String(cx));
    centerTitle.setAttribute("y", String(cy - 8));
    centerTitle.setAttribute("class", "chart-center-label");
    centerTitle.textContent = chart.root.name || "(root)";
    svg.appendChild(centerTitle);

    const centerValue = svgNode("text");
    centerValue.setAttribute("x", String(cx));
    centerValue.setAttribute("y", String(cy + 14));
    centerValue.setAttribute("class", "chart-center-subtitle");
    centerValue.textContent = `${valueDisplay({ value: chart.total }, chart)} ${totalCaption(
      chart
    )}`;
    svg.appendChild(centerValue);

    svg.appendChild(labels);
    let labelZoom = zoomFactor;
    refreshPieView = () => {
      pieFrame ||= requestAnimationFrame(() => {
        pieFrame = 0;
        svg.setAttribute("viewBox", `${pieView.x} ${pieView.y} ${pieView.w} ${pieView.h}`);
        const zoom = currentPieZoom();
        svg.style.cursor = pieView.dragging ? "grabbing" : zoom > 1 ? "grab" : "default";
        // Panning only changes the camera. Rebuild labels only when their space changes.
        if (zoom !== labelZoom) {
          labelZoom = zoom;
          labels.replaceChildren();
          let start = -Math.PI / 2;
          for (const entry of chart.entries) {
            const end = start + Math.PI * 2 * entry.fraction;
            appendSliceLabel(labels, entry, start, end, cx, cy, innerRadius, outerRadius, zoom);
            start = end;
          }
        }
        api.requestDraw();
      });
    };
    chartVisual!.appendChild(svg);
    pieHoverBindings = bindings;
    applyPieHoverState();
  }

  function loadThree(): Promise<THREE> {
    if (threeLoadPromise) {
      return threeLoadPromise;
    }
    threeLoadPromise = import(/* @vite-ignore */ THREE_MODULE_URL)
      .then((module) => {
        if (
          module &&
          typeof module.Scene === "function" &&
          typeof module.WebGLRenderer === "function"
        ) {
          return module as THREE;
        }
        throw new Error(
          "viewer-three.module.js loaded but does not expose the expected Three.js API."
        );
      })
      .catch((error) => {
        threeLoadPromise = null;
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Failed to load local Three.js module (${THREE_MODULE_URL}): ${message}`
        );
      });
    return threeLoadPromise;
  }

  function renderThreeChart(chart: Chart): Promise<void> {
    const generation = renderGeneration;
    disposeThreeContext();
    clearVisual();

    const loading = document.createElement("div");
    loading.className = "chart-empty";
    loading.textContent = "Loading local Three.js renderer...";
    chartVisual!.appendChild(loading);
    chartStatus!.textContent = `${chart.status} · loading local Three.js`;
    renderLegend(chart);

    return loadThree()
      .then((THREE) => {
        if (
          generation !== renderGeneration ||
          !state.chartPanelOpen ||
          state.chartRenderMode !== "three3d" ||
          state.mainViewMode === "treemap"
        ) {
          return;
        }
        if (!chartVisual!.isConnected) {
          return;
        }
        clearVisual();

        const width = Math.max(1, chartVisual!.clientWidth);
        const height = Math.max(1, chartVisual!.clientHeight);
        const theme = api.currentThemeVisuals();
        const backgroundColor = new THREE.Color(
          api.mixHexColors(
            theme.canvasBase,
            theme.panel,
            theme.dark ? 0.18 : 0.26
          )
        );
        const floorColor = new THREE.Color(
          api.mixHexColors(
            theme.panel,
            theme.canvasBase,
            theme.dark ? 0.18 : 0.12
          )
        );
        const gridMajorColor = new THREE.Color(
          api.mixHexColors(
            theme.text,
            theme.canvasBase,
            theme.dark ? 0.22 : 0.14
          )
        );
        const gridMinorColor = new THREE.Color(
          api.mixHexColors(
            theme.textSoft,
            theme.canvasBase,
            theme.dark ? 0.12 : 0.08
          )
        );
        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.setSize(width, height, false);
        renderer.setClearColor(backgroundColor, theme.dark ? 0.2 : 0.12);
        renderer.domElement.className = "chart-three-canvas";
        renderer.domElement.setAttribute("aria-label", chart.mode === "coverage" ? `3D ${coverageLabel()} coverage, fixed 0 to 100 percent scale` : "3D structural statistics");
        renderer.domElement.style.width = "100%";
        renderer.domElement.style.height = "100%";
        renderer.domElement.style.display = "block";
        renderer.domElement.style.touchAction = "none";
        chartVisual!.appendChild(renderer.domElement);

        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(38, width / height, 0.1, 240);

        scene.add(new THREE.AmbientLight(0xffffff, 1.02));
        const hemisphere = new THREE.HemisphereLight(
          0xffffff,
          floorColor,
          theme.dark ? 0.92 : 0.98
        );
        scene.add(hemisphere);
        const keyLight = new THREE.DirectionalLight(0xffffff, 1.08);
        keyLight.position.set(-8, 15, 10);
        scene.add(keyLight);
        const fillLight = new THREE.DirectionalLight(0xffffff, 0.38);
        fillLight.position.set(10, 7, -8);
        scene.add(fillLight);
        const rimLight = new THREE.DirectionalLight(0xffffff, 0.54);
        rimLight.position.set(6, 11, 12);
        scene.add(rimLight);

        const raycaster = new THREE.Raycaster();
        const pointer = new THREE.Vector2();
        const labelSprites: THREESprite[] = [];
        const barLabels = new Map<number, THREESprite>();
        const barHeights = new Float32Array(chart.entries.length);
        let hoveredIndex = -1;
        let coverageAxis: InstanceType<THREE["LineSegments"]> | null = null;
        function fixedLabel(text: string, x: number, y: number, z: number, width: number, screenSpace = false) {
          const texture = makeLabelTexture(THREE, text, theme);
          if (!texture) return;
          const image = texture.image as HTMLCanvasElement;
          const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, sizeAttenuation: !screenSpace }));
          const labelHeight = screenSpace ? 22 * 2 * Math.tan(19 * Math.PI / 180) / height : width * image.height / image.width;
          const labelWidth = screenSpace ? labelHeight * image.width / image.height : width;
          sprite.scale.set(labelWidth, labelHeight, 1);
          if (screenSpace) sprite.center.set(1, 0.5);
          sprite.position.set(x, y, z);
          scene.add(sprite);
          labelSprites.push(sprite);
        }

        const columnCount = Math.max(1, Math.ceil(Math.sqrt(chart.entries.length)));
        const rowCount = Math.max(1, Math.ceil(chart.entries.length / columnCount));
        const cellSize =
          chart.entries.length <= 4 ? 2.2 : chart.entries.length <= 12 ? 1.72 : 1.34;
        const barSize = Math.max(0.56, cellSize * 0.72);
        const gapSize = Math.max(0.24, cellSize - barSize);
        const halfWidth = ((columnCount - 1) * cellSize) / 2;
        const halfDepth = ((rowCount - 1) * cellSize) / 2;
        const maxHeight = 10.5;
        const minHeight = 0.14;
        const baseThickness = 0.08;
        const extent = Math.max(columnCount * cellSize, rowCount * cellSize, maxHeight) + (chart.mode === "coverage" ? cellSize * 2 : 0);
        const viewState = ensureThreeView(extent, maxHeight);
        camera.far = Math.max(240, viewState.maxDistance + extent * 2);
        camera.updateProjectionMatrix();
        const labelDensityBias =
          chart.entries.length <= 12 ? 1.02 : chart.entries.length <= 36 ? 1.18 : 1.34;

        const floor = new THREE.Mesh(
          new THREE.BoxGeometry(
            columnCount * cellSize + gapSize * 2,
            baseThickness,
            rowCount * cellSize + gapSize * 2
          ),
          new THREE.MeshStandardMaterial({
            color: floorColor,
            roughness: 0.96,
            metalness: 0.03,
          })
        );
        floor.position.set(0, -baseThickness * 0.5, 0);
        scene.add(floor);

        const gridHelper = new THREE.GridHelper(
          Math.max(columnCount, rowCount) * cellSize + gapSize * 2,
          Math.max(columnCount, rowCount),
          gridMajorColor,
          gridMinorColor
        );
        gridHelper.position.y = 0.002;
        scene.add(gridHelper);

        if (chart.mode === "coverage") {
          const axisX = -halfWidth - cellSize;
          const axisZ = halfDepth + cellSize * 0.7;
          const points = [new THREE.Vector3(axisX, 0, axisZ), new THREE.Vector3(axisX, maxHeight, axisZ)];
          for (const percent of [0, 25, 50, 75, 100]) {
            const y = coverageBarHeight(percent, maxHeight);
            points.push(new THREE.Vector3(axisX - 0.1, y, axisZ), new THREE.Vector3(axisX + 0.22, y, axisZ));
            fixedLabel(`${percent}%`, axisX - 0.58, y, axisZ, 1.05, true);
          }
          coverageAxis = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color: theme.textSoft }));
          scene.add(coverageAxis);
        }

        const unitBarGeometry = new THREE.BoxGeometry(1, 1, 1);
        const barMaterial = new THREE.MeshStandardMaterial({ roughness: 0.54, metalness: 0.12 });
        const pedestalMaterial = new THREE.MeshStandardMaterial({ roughness: 0.94, metalness: 0.02 });
        // All bars share geometry and material; transforms and colors live in GPU buffers.
        const bars = new THREE.InstancedMesh(unitBarGeometry, barMaterial, chart.entries.length);
        const pedestals = new THREE.InstancedMesh(unitBarGeometry, pedestalMaterial, chart.entries.length);
        const matrix = new THREE.Matrix4();
        const color = new THREE.Color();
        chart.entries.forEach((entry, index) => {
          const x = (index % columnCount) * cellSize - halfWidth;
          const z = Math.floor(index / columnCount) * cellSize - halfDepth;
          const normalized = chart.mode === "coverage" ? 0 : threeBarVisualRatio(entry.value, chart.maxValue, chart.minValue);
          const barHeight = chart.mode === "coverage" ? coverageBarHeight(entry.value, maxHeight) : minHeight + normalized * (maxHeight - minHeight);
          barHeights[index] = barHeight;
          matrix.makeScale(barSize, barHeight, barSize).setPosition(x, barHeight * 0.5, z);
          bars.setMatrixAt(index, matrix);
          bars.setColorAt(index, color.set(entry.style.fill));
          matrix.makeScale(barSize * 1.06, baseThickness, barSize * 1.06).setPosition(
            x, chart.mode === "coverage" ? -baseThickness * 0.5 + 0.003 : baseThickness * 0.5, z
          );
          pedestals.setMatrixAt(index, matrix);
          pedestals.setColorAt(index, color.set(api.mixHexColors(theme.panel, entry.style.fill, theme.dark ? 0.14 : 0.1)));
        });
        bars.instanceMatrix.needsUpdate = true;
        pedestals.instanceMatrix.needsUpdate = true;
        bars.computeBoundingSphere();
        pedestals.computeBoundingSphere();
        scene.add(bars, pedestals);

        const orbitState = {
          get yaw() {
            return viewState.yaw;
          },
          set yaw(value: number) {
            viewState.yaw = value;
          },
          get pitch() {
            return viewState.pitch;
          },
          set pitch(value: number) {
            viewState.pitch = value;
          },
          get distance() {
            return viewState.distance;
          },
          set distance(value: number) {
            viewState.distance = value;
          },
          target: new THREE.Vector3(
            viewState.targetX,
            viewState.targetY,
            viewState.targetZ
          ),
          minDistance: viewState.minDistance,
          maxDistance: viewState.maxDistance,
        };
        const dragState = {
          active: false,
          mode: "pan" as "pan" | "orbit",
          moved: false,
          pointerId: null as number | null,
          pointerDownIndex: -1,
          lastX: 0,
          lastY: 0,
          suppressContextMenu: false,
        };

        function syncCamera(): void {
          viewState.targetX = orbitState.target.x;
          viewState.targetY = orbitState.target.y;
          viewState.targetZ = orbitState.target.z;
          const cosPitch = Math.cos(orbitState.pitch);
          const sinPitch = Math.sin(orbitState.pitch);
          camera.position.set(
            orbitState.target.x +
              orbitState.distance * sinPitch * Math.sin(orbitState.yaw),
            orbitState.target.y + orbitState.distance * cosPitch,
            orbitState.target.z +
              orbitState.distance * sinPitch * Math.cos(orbitState.yaw)
          );
          camera.lookAt(orbitState.target);
          camera.updateMatrixWorld();
        }

        const labelPosition = new THREE.Vector3();
        const visibleLabelIndices = new Set<number>();
        function disposeLabel(sprite: THREESprite): void {
          sprite.material.map?.dispose();
          sprite.material.dispose();
          scene.remove(sprite);
        }

        function updateLabelSprites(): void {
          const zoomFactor = extent / Math.max(orbitState.distance, 0.001);
          const revealBase = Math.max(0, Math.min(1, (zoomFactor - 0.9 * labelDensityBias) / 0.48));
          visibleLabelIndices.clear();
          if (hoveredIndex >= 0) visibleLabelIndices.add(hoveredIndex);
          // Labels are created only when readable, with a fixed budget even at Max depth.
          for (let index = 0; index < chart.entries.length && visibleLabelIndices.size < 80; index++) {
            const entry = chart.entries[index];
            const empty = chart.mode === "coverage" && (entry.coverageMissing || entry.value === 0);
            const reveal = revealBase * (0.24 + barHeights[index] / maxHeight * 0.74);
            if (!empty && reveal <= 0.22) continue;
            labelPosition.set((index % columnCount) * cellSize - halfWidth, barHeights[index] + 0.08, Math.floor(index / columnCount) * cellSize - halfDepth);
            const distance = labelPosition.distanceTo(camera.position);
            const projectedWidth = barSize * height / (2 * Math.tan(19 * Math.PI / 180) * distance);
            if (projectedWidth < 14) continue;
            labelPosition.project(camera);
            if (Math.abs(labelPosition.x) > 1 || Math.abs(labelPosition.y) > 1 || Math.abs(labelPosition.z) > 1) continue;
            visibleLabelIndices.add(index);
          }
          for (const [index, sprite] of barLabels) {
            if (visibleLabelIndices.has(index)) continue;
            disposeLabel(sprite);
            barLabels.delete(index);
          }
          for (const index of visibleLabelIndices) {
            let sprite = barLabels.get(index);
            const entry = chart.entries[index];
            const empty = chart.mode === "coverage" && (entry.coverageMissing || entry.value === 0);
            if (!sprite) {
              const text = empty ? entry.coverageMissing ? "No data" : "0%" : truncateLabel(entry.node.name || entry.node.module || "", Math.max(3, Math.floor(cellSize * 5.8)));
              if (!text) continue;
              const texture = makeLabelTexture(THREE, text, theme);
              if (!texture) continue;
              sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false }));
              const labelWidth = empty ? Math.min(barSize, 1) : Math.min(barSize * 0.72, Math.max(barSize * 0.34, 0.08 + text.length * 0.0085));
              const image = texture.image as HTMLCanvasElement;
              sprite.scale.set(labelWidth, labelWidth * image.height / image.width, 1);
              sprite.center.set(0.5, 0);
              sprite.position.set((index % columnCount) * cellSize - halfWidth, Math.max(0.16, barHeights[index] + 0.08), Math.floor(index / columnCount) * cellSize - halfDepth);
              sprite.renderOrder = 3;
              scene.add(sprite);
              barLabels.set(index, sprite);
            }
            sprite.material.opacity = hoveredIndex === index || empty ? 0.96 : Math.min(0.86, 0.12 + revealBase * 0.72);
          }
        }

        syncCamera();
        let renderFrameId = 0;
        function renderFrame(): void {
          renderFrameId ||= requestAnimationFrame(() => {
            renderFrameId = 0;
            updateLabelSprites();
            renderer.render(scene, camera);
          });
        }

        function setHoveredIndex(index: number): void {
          if (hoveredIndex === index) return;
          if (hoveredIndex >= 0) bars.setColorAt(hoveredIndex, color.set(chart.entries[hoveredIndex].style.fill));
          hoveredIndex = index;
          if (index >= 0) {
            const entry = chart.entries[index];
            bars.setColorAt(index, color.set(api.mixHexColors(entry.style.fill, "#ffffff", theme.dark ? 0.24 : 0.18)));
            if (!dragState.active) renderer.domElement.style.cursor = "pointer";
            showNodeDetails(entry, chart);
          } else {
            renderer.domElement.style.cursor = dragState.active ? "grabbing" : "grab";
            clearNodeDetails();
          }
          bars.instanceColor!.needsUpdate = true;
          renderFrame();
        }

        const pickingGrid = { heights: barHeights, columns: columnCount, cellSize, barSize, baseThickness, coverage: chart.mode === "coverage" };
        function pickIndex(event: PointerEvent): number {
          const rect = renderer.domElement.getBoundingClientRect();
          pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
          pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
          raycaster.setFromCamera(pointer, camera);
          return pickBarGrid(raycaster.ray.origin, raycaster.ray.direction, pickingGrid);
        }

        function panCamera(dx: number, dy: number): void {
          const panScale = orbitState.distance * 0.00135;
          const sinYaw = Math.sin(orbitState.yaw);
          const cosYaw = Math.cos(orbitState.yaw);
          orbitState.target.x -= (dx * cosYaw + dy * sinYaw) * panScale;
          orbitState.target.z += (dx * sinYaw - dy * cosYaw) * panScale;
        }

        let hoverFrame = 0;
        let hoverEvent: PointerEvent | null = null;
        function cancelHoverPick(): void {
          cancelAnimationFrame(hoverFrame);
          hoverFrame = 0;
          hoverEvent = null;
        }

        const handlePointerDown = (event: PointerEvent): void => {
          if (event.button !== 0 && event.button !== 1 && event.button !== 2) {
            return;
          }
          cancelHoverPick();
          const downIndex = event.button === 0 ? pickIndex(event) : -1;
          dragState.active = true;
          dragState.mode =
            event.button === 2 || event.altKey || event.ctrlKey ? "orbit" : "pan";
          dragState.moved = false;
          dragState.suppressContextMenu = false;
          dragState.pointerId = event.pointerId;
          dragState.pointerDownIndex = downIndex;
          dragState.lastX = event.clientX;
          dragState.lastY = event.clientY;
          renderer.domElement.style.cursor =
            dragState.mode === "orbit" ? "grabbing" : "grab";
          renderer.domElement.setPointerCapture(event.pointerId);
          event.preventDefault();
        };

        const handlePointerMove = (event: PointerEvent): void => {
          if (dragState.active && dragState.pointerId === event.pointerId) {
            const dx = event.clientX - dragState.lastX;
            const dy = event.clientY - dragState.lastY;
            if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
              dragState.moved = true;
              if (dragState.mode === "orbit") {
                dragState.suppressContextMenu = true;
              }
              renderer.domElement.style.cursor = "grabbing";
            }
            dragState.lastX = event.clientX;
            dragState.lastY = event.clientY;
            if (dragState.mode === "pan") {
              panCamera(dx, dy);
            } else {
              orbitState.yaw -= dx * 0.0058;
              orbitState.pitch = Math.max(
                0.28,
                Math.min(Math.PI * 0.49, orbitState.pitch + dy * 0.0048)
              );
            }
            syncCamera();
            renderFrame();
            return;
          }
          hoverEvent = event;
          hoverFrame ||= requestAnimationFrame(() => {
            hoverFrame = 0;
            if (hoverEvent) setHoveredIndex(pickIndex(hoverEvent));
            hoverEvent = null;
          });
        };

        const handlePointerUp = (event: PointerEvent): void => {
          if (!dragState.active || dragState.pointerId !== event.pointerId) {
            return;
          }
          const moved = dragState.moved;
          const downIndex = dragState.pointerDownIndex;
          dragState.active = false;
          dragState.moved = false;
          dragState.pointerId = null;
          dragState.pointerDownIndex = -1;
          renderer.domElement.style.cursor = "grab";
          if (renderer.domElement.hasPointerCapture(event.pointerId)) {
            renderer.domElement.releasePointerCapture(event.pointerId);
          }
          if (!moved && event.button === 0 && event.type !== "pointercancel") {
            const index = downIndex >= 0 ? downIndex : pickIndex(event);
            if (index >= 0) {
              api.focusNodeInMainView(chart.entries[index].id);
              return;
            }
          }
          setHoveredIndex(pickIndex(event));
        };

        const handlePointerLeave = (): void => {
          cancelHoverPick();
          if (!dragState.active) {
            setHoveredIndex(-1);
          }
        };

        const handleWheel = (event: WheelEvent): void => {
          event.preventDefault();
          const zoomFactor = event.deltaY < 0 ? 1 / 1.14 : 1.14;
          orbitState.distance = Math.max(
            orbitState.minDistance,
            Math.min(orbitState.maxDistance, orbitState.distance * zoomFactor)
          );
          syncCamera();
          renderFrame();
        };

        const handleContextMenu = (event: Event): void => {
          if (dragState.suppressContextMenu || dragState.active) {
            event.preventDefault();
            event.stopPropagation();
            dragState.suppressContextMenu = false;
          }
        };

        function applyToolbarZoom(factor: number): void {
          orbitState.distance = Math.max(
            orbitState.minDistance,
            Math.min(
              orbitState.maxDistance,
              orbitState.distance / Math.max(factor, 0.0001)
            )
          );
          syncCamera();
          renderFrame();
        }

        function applyToolbarFit(): void {
          const next = resetThreeView(extent, maxHeight);
          orbitState.yaw = next.yaw;
          orbitState.pitch = next.pitch;
          orbitState.distance = next.distance;
          orbitState.minDistance = next.minDistance;
          orbitState.maxDistance = next.maxDistance;
          orbitState.target.set(next.targetX, next.targetY, next.targetZ);
          syncCamera();
          renderFrame();
        }

        renderer.domElement.addEventListener("pointerdown", handlePointerDown);
        renderer.domElement.addEventListener("pointermove", handlePointerMove);
        renderer.domElement.addEventListener("pointerup", handlePointerUp);
        renderer.domElement.addEventListener("pointerleave", handlePointerLeave);
        renderer.domElement.addEventListener("wheel", handleWheel, { passive: false });
        renderer.domElement.addEventListener("pointercancel", handlePointerUp);
        renderer.domElement.addEventListener("contextmenu", handleContextMenu);
        renderer.domElement.style.cursor = "grab";
        renderFrame();

        threeContext = {
          zoomByFactor: applyToolbarZoom,
          fitView: applyToolbarFit,
          zoomLabel() {
            return currentThreeZoomLabel();
          },
          hintText() {
            return "3D view: drag to pan. Right-drag to orbit. Wheel or toolbar +/- to zoom. Fit resets the camera. Right-click returns to the parent hierarchy.";
          },
          dispose() {
            renderer.domElement.removeEventListener("pointerdown", handlePointerDown);
            renderer.domElement.removeEventListener("pointermove", handlePointerMove);
            renderer.domElement.removeEventListener("pointerup", handlePointerUp);
            renderer.domElement.removeEventListener("pointerleave", handlePointerLeave);
            renderer.domElement.removeEventListener("wheel", handleWheel);
            renderer.domElement.removeEventListener("pointercancel", handlePointerUp);
            renderer.domElement.removeEventListener("contextmenu", handleContextMenu);
            cancelAnimationFrame(renderFrameId);
            cancelHoverPick();
            bars.dispose();
            pedestals.dispose();
            barMaterial.dispose();
            pedestalMaterial.dispose();
            labelSprites.forEach(disposeLabel);
            barLabels.forEach(disposeLabel);
            barLabels.clear();
            if (coverageAxis) {
              coverageAxis.geometry.dispose();
              if (Array.isArray(coverageAxis.material)) coverageAxis.material.forEach(material => material.dispose());
              else coverageAxis.material.dispose();
              scene.remove(coverageAxis);
            }
            unitBarGeometry.dispose();
            floor.geometry.dispose();
            floor.material.dispose();
            scene.remove(floor);
            gridHelper.geometry.dispose();
            if (Array.isArray(gridHelper.material)) {
              gridHelper.material.forEach((material) => material.dispose());
            } else {
              gridHelper.material.dispose();
            }
            scene.remove(gridHelper);
            scene.clear();
            clearNodeDetails();
            renderer.dispose();
            chartVisual!.replaceChildren();
          },
        };

        chartStatus!.textContent = `${chart.status} · 3D ready`;
      })
      .catch((error) => {
        if (generation !== renderGeneration) return;
        disposeThreeContext();
        renderEmpty(error.message || "Failed to initialize local Three.js.");
        chartStatus!.textContent = `3D unavailable: ${error.message || error}`;
      });
  }

  function renderChart(force = false): void {
    syncControls();
    if (!state.chartPanelOpen) {
      renderGeneration++;
      disposeThreeContext();
      clearVisual();
      disposeLegend?.();
      disposeLegend = null;
      legendElements.clear();
      chartLegend!.replaceChildren();
      clearHoverState();
      clearNodeDetails();
      return;
    }

    const signature = currentSignature();
    if (!force && !state.chartPanelDirty && signature === lastRenderSignature && lastCoverage === state.coverage) {
      return;
    }
    state.chartPanelDirty = false;
    lastRenderSignature = signature;
    lastCoverage = state.coverage;
    renderGeneration++;
    clearNodeDetails();

    const chart = buildChart();
    if ("emptyMessage" in chart) {
      chartStatus!.textContent = chart.emptyMessage || chart.status;
      renderEmpty(chart.emptyMessage);
      return;
    }

    chartStatus!.textContent = chart.status;
    if (state.chartRenderMode === "three3d") {
      renderThreeChart(chart);
      return;
    }
    renderPie2d(chart);
  }

  chartModeSelect.addEventListener("change", () => {
    state.chartMode =
      chartModeSelect!.value === "coverage" ? "coverage" : chartModeSelect!.value === "analysis" ? "analysis" : "weighted_bits";
    invalidate();
    api.savePersistedState();
    api.requestDraw();
  });

  chartLevelSelect.addEventListener("change", () => {
    state.chartLevel =
      chartLevelSelect.value === "max"
        ? null
        : Math.max(1, Number.parseInt(chartLevelSelect.value, 10) || 1);
    invalidate();
    api.savePersistedState();
    api.requestDraw();
  });

  chartAnalysisSelect.addEventListener("change", () => {
    state.analysisMode = chartAnalysisSelect!.value as AnalysisMode;
    api.buildSignalAnalysis();
    api.syncAnalysisControls();
    invalidate();
    api.savePersistedState();
    api.requestDraw();
  });

  chartAnalysisPatternModeSelect.addEventListener("change", () => {
    state.analysisPatternMode = chartAnalysisPatternModeSelect.value as typeof state.analysisPatternMode;
    api.buildSignalAnalysis();
    api.syncAnalysisControls();
    invalidate();
    api.savePersistedState();
    api.requestDraw();
  });

  chartAnalysisPatternInput.addEventListener("input", () => {
    state.analysisPattern = chartAnalysisPatternInput.value;
    api.buildSignalAnalysis();
    api.syncAnalysisControls();
    invalidate();
    api.savePersistedState();
    api.requestDraw();
  });

  if (typeof window.registerSearchHistoryInput === "function") {
    window.registerSearchHistoryInput(
      chartAnalysisPatternInput,
      "analysis-pattern",
      {
        apply: (value) => {
          if (typeof window.applySharedAnalysisPatternValue === "function") {
            window.applySharedAnalysisPatternValue(
              value,
              chartAnalysisPatternInput
            );
            invalidate();
            api.requestDraw();
            return;
          }
          state.analysisPattern = value;
          chartAnalysisPatternInput.value = value;
          const peer = document.getElementById(
            "analysis-pattern-input"
          ) as HTMLInputElement | null;
          if (peer && peer !== chartAnalysisPatternInput) {
            peer.value = value;
          }
          api.buildSignalAnalysis();
          api.syncAnalysisControls();
          invalidate();
          api.savePersistedState();
          api.requestDraw();
        },
        getValue: () => state.analysisPattern,
      }
    );
  }

  if (typeof ResizeObserver === "function") {
    chartResizeObserver = new ResizeObserver(() => {
      if (!state.chartPanelOpen) {
        return;
      }
      invalidate();
      renderChart(true);
    });
    chartResizeObserver.observe(chartVisual);
  }

  chartLayoutDivider.addEventListener("mousedown", (event) => {
    if (event.button !== 0 || !state.chartPanelOpen) {
      return;
    }
    draggingChartSplit = true;
    chartLayout.classList.add("resizing");
    updateChartSplitFromPointer(event);
    event.preventDefault();
  });

  chartVisual.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    const parentId = api.visibleParent(state.currentRoot);
    if (parentId !== null && parentId !== undefined) {
      clearHoverState();
      api.setRootAndReset(parentId);
    }
  });

  window.addEventListener("mouseup", () => {
    if (draggingChartSplit) {
      draggingChartSplit = false;
      chartLayout.classList.remove("resizing");
    }
    if (pieViewState && pieViewState.dragging) {
      const hadMoved = pieViewState.dragMoved;
      pieViewState.dragging = false;
      pieViewState.dragMoved = false;
      if (hadMoved) {
        refreshPieView?.();
        window.setTimeout(() => {
          if (pieViewState) {
            pieViewState.suppressClick = false;
          }
        }, 0);
      } else {
        pieViewState.suppressClick = false;
      }
    }
  });

  window.addEventListener("mousemove", (event) => {
    if (!draggingChartSplit) {
      return;
    }
    updateChartSplitFromPointer(event);
  });

  function zoomByFactor(factor: number): boolean {
    if (
      state.mainViewMode === "three3d" &&
      threeContext &&
      typeof threeContext.zoomByFactor === "function"
    ) {
      threeContext.zoomByFactor(factor);
      api.savePersistedState();
      api.requestDraw();
      return true;
    }
    if (state.mainViewMode === "pie2d" && pieViewState) {
      const width = pieViewState.baseW;
      const height = pieViewState.baseH;
      const targetW = Math.max(
        width / 18,
        Math.min(width, pieViewState.w / Math.max(factor, 0.0001))
      );
      const targetH = Math.max(
        height / 18,
        Math.min(height, pieViewState.h / Math.max(factor, 0.0001))
      );
      const centerX = pieViewState.x + pieViewState.w * 0.5;
      const centerY = pieViewState.y + pieViewState.h * 0.5;
      pieViewState.w = targetW;
      pieViewState.h = targetH;
      pieViewState.x = centerX - targetW * 0.5;
      pieViewState.y = centerY - targetH * 0.5;
      clampPieView();
      refreshPieView?.();
      api.savePersistedState();
      api.requestDraw();
      return true;
    }
    return false;
  }

  function fitView(): boolean {
    if (
      state.mainViewMode === "three3d" &&
      threeContext &&
      typeof threeContext.fitView === "function"
    ) {
      threeContext.fitView();
      api.savePersistedState();
      api.requestDraw();
      return true;
    }
    if (state.mainViewMode === "pie2d") {
      resetPieView(
        pieViewState?.baseW ?? Math.max(560, chartVisual!.clientWidth || 560),
        pieViewState?.baseH ?? Math.max(360, chartVisual!.clientHeight || 360)
      );
      refreshPieView?.();
      api.savePersistedState();
      api.requestDraw();
      return true;
    }
    return false;
  }

  function viewStatus(): ViewStatus | null {
    if (state.mainViewMode === "three3d") {
      return {
        zoomLabel:
          threeContext && typeof threeContext.zoomLabel === "function"
            ? threeContext.zoomLabel()
            : currentThreeZoomLabel(),
        hintText:
          threeContext && typeof threeContext.hintText === "function"
            ? threeContext.hintText()
            : "3D view: drag to pan. Right-drag to orbit. Wheel or toolbar +/- to zoom. Fit resets the camera. Right-click returns to the parent hierarchy.",
      };
    }
    if (state.mainViewMode === "pie2d") {
      return {
        zoomLabel: `${currentPieZoom().toFixed(2)}x`,
        hintText:
          "2D pie: drag to pan. Wheel or toolbar +/- to zoom. Fit resets the view. Right-click returns to the parent hierarchy.",
      };
    }
    return null;
  }

  return {
    invalidate,
    zoomByFactor,
    fitView,
    viewStatus,
    render() {
      renderChart(false);
    },
  };
}

window.initHierarchyCharts = initHierarchyCharts;
