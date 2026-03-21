(function () {
  const THREE_MODULE_URL = new URL("./viewer-three.module.js", window.location.href).href;

  function escapeHtml(text) {
    return String(text ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function svgNode(tag) {
    return document.createElementNS("http://www.w3.org/2000/svg", tag);
  }

  function polar(cx, cy, radius, angle) {
    return {
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius
    };
  }

  function donutPath(cx, cy, innerRadius, outerRadius, startAngle, endAngle) {
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
      "Z"
    ].join(" ");
  }

  function fullDonutPath(cx, cy, innerRadius, outerRadius) {
    return [
      `M ${cx + outerRadius} ${cy}`,
      `A ${outerRadius} ${outerRadius} 0 1 1 ${cx - outerRadius} ${cy}`,
      `A ${outerRadius} ${outerRadius} 0 1 1 ${cx + outerRadius} ${cy}`,
      `M ${cx + innerRadius} ${cy}`,
      `A ${innerRadius} ${innerRadius} 0 1 0 ${cx - innerRadius} ${cy}`,
      `A ${innerRadius} ${innerRadius} 0 1 0 ${cx + innerRadius} ${cy}`,
      "Z"
    ].join(" ");
  }

  function formatPercent(value) {
    if (!Number.isFinite(value) || value <= 0) {
      return "0%";
    }
    const percent = value * 100;
    if (percent >= 10) {
      return `${percent.toFixed(1)}%`;
    }
    return `${percent.toFixed(2)}%`;
  }

  function truncateLabel(text, maxChars) {
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

  function makeLabelTexture(THREE, text, theme) {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return null;
    }

    const pixelRatio = Math.max(2, Math.ceil(window.devicePixelRatio || 1));
    const fontSize = 26;
    const horizontalPadding = 18;
    const verticalPadding = 12;
    const fontSpec = `700 ${fontSize}px "Iowan Old Style", "Palatino Linotype", "Book Antiqua", Georgia, serif`;
    ctx.font = fontSpec;
    const metrics = ctx.measureText(text);
    const textWidth = Math.max(1, Math.ceil(metrics.width));
    canvas.width = (textWidth + horizontalPadding * 2) * pixelRatio;
    canvas.height = (fontSize + verticalPadding * 2) * pixelRatio;

    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    ctx.font = fontSpec;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.clearRect(0, 0, textWidth + horizontalPadding * 2, fontSize + verticalPadding * 2);
    ctx.fillStyle = theme.dark ? "rgba(10, 14, 24, 0.96)" : "rgba(255, 252, 247, 0.96)";
    ctx.strokeStyle = theme.dark ? "rgba(225, 233, 255, 0.48)" : "rgba(54, 34, 18, 0.24)";
    ctx.lineWidth = 1.5;
    const logicalHeight = fontSize + verticalPadding * 2;
    const logicalWidth = textWidth + horizontalPadding * 2;
    const radius = Math.min(14, logicalHeight * 0.36);
    ctx.beginPath();
    ctx.moveTo(radius, 0);
    ctx.lineTo(logicalWidth - radius, 0);
    ctx.quadraticCurveTo(logicalWidth, 0, logicalWidth, radius);
    ctx.lineTo(logicalWidth, logicalHeight - radius);
    ctx.quadraticCurveTo(logicalWidth, logicalHeight, logicalWidth - radius, logicalHeight);
    ctx.lineTo(radius, logicalHeight);
    ctx.quadraticCurveTo(0, logicalHeight, 0, logicalHeight - radius);
    ctx.lineTo(0, radius);
    ctx.quadraticCurveTo(0, 0, radius, 0);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.shadowColor = theme.dark ? "rgba(0, 0, 0, 0.38)" : "rgba(255, 255, 255, 0.7)";
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

  function valueDisplay(entry, chart) {
    if (chart.mode === "analysis" && chart.analysisMode === "ratio") {
      return `${chart.formatValue(entry.value * 100)}%`;
    }
    return chart.formatValue(entry.value);
  }

  function totalCaption(chart) {
    return chart.mode === "analysis" && chart.analysisMode === "ratio"
      ? "aggregate"
      : "total";
  }

  window.initHierarchyCharts = function initHierarchyCharts(api) {
    const chartPanel = document.getElementById("chart-panel");
    const chartPanelSubtitle = document.getElementById("chart-panel-subtitle");
    const chartLayout = chartPanel ? chartPanel.querySelector(".chart-layout") : null;
    const chartLayoutDivider = document.getElementById("chart-layout-divider");
    const chartModeSelect = document.getElementById("chart-mode-select");
    const chartLevelSelect = document.getElementById("chart-level-select");
    const chartAnalysisEditor = document.getElementById("chart-analysis-editor");
    const chartAnalysisSelect = document.getElementById("chart-analysis-select");
    const chartAnalysisPatternModeSelect = document.getElementById("chart-analysis-pattern-mode-select");
    const chartAnalysisPatternInput = document.getElementById("chart-analysis-pattern-input");
    const chartAnalysisPatternModeField = chartAnalysisPatternModeSelect
      ? chartAnalysisPatternModeSelect.closest(".metric-group")
      : null;
    const chartAnalysisPatternInputField = chartAnalysisPatternInput
      ? chartAnalysisPatternInput.closest(".metric-group")
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
    let lastLevelSignature = "";
    let chartResizeObserver = null;
    let threeLoadPromise = null;
    let threeContext = null;
    let hoveredSliceId = null;
    let pieHoverBindings = null;
    let pieViewState = null;
    let lastPieDataKey = "";
    let threeViewState = null;
    let lastThreeDataKey = "";
    let draggingChartSplit = false;
    let chartSplitRatio = 0.65;

    function clearHoverState() {
      hoveredSliceId = null;
    }

    function formatLocation(node) {
      if (!node || !node.filePath) {
        return "Source location unavailable";
      }
      const line = node.line || 1;
      const column = node.column || 1;
      return `${node.filePath}:${line}:${column}`;
    }

    function detailMetaLine(label, value) {
      return `<div><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</div>`;
    }

    function showNodeDetails(entry, chart) {
      if (!entry || !entry.node) {
        return;
      }
      const node = entry.node;
      chartDetailPath.textContent = node.path || "(root)";
      chartDetailTitle.textContent = `${node.name} <${node.module}>`;
      chartDetailMeta.innerHTML = [
        detailMetaLine("Module", node.module),
        detailMetaLine("Area", `${formatPercent(entry.fraction)} · ${valueDisplay(entry, chart)}`)
      ].join("");
      chartDetailCard.classList.remove("hidden");
    }

    function clearNodeDetails() {
      chartDetailCard.classList.add("hidden");
      chartDetailPath.textContent = "";
      chartDetailTitle.textContent = "";
      chartDetailMeta.innerHTML = "";
    }

    function clearPieHoverBindings() {
      pieHoverBindings = null;
    }

    function pieDataKey() {
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
        chartVisual.clientWidth,
        chartVisual.clientHeight
      ]);
    }

    function resetPieView(width, height) {
      pieViewState = {
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
        suppressClick: false
      };
    }

    function ensurePieView(width, height) {
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
      return pieViewState;
    }

    function threeDataKey() {
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
        chartVisual.clientWidth,
        chartVisual.clientHeight
      ]);
    }

    function createThreeViewState(extent, maxHeight) {
      const fitDistance = Math.max(10.5, extent * 1.18);
      return {
        yaw: 0.72,
        pitch: 1.06,
        distance: fitDistance,
        targetX: 0,
        targetY: Math.min(2.2, Math.max(0.7, maxHeight * 0.15)),
        targetZ: 0,
        minDistance: Math.max(2.8, extent * 0.18),
        maxDistance: Math.max(22, extent * 7.2),
        fitDistance
      };
    }

    function ensureThreeView(extent, maxHeight) {
      const key = threeDataKey();
      if (!threeViewState || lastThreeDataKey !== key) {
        threeViewState = createThreeViewState(extent, maxHeight);
        lastThreeDataKey = key;
      } else {
        threeViewState.minDistance = Math.max(2.8, extent * 0.18);
        threeViewState.maxDistance = Math.max(22, extent * 7.2);
        threeViewState.fitDistance = Math.max(10.5, extent * 1.18);
        threeViewState.targetY = Math.min(2.2, Math.max(0.7, maxHeight * 0.15));
      }
      return threeViewState;
    }

    function resetThreeView(extent, maxHeight) {
      threeViewState = createThreeViewState(extent, maxHeight);
      lastThreeDataKey = threeDataKey();
      return threeViewState;
    }

    function currentThreeZoomLabel() {
      if (!threeViewState || !threeViewState.fitDistance) {
        return "1.00x";
      }
      return `${(threeViewState.fitDistance / Math.max(threeViewState.distance, 0.0001)).toFixed(2)}x`;
    }

    function currentPieZoom() {
      if (!pieViewState) {
        return 1;
      }
      return pieViewState.baseW / pieViewState.w;
    }

    function clampPieView() {
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

    function clearVisual() {
      chartVisual.replaceChildren();
    }

    function disposeThreeContext() {
      if (!threeContext) {
        return;
      }
      if (typeof threeContext.dispose === "function") {
        threeContext.dispose();
      }
      threeContext = null;
    }

    function invalidate() {
      state.chartPanelDirty = true;
      lastRenderSignature = "";
    }

    function chartLayoutIsVertical() {
      return window.matchMedia("(max-width: 800px)").matches;
    }

    function applyChartSplitRatio() {
      const visualRatio = Math.max(0.22, Math.min(0.82, chartSplitRatio));
      const legendRatio = Math.max(0.18, 1 - visualRatio);
      chartLayout.style.setProperty("--chart-visual-fr", `${visualRatio}fr`);
      chartLayout.style.setProperty("--chart-legend-fr", `${legendRatio}fr`);
    }

    function updateChartSplitFromPointer(event) {
      const rect = chartLayout.getBoundingClientRect();
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

    function levelMax() {
      return Math.max(0, api.currentMaxDepth());
    }

    function clampChartLevel() {
      const maxDepth = levelMax();
      if (maxDepth <= 0) {
        state.chartLevel = null;
        return state.chartLevel;
      }
      if (state.chartLevel === null || state.chartLevel === undefined) {
        state.chartLevel = null;
        return state.chartLevel;
      }
      const rawLevel = Number.isInteger(state.chartLevel) ? state.chartLevel : maxDepth;
      state.chartLevel = Math.max(1, Math.min(maxDepth, rawLevel));
      return state.chartLevel;
    }

    function chartLevelValue() {
      const maxDepth = levelMax();
      const level = clampChartLevel();
      if (maxDepth <= 0) {
        return 0;
      }
      return level === null ? maxDepth : level;
    }

    function chartLevelLabel() {
      const maxDepth = levelMax();
      const level = clampChartLevel();
      if (maxDepth <= 0) {
        return "Max";
      }
      return level === null ? `Max (${maxDepth})` : String(level);
    }

    function filterActive() {
      return (state.search || "").trim().length > 0;
    }

    function syncLevelOptions() {
      const maxDepth = levelMax();
      const signature = `${state.currentRoot}:${maxDepth}`;
      if (signature !== lastLevelSignature) {
        chartLevelSelect.innerHTML = "";
        const maxOption = document.createElement("option");
        maxOption.value = "max";
        maxOption.textContent = maxDepth > 0 ? `Max (${maxDepth})` : "Max";
        chartLevelSelect.appendChild(maxOption);
        for (let level = 1; level <= maxDepth; level += 1) {
          const option = document.createElement("option");
          option.value = String(level);
          option.textContent = String(level);
          chartLevelSelect.appendChild(option);
        }
        lastLevelSignature = signature;
      }
      chartLevelSelect.value = clampChartLevel() === null ? "max" : String(state.chartLevel);
      chartLevelSelect.disabled = maxDepth === 0;
    }

    function syncControls() {
      chartPanel.classList.toggle("active", !!state.chartPanelOpen);
      chartModeSelect.value = state.chartMode;
      chartAnalysisEditor.classList.toggle("hidden", state.chartMode !== "analysis");
      chartAnalysisSelect.value = state.analysisMode;
      chartAnalysisPatternModeSelect.value = state.analysisPatternMode;
      chartAnalysisPatternInput.value = state.analysisPattern;
      const usesSignalPattern = state.analysisMode === "count" || state.analysisMode === "ratio";
      if (chartAnalysisPatternModeField) {
        chartAnalysisPatternModeField.classList.toggle("hidden", !usesSignalPattern);
      }
      if (chartAnalysisPatternInputField) {
        chartAnalysisPatternInputField.classList.toggle("hidden", !usesSignalPattern);
      }
      chartAnalysisPatternModeSelect.disabled = !usesSignalPattern;
      chartAnalysisPatternInput.disabled = !usesSignalPattern;
      chartAnalysisPatternModeSelect.title = "Choose wildcard, text, or regex matching for signal names.";
      chartAnalysisPatternInput.title = "Use ';' to combine multiple signal-name patterns. Example: _GEN* ; foo_*";
      chartLevelSelect.title = "Level follows treemap semantics: descend from the current root up to this depth, and keep leaf nodes that end earlier.";
      syncLevelOptions();
      applyChartSplitRatio();
    }

    function buildBreadcrumbChain() {
      const chain = [];
      let cursor = state.currentRoot;
      while (cursor !== null && cursor !== undefined) {
        chain.push(cursor);
        cursor = api.visibleParent(cursor);
      }
      chain.reverse();
      return chain;
    }

    function renderChartBreadcrumbs() {
      const chain = buildBreadcrumbChain();
      chartCrumbs.innerHTML = "";
      const fragment = document.createDocumentFragment();
      chain.forEach((nodeId, index) => {
        const node = api.getNode(nodeId);
        const button = document.createElement("button");
        button.type = "button";
        button.className = "chart-crumb" + (index === chain.length - 1 ? " current" : "");
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
      chartCrumbs.appendChild(fragment);
    }

    function applyPieHoverState() {
      if (!pieHoverBindings) {
        return;
      }
      for (const binding of pieHoverBindings) {
        const active = hoveredSliceId === binding.id;
        binding.slice.classList.toggle("active", active);
        binding.slice.setAttribute("stroke-width", active ? "2.5" : "1.25");
        binding.slice.style.transform = binding.transform(active);
        if (binding.legend) {
          binding.legend.classList.toggle("active", active);
        }
      }
    }

    function currentSignature() {
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
        chartVisual.clientWidth,
        chartVisual.clientHeight
      ]);
    }

    function isBranchIncluded(nodeId, matchedAncestor) {
      if (!filterActive()) {
        return true;
      }
      return matchedAncestor || state.matchIds.has(nodeId) || state.matchSubtreeIds.has(nodeId);
    }

    function collectLevelNodes(rootId, relativeLevel) {
      const result = [];

      function walk(nodeId, depth, matchedAncestor) {
        const node = api.getNode(nodeId);
        const nextMatchedAncestor = matchedAncestor || state.matchIds.has(nodeId);
        if (!isBranchIncluded(nodeId, nextMatchedAncestor)) {
          return;
        }
        // Mirror treemap level semantics instead of exact-depth slicing.
        // Once a branch reaches the requested depth, or it terminates early,
        // that node becomes the frontier entry shown by chart views.
        if (depth >= relativeLevel || !node.children.length) {
          result.push(nodeId);
          return;
        }
        for (const childId of node.children) {
          walk(childId, depth + 1, nextMatchedAncestor);
        }
      }

      walk(rootId, 0, false);
      return result;
    }

    function analysisValue(nodeId) {
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

    function buildEntryStyle(entry, index, maxValue, mode) {
      const theme = api.currentThemeVisuals();
      if (mode === "analysis") {
        const ramp = theme.analysisRamp || [theme.match];
        const normalized = maxValue > 0 ? entry.value / maxValue : 0;
        const bucketIndex = Math.max(
          0,
          Math.min(ramp.length - 1, Math.floor(normalized * ramp.length * 0.999))
        );
        const accent = ramp[bucketIndex];
        return {
          fill: api.mixHexColors(theme.canvasBase, accent, theme.dark ? 0.62 : 0.56),
          stroke: api.mixHexColors(theme.text, accent, theme.dark ? 0.52 : 0.46),
          background: api.hexToRgba(api.mixHexColors(theme.panel, accent, theme.dark ? 0.22 : 0.18), 0.94)
        };
      }

      const accent = api.themeNodeAccent(index);
      return {
        fill: api.mixHexColors(theme.canvasBase, accent, theme.dark ? 0.62 : 0.54),
        stroke: api.mixHexColors(theme.text, accent, theme.dark ? 0.46 : 0.38),
        background: api.hexToRgba(api.mixHexColors(theme.panel, accent, theme.dark ? 0.22 : 0.16), 0.94)
      };
    }

    function modeSummary(mode, analysisMode) {
      if (mode === "analysis") {
        if (analysisMode === "ratio") return "Analysis Pattern Ratio";
        if (analysisMode === "loc") return "Module LOC";
        return "Analysis Pattern Count";
      }
      return "Weighted Signal Bits";
    }

    function buildChart() {
      const root = api.getNode(state.currentRoot);
      const selectedLevel = chartLevelValue();
      const mode = state.chartMode;
      const analysisMode = state.analysisMode === "ratio"
        ? "ratio"
        : state.analysisMode === "loc"
          ? "loc"
          : "count";
      chartPanelSubtitle.textContent = `${root.path || "(root)"} · ${modeSummary(mode, analysisMode)} · level ${chartLevelLabel()}`;
      renderChartBreadcrumbs();

      if (mode === "analysis" && !api.analysisActive()) {
        return {
          emptyMessage: state.analysisError || "Analysis Pattern is not active. Configure it in Advanced first.",
          status: "Analysis Pattern is currently disabled."
        };
      }

      const nodeIds = collectLevelNodes(state.currentRoot, selectedLevel);
      if (!nodeIds.length) {
        return {
          emptyMessage: filterActive()
            ? "No hierarchy nodes remain at this level after the current filter is applied."
            : "No hierarchy nodes are available at this level.",
          status: filterActive() ? "Filter active: 0 visible slices." : "0 visible slices."
        };
      }

      const entries = nodeIds
        .map((nodeId) => {
          const node = api.getNode(nodeId);
          const value = mode === "analysis"
            ? analysisValue(nodeId)
            : api.subtreeWeightedBits(node);
          return {
            id: nodeId,
            node,
            value
          };
        })
        .filter((entry) => entry.value > 0);

      if (!entries.length) {
        return {
          emptyMessage: mode === "analysis"
            ? "The current Analysis Pattern produced zero visible values at this level."
            : "Weighted bits are zero for all visible hierarchy nodes at this level.",
          status: "0 non-zero slices."
        };
      }

      entries.sort((left, right) => right.value - left.value);
      const total = entries.reduce((sum, entry) => sum + entry.value, 0);
      const maxValue = entries.reduce((max, entry) => Math.max(max, entry.value), 0);
      const minValue = entries.reduce((min, entry) => Math.min(min, entry.value), Number.POSITIVE_INFINITY);
      const chart = {
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
            style
          };
        })
      };
      chart.status = `${chart.entries.length} slices · level ${chartLevelLabel()} · ${totalCaption(chart)} ${valueDisplay({ value: total }, chart)}${filterActive() ? " · filter active" : ""}`;
      return chart;
    }

    function threeBarVisualRatio(value, chart) {
      const maxValue = Math.max(chart.maxValue || 0, 0);
      if (!(maxValue > 0) || !(value > 0)) {
        return 0;
      }

      const minValue = Math.max(chart.minValue || 0, Number.MIN_VALUE);
      const rawRatio = Math.max(0, Math.min(1, value / maxValue));
      const dynamicRange = maxValue / minValue;
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

    function renderEmpty(message) {
      disposeThreeContext();
      clearVisual();
      clearNodeDetails();
      const empty = document.createElement("div");
      empty.className = "chart-empty";
      empty.textContent = message;
      chartVisual.appendChild(empty);
      chartLegend.innerHTML = '<div class="side-empty">Nothing to show.</div>';
    }

    function renderLegend(chart) {
      chartLegend.innerHTML = "";
      const legendMap = new Map();
      const fragment = document.createDocumentFragment();
      for (const entry of chart.entries) {
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

        const value = document.createElement("span");
        value.className = "chart-legend-value";
        value.textContent = `${valueDisplay(entry, chart)} · ${formatPercent(entry.fraction)}`;

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
        fragment.appendChild(button);
      }
      chartLegend.appendChild(fragment);
      return legendMap;
    }

    function sliceOffsetTransform(cx, cy, startAngle, endAngle, active) {
      if (!active) {
        return "";
      }
      const angle = (startAngle + endAngle) / 2;
      const dx = Math.cos(angle) * 12;
      const dy = Math.sin(angle) * 12;
      return `translate(${dx} ${dy})`;
    }

    function appendSliceLabel(svg, entry, startAngle, endAngle, cx, cy, innerRadius, outerRadius, zoomFactor) {
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
      label.setAttribute("transform", `rotate(${rotation} ${position.x} ${position.y})`);
      label.textContent = labelText;
      svg.appendChild(label);
    }

    function renderPie2d(chart) {
      disposeThreeContext();
      clearVisual();
      clearPieHoverBindings();
      const width = Math.max(560, chartVisual.clientWidth || 560);
      const height = Math.max(360, chartVisual.clientHeight || 360);
      const pieView = ensurePieView(width, height);
      const zoomFactor = currentPieZoom();
      const svg = svgNode("svg");
      svg.classList.add("chart-svg");
      svg.setAttribute("viewBox", `${pieView.x} ${pieView.y} ${pieView.w} ${pieView.h}`);
      svg.setAttribute("role", "img");
      svg.setAttribute("aria-label", "Hierarchy chart");
      svg.style.cursor = pieView.dragging ? "grabbing" : zoomFactor > 1 ? "grab" : "default";
      svg.addEventListener("mouseleave", () => {
        if (hoveredSliceId !== null) {
          clearHoverState();
          applyPieHoverState();
          clearNodeDetails();
        }
      });
      svg.addEventListener("wheel", (event) => {
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
        invalidate();
        renderChart(true);
      }, { passive: false });
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
        invalidate();
        renderChart(true);
      });
      const legendMap = renderLegend(chart);
      const bindings = [];

      const cx = width * 0.44;
      const cy = height * 0.52;
      const outerRadius = Math.min(width, height) * 0.33;
      const innerRadius = outerRadius * 0.44;
      const isSingleSlice = chart.entries.length === 1;
      let angle = -Math.PI / 2;

      for (const entry of chart.entries) {
        const startAngle = angle;
        const nextAngle = isSingleSlice ? startAngle + Math.PI * 2 : startAngle + Math.PI * 2 * entry.fraction;
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
        bindings.push({
          id: entry.id,
          slice,
          legend: legendMap.get(entry.id) || null,
          transform: (active) => sliceOffsetTransform(cx, cy, startAngle, nextAngle, active)
        });
        appendSliceLabel(svg, entry, startAngle, nextAngle, cx, cy, innerRadius, outerRadius, zoomFactor);
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
      centerValue.textContent = `${valueDisplay({ value: chart.total }, chart)} ${totalCaption(chart)}`;
      svg.appendChild(centerValue);

      chartVisual.appendChild(svg);
      pieHoverBindings = bindings;
      applyPieHoverState();
    }

    function loadThree() {
      if (threeLoadPromise) {
        return threeLoadPromise;
      }
      threeLoadPromise = import(THREE_MODULE_URL).then((module) => {
        if (module && typeof module.Scene === "function" && typeof module.WebGLRenderer === "function") {
          return module;
        }
        throw new Error("viewer-three.module.js loaded but does not expose the expected Three.js API.");
      }).catch((error) => {
        threeLoadPromise = null;
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to load local Three.js module (${THREE_MODULE_URL}): ${message}`);
      });
      return threeLoadPromise;
    }

    function renderThreeChart(chart) {
      disposeThreeContext();
      clearVisual();

      const loading = document.createElement("div");
      loading.className = "chart-empty";
      loading.textContent = "Loading local Three.js renderer...";
      chartVisual.appendChild(loading);
      chartStatus.textContent = `${chart.status} · loading local Three.js`;
      renderLegend(chart);

      return loadThree().then((THREE) => {
        if (!state.chartPanelOpen || state.chartRenderMode !== "three3d" || state.mainViewMode === "treemap") {
          return;
        }
        if (!chartVisual.isConnected) {
          return;
        }
        clearVisual();

        const width = Math.max(480, chartVisual.clientWidth || 480);
        const height = Math.max(320, chartVisual.clientHeight || 320);
        const theme = api.currentThemeVisuals();
        const backgroundColor = new THREE.Color(api.mixHexColors(theme.canvasBase, theme.panel, theme.dark ? 0.18 : 0.26));
        const floorColor = new THREE.Color(api.mixHexColors(theme.panel, theme.canvasBase, theme.dark ? 0.18 : 0.12));
        const gridMajorColor = new THREE.Color(api.mixHexColors(theme.text, theme.canvasBase, theme.dark ? 0.22 : 0.14));
        const gridMinorColor = new THREE.Color(api.mixHexColors(theme.textSoft, theme.canvasBase, theme.dark ? 0.12 : 0.08));
        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.setSize(width, height, false);
        renderer.setClearColor(backgroundColor, theme.dark ? 0.20 : 0.12);
        renderer.domElement.className = "chart-three-canvas";
        renderer.domElement.style.width = "100%";
        renderer.domElement.style.height = "100%";
        renderer.domElement.style.display = "block";
        renderer.domElement.style.touchAction = "none";
        chartVisual.appendChild(renderer.domElement);

        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(38, width / height, 0.1, 240);

        scene.add(new THREE.AmbientLight(0xffffff, 1.02));
        const hemisphere = new THREE.HemisphereLight(0xffffff, floorColor, theme.dark ? 0.92 : 0.98);
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

        const group = new THREE.Group();
        scene.add(group);

        const raycaster = new THREE.Raycaster();
        const pointer = new THREE.Vector2();
        const interactiveMeshes = [];
        const pedestals = [];
        const labelSprites = [];
        let hoveredMesh = null;

        const columnCount = Math.max(1, Math.ceil(Math.sqrt(chart.entries.length)));
        const rowCount = Math.max(1, Math.ceil(chart.entries.length / columnCount));
        const cellSize = chart.entries.length <= 4 ? 2.2 : chart.entries.length <= 12 ? 1.72 : 1.34;
        const barSize = Math.max(0.56, cellSize * 0.72);
        const gapSize = Math.max(0.24, cellSize - barSize);
        const halfWidth = ((columnCount - 1) * cellSize) / 2;
        const halfDepth = ((rowCount - 1) * cellSize) / 2;
        const maxHeight = 10.5;
        const minHeight = 0.14;
        const baseThickness = 0.08;
        const extent = Math.max(columnCount * cellSize, rowCount * cellSize, maxHeight);
        const viewState = ensureThreeView(extent, maxHeight);
        const labelDensityBias = chart.entries.length <= 12 ? 1.02 : chart.entries.length <= 36 ? 1.18 : 1.34;

        const floor = new THREE.Mesh(
          new THREE.BoxGeometry(columnCount * cellSize + gapSize * 2, baseThickness, rowCount * cellSize + gapSize * 2),
          new THREE.MeshStandardMaterial({
            color: floorColor,
            roughness: 0.96,
            metalness: 0.03
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

        const unitBarGeometry = new THREE.BoxGeometry(1, 1, 1);

        chart.entries.forEach((entry, index) => {
          const row = Math.floor(index / columnCount);
          const column = index % columnCount;
          const x = column * cellSize - halfWidth;
          const z = row * cellSize - halfDepth;
          const normalized = threeBarVisualRatio(entry.value, chart);
          const barHeight = minHeight + normalized * (maxHeight - minHeight);
          const material = new THREE.MeshStandardMaterial({
            color: entry.style.fill,
            roughness: 0.54,
            metalness: 0.12
          });
          const mesh = new THREE.Mesh(unitBarGeometry, material);
          mesh.scale.set(barSize, barHeight, barSize);
          mesh.position.set(x, barHeight * 0.5, z);
          mesh.userData = {
            nodeId: entry.id,
            entry,
            baseColor: entry.style.fill,
            hoverColor: api.mixHexColors(entry.style.fill, "#ffffff", theme.dark ? 0.24 : 0.18)
          };

          const pedestal = new THREE.Mesh(
            new THREE.BoxGeometry(barSize * 1.06, baseThickness, barSize * 1.06),
            new THREE.MeshStandardMaterial({
              color: api.mixHexColors(theme.panel, entry.style.fill, theme.dark ? 0.14 : 0.10),
              roughness: 0.94,
              metalness: 0.02
            })
          );
          pedestal.position.set(x, baseThickness * 0.5, z);
          scene.add(pedestal);
          mesh.userData.pedestal = pedestal;
          pedestals.push(pedestal);

          group.add(mesh);
          interactiveMeshes.push(mesh);

          const maxLabelChars = Math.max(3, Math.floor(cellSize * 5.8));
          const labelText = truncateLabel(entry.node.name || entry.node.module || "", maxLabelChars);
          const shouldShowLabel = labelText && (chart.entries.length <= 80 || cellSize >= 1.2);
          if (shouldShowLabel) {
            const labelTexture = makeLabelTexture(THREE, labelText, theme);
            if (labelTexture) {
              const spriteMaterial = new THREE.SpriteMaterial({
                map: labelTexture,
                transparent: true,
                depthTest: false,
                depthWrite: false,
                sizeAttenuation: true,
                opacity: 0
              });
              const sprite = new THREE.Sprite(spriteMaterial);
              const labelWidth = Math.min(
                barSize * 0.72,
                Math.max(barSize * 0.34, 0.08 + labelText.length * 0.0085)
              );
              const labelHeight = Math.min(
                barSize * 0.18,
                Math.max(0.042, labelWidth * 0.20)
              );
              sprite.center.set(0.5, 0);
              sprite.scale.set(labelWidth, labelHeight, 1);
              sprite.position.set(x, barHeight + 0.08, z);
              sprite.renderOrder = 3;
              scene.add(sprite);
              labelSprites.push(sprite);
              mesh.userData.labelSprite = sprite;
              mesh.userData.labelBaseScaleX = labelWidth;
              mesh.userData.labelBaseScaleY = labelHeight;
            }
          }
        });

        const orbitState = {
          get yaw() {
            return viewState.yaw;
          },
          set yaw(value) {
            viewState.yaw = value;
          },
          get pitch() {
            return viewState.pitch;
          },
          set pitch(value) {
            viewState.pitch = value;
          },
          get distance() {
            return viewState.distance;
          },
          set distance(value) {
            viewState.distance = value;
          },
          target: new THREE.Vector3(viewState.targetX, viewState.targetY, viewState.targetZ),
          minDistance: viewState.minDistance,
          maxDistance: viewState.maxDistance
        };
        const dragState = {
          active: false,
          mode: "pan",
          moved: false,
          pointerId: null,
          pointerDownMesh: null,
          lastX: 0,
          lastY: 0,
          suppressContextMenu: false
        };

        function syncCamera() {
          viewState.targetX = orbitState.target.x;
          viewState.targetY = orbitState.target.y;
          viewState.targetZ = orbitState.target.z;
          const cosPitch = Math.cos(orbitState.pitch);
          const sinPitch = Math.sin(orbitState.pitch);
          camera.position.set(
            orbitState.target.x + orbitState.distance * sinPitch * Math.sin(orbitState.yaw),
            orbitState.target.y + orbitState.distance * cosPitch,
            orbitState.target.z + orbitState.distance * sinPitch * Math.cos(orbitState.yaw)
          );
          camera.lookAt(orbitState.target);
          updateLabelSprites();
        }

        function updateLabelSprites() {
          const zoomFactor = extent / Math.max(orbitState.distance, 0.001);
          const revealBase = Math.max(0, Math.min(1, (zoomFactor - 0.9 * labelDensityBias) / 0.48));
          for (const mesh of interactiveMeshes) {
            const sprite = mesh.userData.labelSprite;
            if (!sprite) {
              continue;
            }
            const baseScaleX = mesh.userData.labelBaseScaleX || 0.16;
            const baseScaleY = mesh.userData.labelBaseScaleY || 0.06;
            const heightRatio = Math.max(0, Math.min(1, mesh.scale.y / Math.max(maxHeight, 0.001)));
            const sizeBoost = 0.24 + heightRatio * 0.74;
            const reveal = Math.max(0, Math.min(1, revealBase * sizeBoost));
            const hoverScale = hoveredMesh === mesh ? 1.06 : 1;
            const forceVisible = hoveredMesh === mesh;
            sprite.visible = forceVisible || reveal > 0.22;
            sprite.material.opacity = forceVisible
              ? 0.96
              : reveal > 0.22
                ? Math.min(0.86, 0.12 + reveal * 0.72)
                : 0;
            sprite.scale.set(baseScaleX * hoverScale, baseScaleY * hoverScale, 1);
            sprite.position.y = mesh.scale.y + 0.06 + reveal * 0.04;
          }
        }

        syncCamera();

        function renderFrame() {
          renderer.render(scene, camera);
        }

        function setHoveredMesh(mesh) {
          if (hoveredMesh === mesh) {
            return;
          }
          if (hoveredMesh) {
            hoveredMesh.material.color.set(hoveredMesh.userData.baseColor);
            hoveredMesh.material.emissive.set(0x000000);
            hoveredMesh.material.emissiveIntensity = 0;
          }
          hoveredMesh = mesh;
          if (hoveredMesh) {
            hoveredMesh.material.color.set(hoveredMesh.userData.hoverColor);
            hoveredMesh.material.emissive.set(hoveredMesh.userData.hoverColor);
            hoveredMesh.material.emissiveIntensity = theme.dark ? 0.22 : 0.12;
            if (!dragState.active) {
              renderer.domElement.style.cursor = "pointer";
            }
            showNodeDetails(hoveredMesh.userData.entry, chart);
          } else {
            renderer.domElement.style.cursor = dragState.active ? "grabbing" : "grab";
            clearNodeDetails();
          }
          updateLabelSprites();
          renderFrame();
        }

        function pickMesh(event) {
          const rect = renderer.domElement.getBoundingClientRect();
          pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
          pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
          raycaster.setFromCamera(pointer, camera);
          const hits = raycaster.intersectObjects(interactiveMeshes, false);
          return hits.length ? hits[0].object : null;
        }

        function panCamera(dx, dy) {
          const panScale = orbitState.distance * 0.00135;
          const right = new THREE.Vector3(
            Math.cos(orbitState.yaw),
            0,
            -Math.sin(orbitState.yaw)
          ).normalize();
          const forward = new THREE.Vector3(
            Math.sin(orbitState.yaw),
            0,
            Math.cos(orbitState.yaw)
          ).normalize();
          orbitState.target.addScaledVector(right, -dx * panScale);
          orbitState.target.addScaledVector(forward, -dy * panScale);
        }

        const handlePointerDown = (event) => {
          if (event.button !== 0 && event.button !== 1 && event.button !== 2) {
            return;
          }
          const downMesh = event.button === 0 ? pickMesh(event) : null;
          dragState.active = true;
          dragState.mode = event.button === 2 || event.altKey || event.ctrlKey ? "orbit" : "pan";
          dragState.moved = false;
          dragState.suppressContextMenu = false;
          dragState.pointerId = event.pointerId;
          dragState.pointerDownMesh = downMesh;
          dragState.lastX = event.clientX;
          dragState.lastY = event.clientY;
          renderer.domElement.style.cursor = dragState.mode === "orbit" ? "grabbing" : "grab";
          renderer.domElement.setPointerCapture(event.pointerId);
          event.preventDefault();
        };

        const handlePointerMove = (event) => {
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
              orbitState.pitch = Math.max(0.28, Math.min(Math.PI * 0.49, orbitState.pitch + dy * 0.0048));
            }
            syncCamera();
            renderFrame();
            return;
          }
          setHoveredMesh(pickMesh(event));
        };

        const handlePointerUp = (event) => {
          if (!dragState.active || dragState.pointerId !== event.pointerId) {
            return;
          }
          const moved = dragState.moved;
          const downMesh = dragState.pointerDownMesh;
          dragState.active = false;
          dragState.moved = false;
          dragState.pointerId = null;
          dragState.pointerDownMesh = null;
          renderer.domElement.style.cursor = "grab";
          if (renderer.domElement.hasPointerCapture(event.pointerId)) {
            renderer.domElement.releasePointerCapture(event.pointerId);
          }
          if (!moved && event.button === 0) {
            const mesh = downMesh || pickMesh(event);
            if (mesh) {
              api.focusNodeInMainView(mesh.userData.nodeId);
              return;
            }
          }
          setHoveredMesh(pickMesh(event));
        };

        const handlePointerLeave = () => {
          if (!dragState.active) {
            setHoveredMesh(null);
          }
        };

        const handleWheel = (event) => {
          event.preventDefault();
          const zoomFactor = event.deltaY < 0 ? 1 / 1.14 : 1.14;
          orbitState.distance = Math.max(
            orbitState.minDistance,
            Math.min(orbitState.maxDistance, orbitState.distance * zoomFactor)
          );
          syncCamera();
          renderFrame();
        };

        const handleContextMenu = (event) => {
          if (dragState.suppressContextMenu || dragState.active) {
            event.preventDefault();
            event.stopPropagation();
            dragState.suppressContextMenu = false;
          }
        };

        function applyToolbarZoom(factor) {
          orbitState.distance = Math.max(
            orbitState.minDistance,
            Math.min(orbitState.maxDistance, orbitState.distance / Math.max(factor, 0.0001))
          );
          syncCamera();
          renderFrame();
        }

        function applyToolbarFit() {
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
            interactiveMeshes.forEach((mesh) => {
              if (mesh.userData.edgeLines) {
                mesh.remove(mesh.userData.edgeLines);
              }
              mesh.material.dispose();
            });
            pedestals.forEach((pedestal) => {
              pedestal.geometry.dispose();
              pedestal.material.dispose();
              scene.remove(pedestal);
            });
            labelSprites.forEach((sprite) => {
              if (sprite.material.map) {
                sprite.material.map.dispose();
              }
              sprite.material.dispose();
              scene.remove(sprite);
            });
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
            group.clear();
            clearNodeDetails();
            renderer.dispose();
            chartVisual.replaceChildren();
          }
        };

        chartStatus.textContent = `${chart.status} · 3D ready · drag to pan · right-drag to orbit · wheel to zoom`;
      }).catch((error) => {
        disposeThreeContext();
        renderEmpty(error.message || "Failed to initialize local Three.js.");
        chartStatus.textContent = `3D unavailable: ${error.message || error}`;
      });
    }

    function renderChart(force = false) {
      syncControls();
      if (!state.chartPanelOpen) {
        disposeThreeContext();
        clearHoverState();
        clearPieHoverBindings();
        clearNodeDetails();
        return;
      }

      const signature = currentSignature();
      if (!force && !state.chartPanelDirty && signature === lastRenderSignature) {
        return;
      }
      state.chartPanelDirty = false;
      lastRenderSignature = signature;
      if (hoveredSliceId === null) {
        clearNodeDetails();
      }

      const chart = buildChart();
      if (chart.emptyMessage) {
        chartStatus.textContent = chart.status || chart.emptyMessage;
        renderEmpty(chart.emptyMessage);
        return;
      }

      chartStatus.textContent = chart.status;
      if (state.chartRenderMode === "three3d") {
        renderThreeChart(chart);
        return;
      }
      renderPie2d(chart);
    }

    chartModeSelect.addEventListener("change", () => {
      state.chartMode = chartModeSelect.value === "analysis" ? "analysis" : "weighted_bits";
      invalidate();
      api.savePersistedState();
      api.requestDraw();
    });

    chartLevelSelect.addEventListener("change", () => {
      state.chartLevel = chartLevelSelect.value === "max"
        ? null
        : Math.max(1, Number.parseInt(chartLevelSelect.value, 10) || 1);
      invalidate();
      api.savePersistedState();
      api.requestDraw();
    });

    chartAnalysisSelect.addEventListener("change", () => {
      state.analysisMode = chartAnalysisSelect.value;
      api.buildSignalAnalysis();
      api.syncAnalysisControls();
      invalidate();
      api.savePersistedState();
      api.requestDraw();
    });

    chartAnalysisPatternModeSelect.addEventListener("change", () => {
      state.analysisPatternMode = chartAnalysisPatternModeSelect.value;
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
          renderChart(true);
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

    function zoomByFactor(factor) {
      if (state.mainViewMode === "three3d" && threeContext && typeof threeContext.zoomByFactor === "function") {
        threeContext.zoomByFactor(factor);
        api.savePersistedState();
        api.requestDraw();
        return true;
      }
      if (state.mainViewMode === "pie2d" && pieViewState) {
        const width = Math.max(560, chartVisual.clientWidth || 560);
        const height = Math.max(360, chartVisual.clientHeight || 360);
        const targetW = Math.max(width / 18, Math.min(width, pieViewState.w / Math.max(factor, 0.0001)));
        const targetH = Math.max(height / 18, Math.min(height, pieViewState.h / Math.max(factor, 0.0001)));
        const centerX = pieViewState.x + pieViewState.w * 0.5;
        const centerY = pieViewState.y + pieViewState.h * 0.5;
        pieViewState.w = targetW;
        pieViewState.h = targetH;
        pieViewState.x = centerX - targetW * 0.5;
        pieViewState.y = centerY - targetH * 0.5;
        clampPieView();
        invalidate();
        api.savePersistedState();
        api.requestDraw();
        return true;
      }
      return false;
    }

    function fitView() {
      if (state.mainViewMode === "three3d" && threeContext && typeof threeContext.fitView === "function") {
        threeContext.fitView();
        api.savePersistedState();
        api.requestDraw();
        return true;
      }
      if (state.mainViewMode === "pie2d") {
        resetPieView(
          Math.max(560, chartVisual.clientWidth || 560),
          Math.max(360, chartVisual.clientHeight || 360)
        );
        invalidate();
        api.savePersistedState();
        api.requestDraw();
        return true;
      }
      return false;
    }

    function viewStatus() {
      if (state.mainViewMode === "three3d") {
        return {
          zoomLabel: threeContext && typeof threeContext.zoomLabel === "function"
            ? threeContext.zoomLabel()
            : currentThreeZoomLabel(),
          hintText: threeContext && typeof threeContext.hintText === "function"
            ? threeContext.hintText()
            : "3D view: drag to pan. Right-drag to orbit. Wheel or toolbar +/- to zoom. Fit resets the camera. Right-click returns to the parent hierarchy."
        };
      }
      if (state.mainViewMode === "pie2d") {
        return {
          zoomLabel: `${currentPieZoom().toFixed(2)}x`,
          hintText: "2D pie: drag to pan. Wheel or toolbar +/- to zoom. Fit resets the view. Right-click returns to the parent hierarchy."
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
      }
    };
  };
})();
