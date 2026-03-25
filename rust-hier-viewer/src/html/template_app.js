    (async () => {
    const loadingOverlay = document.getElementById("loading-overlay");
    const loadingStage = document.getElementById("loading-stage");
    const loadingDetail = document.getElementById("loading-detail");
    const loadingBarFill = document.getElementById("loading-bar-fill");
    const uiAnnotationLayer = document.getElementById("ui-annotation-layer");
    let uiAnnotationFrame = 0;
    let uiAnnotationHoverTarget = null;

    function setLoadingState(percent, stage, detail = "") {
      const clamped = Math.max(0, Math.min(100, percent));
      loadingBarFill.style.width = `${clamped}%`;
      loadingStage.textContent = stage;
      loadingDetail.textContent = detail;
    }

    function formatLoadingBytes(byteCount) {
      if (!Number.isFinite(byteCount) || byteCount <= 0) {
        return "0 B";
      }
      const units = ["B", "KB", "MB", "GB"];
      let value = byteCount;
      let unitIndex = 0;
      while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex += 1;
      }
      const digits = value >= 100 || unitIndex === 0 ? 0 : value >= 10 ? 1 : 2;
      return `${value.toFixed(digits)} ${units[unitIndex]}`;
    }

    function afterPaint() {
      return new Promise((resolve) => {
        requestAnimationFrame(() => resolve());
      });
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

    function findUiNamedElement(element) {
      if (!element || !(element instanceof Element)) {
        return null;
      }
      return element.closest("[data-ui-name]");
    }

    function setUiAnnotationHoverTarget(element) {
      const next = findUiNamedElement(element);
      if (next === uiAnnotationHoverTarget) {
        return;
      }
      uiAnnotationHoverTarget = next;
      scheduleUiAnnotations();
    }

    function clearUiAnnotationHoverTargetWithin(container) {
      if (!container || !uiAnnotationHoverTarget) {
        return;
      }
      if (uiAnnotationHoverTarget === container || container.contains(uiAnnotationHoverTarget)) {
        uiAnnotationHoverTarget = null;
        scheduleUiAnnotations();
      }
    }

    function shouldRenderUiAnnotation(element) {
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

    function appendUiAnnotationTag(fragment, element, hovered = false) {
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
      const elements = document.querySelectorAll('[data-ui-name][data-ui-label="always"]');
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
    const CORE_BUNDLE_MAGIC = "HVC1";
    const ANALYSIS_BUNDLE_MAGIC = "HVA1";
    const BUNDLE_FORMAT_VERSION = 1;
    const utf8Decoder = new TextDecoder();

    function decodeAscii(bytes, offset, length) {
      let value = "";
      for (let index = 0; index < length; index += 1) {
        value += String.fromCharCode(bytes[offset + index]);
      }
      return value;
    }

    function createBinaryReader(buffer) {
      return {
        buffer,
        bytes: new Uint8Array(buffer),
        view: new DataView(buffer),
        offset: 0,
        ensure(byteLength, label) {
          if (this.offset + byteLength > this.view.byteLength) {
            throw new Error(`${label} truncated at byte ${this.offset}`);
          }
        },
        readMagic(label) {
          this.ensure(4, `${label} header`);
          const magic = decodeAscii(this.bytes, this.offset, 4);
          this.offset += 4;
          return magic;
        },
        readU32(label) {
          this.ensure(4, label);
          const value = this.view.getUint32(this.offset, true);
          this.offset += 4;
          return value;
        },
        readOptionalU32(label) {
          const value = this.readU32(label);
          return value === 0xFFFFFFFF ? null : value;
        },
        readU64Number(label) {
          const low = this.readU32(`${label} (low)`);
          const high = this.readU32(`${label} (high)`);
          return high * 4294967296 + low;
        },
        readOptionalU64Key(label) {
          const low = this.readU32(`${label} (low)`);
          const high = this.readU32(`${label} (high)`);
          if (low === 0xFFFFFFFF && high === 0xFFFFFFFF) {
            return null;
          }
          return ((BigInt(high) << 32n) | BigInt(low)).toString();
        },
        readU64Key(label) {
          const low = this.readU32(`${label} (low)`);
          const high = this.readU32(`${label} (high)`);
          return ((BigInt(high) << 32n) | BigInt(low)).toString();
        },
        readStringTable(label) {
          const stringCount = this.readU32(`${label} string count`);
          const strings = new Array(stringCount);
          for (let index = 0; index < stringCount; index += 1) {
            const byteLength = this.readU32(`${label} string length`);
            this.ensure(byteLength, `${label} string bytes`);
            strings[index] = utf8Decoder.decode(
              this.bytes.subarray(this.offset, this.offset + byteLength)
            );
            this.offset += byteLength;
          }
          return strings;
        }
      };
    }

    function readColumn(reader, count, label, readValue) {
      const values = new Array(count);
      for (let index = 0; index < count; index += 1) {
        values[index] = readValue(reader, `${label}[${index}]`);
      }
      return values;
    }

    function stringAt(strings, index, label) {
      if (index === null || index === undefined) {
        return null;
      }
      const value = strings[index];
      if (value === undefined) {
        throw new Error(`${label} references missing string id ${index}`);
      }
      return value;
    }

    function defineLazyNodePath(node, nodeId, nodes, rootId, cache) {
      Object.defineProperty(node, "path", {
        enumerable: true,
        configurable: true,
        get() {
          const cached = cache[nodeId];
          if (cached !== undefined) {
            return cached;
          }
          let value = "";
          if (!(nodeId === rootId || node.parent === null || node.parent === undefined)) {
            const parentPath = nodes[node.parent].path;
            value = parentPath ? `${parentPath}.${node.name}` : node.name;
          }
          cache[nodeId] = value;
          return value;
        }
      });
    }

    function decodeCoreBundle(buffer, meta) {
      const reader = createBinaryReader(buffer);
      const magic = reader.readMagic("viewer-core.bin");
      if (magic !== CORE_BUNDLE_MAGIC) {
        throw new Error(`viewer-core.bin has unsupported magic '${magic}'`);
      }
      const version = reader.readU32("viewer-core.bin version");
      if (version !== BUNDLE_FORMAT_VERSION) {
        throw new Error(`viewer-core.bin has unsupported version ${version}`);
      }
      const strings = reader.readStringTable("viewer-core.bin");
      const nodeCount = reader.readU32("viewer-core.bin node count");

      const nameIds = readColumn(reader, nodeCount, "name id", (stream, label) => stream.readU32(label));
      const moduleIds = readColumn(reader, nodeCount, "module id", (stream, label) => stream.readU32(label));
      const definitionKeys = readColumn(reader, nodeCount, "definition key", (stream, label) => stream.readOptionalU64Key(label));
      const parents = readColumn(reader, nodeCount, "parent id", (stream, label) => stream.readOptionalU32(label));
      const subtreeInstances = readColumn(reader, nodeCount, "subtree instances", (stream, label) => stream.readU32(label));
      const subtreeLeaves = readColumn(reader, nodeCount, "subtree leaves", (stream, label) => stream.readU32(label));
      const subtreeSignalCounts = readColumn(reader, nodeCount, "subtree signal count", (stream, label) => stream.readU32(label));
      const subtreeInternalSignalCounts = readColumn(reader, nodeCount, "subtree internal signal count", (stream, label) => stream.readU32(label));
      const subtreeVariableBits = readColumn(reader, nodeCount, "subtree variable bits", (stream, label) => stream.readU64Number(label));
      const subtreeNetBits = readColumn(reader, nodeCount, "subtree net bits", (stream, label) => stream.readU64Number(label));
      const moduleVariableCounts = readColumn(reader, nodeCount, "module variable count", (stream, label) => stream.readU32(label));
      const moduleNetCounts = readColumn(reader, nodeCount, "module net count", (stream, label) => stream.readU32(label));
      const moduleVariableBits = readColumn(reader, nodeCount, "module variable bits", (stream, label) => stream.readU64Number(label));
      const moduleNetBits = readColumn(reader, nodeCount, "module net bits", (stream, label) => stream.readU64Number(label));
      const moduleInternalSignalCounts = readColumn(reader, nodeCount, "module internal signal count", (stream, label) => stream.readU32(label));
      const filePathIds = readColumn(reader, nodeCount, "file path id", (stream, label) => stream.readOptionalU32(label));
      const sourceHrefIds = readColumn(reader, nodeCount, "source href id", (stream, label) => stream.readOptionalU32(label));
      const definitionFilePathIds = readColumn(reader, nodeCount, "definition file path id", (stream, label) => stream.readOptionalU32(label));
      const definitionSourceHrefIds = readColumn(reader, nodeCount, "definition source href id", (stream, label) => stream.readOptionalU32(label));
      const lines = readColumn(reader, nodeCount, "line", (stream, label) => stream.readOptionalU32(label));
      const columns = readColumn(reader, nodeCount, "column", (stream, label) => stream.readOptionalU32(label));
      const endLines = readColumn(reader, nodeCount, "end line", (stream, label) => stream.readOptionalU32(label));
      const endColumns = readColumn(reader, nodeCount, "end column", (stream, label) => stream.readOptionalU32(label));
      const definitionLines = readColumn(reader, nodeCount, "definition line", (stream, label) => stream.readOptionalU32(label));
      const definitionColumns = readColumn(reader, nodeCount, "definition column", (stream, label) => stream.readOptionalU32(label));
      const definitionEndLines = readColumn(reader, nodeCount, "definition end line", (stream, label) => stream.readOptionalU32(label));
      const definitionEndColumns = readColumn(reader, nodeCount, "definition end column", (stream, label) => stream.readOptionalU32(label));

      const children = Array.from({ length: nodeCount }, () => []);
      const depths = new Array(nodeCount).fill(0);
      for (let nodeId = 0; nodeId < nodeCount; nodeId += 1) {
        const parent = parents[nodeId];
        if (parent !== null && parent !== undefined) {
          if (parent < 0 || parent >= nodeCount) {
            throw new Error(`viewer-core.bin parent id ${parent} is out of range for node ${nodeId}`);
          }
          children[parent].push(nodeId);
          depths[nodeId] = depths[parent] + 1;
        }
      }

      const rootId = Number(meta.rootId) || 0;
      const nodes = new Array(nodeCount);
      const pathCache = new Array(nodeCount);

      for (let nodeId = 0; nodeId < nodeCount; nodeId += 1) {
        const node = {
          id: nodeId,
          name: stringAt(strings, nameIds[nodeId], "name") || "",
          module: stringAt(strings, moduleIds[nodeId], "module") || "",
          definitionKey: definitionKeys[nodeId],
          parent: parents[nodeId],
          depth: depths[nodeId],
          children: children[nodeId],
          subtreeInstances: subtreeInstances[nodeId],
          subtreeLeaves: subtreeLeaves[nodeId],
          subtreeSignalCount: subtreeSignalCounts[nodeId],
          subtreeInternalSignalCount: subtreeInternalSignalCounts[nodeId],
          subtreeVariableBits: subtreeVariableBits[nodeId],
          subtreeNetBits: subtreeNetBits[nodeId],
          subtreeSignalBits: subtreeVariableBits[nodeId] + subtreeNetBits[nodeId],
          moduleVariableCount: moduleVariableCounts[nodeId],
          moduleNetCount: moduleNetCounts[nodeId],
          moduleSignalCount: moduleVariableCounts[nodeId] + moduleNetCounts[nodeId],
          moduleVariableBits: moduleVariableBits[nodeId],
          moduleNetBits: moduleNetBits[nodeId],
          moduleSignalBits: moduleVariableBits[nodeId] + moduleNetBits[nodeId],
          moduleInternalSignalCount: moduleInternalSignalCounts[nodeId],
          filePath: stringAt(strings, filePathIds[nodeId], "file path"),
          sourceHref: stringAt(strings, sourceHrefIds[nodeId], "source href"),
          definitionFilePath: stringAt(strings, definitionFilePathIds[nodeId], "definition file path"),
          definitionSourceHref: stringAt(strings, definitionSourceHrefIds[nodeId], "definition source href"),
          line: lines[nodeId],
          column: columns[nodeId],
          endLine: endLines[nodeId],
          endColumn: endColumns[nodeId],
          definitionLine: definitionLines[nodeId],
          definitionColumn: definitionColumns[nodeId],
          definitionEndLine: definitionEndLines[nodeId],
          definitionEndColumn: definitionEndColumns[nodeId]
        };
        nodes[nodeId] = node;
      }

      for (let nodeId = 0; nodeId < nodeCount; nodeId += 1) {
        defineLazyNodePath(nodes[nodeId], nodeId, nodes, rootId, pathCache);
      }

      return {
        title: typeof meta.title === "string" ? meta.title : "",
        builtAtUnixMs: Number(meta.builtAtUnixMs) || 0,
        debugUiLabels: !!meta.debugUiLabels,
        rootId,
        defaultMetric: typeof meta.defaultMetric === "string" ? meta.defaultMetric : "instances",
        analysisDefinitions: null,
        analysisFile: typeof meta.analysisFile === "string" ? meta.analysisFile : null,
        nodes
      };
    }

    function decodeAnalysisBundle(buffer) {
      const reader = createBinaryReader(buffer);
      const magic = reader.readMagic("viewer-analysis.bin");
      if (magic !== ANALYSIS_BUNDLE_MAGIC) {
        throw new Error(`viewer-analysis.bin has unsupported magic '${magic}'`);
      }
      const version = reader.readU32("viewer-analysis.bin version");
      if (version !== BUNDLE_FORMAT_VERSION) {
        throw new Error(`viewer-analysis.bin has unsupported version ${version}`);
      }
      const strings = reader.readStringTable("viewer-analysis.bin");
      const definitionCount = reader.readU32("viewer-analysis.bin definition count");
      const definitions = new Array(definitionCount);
      for (let definitionIndex = 0; definitionIndex < definitionCount; definitionIndex += 1) {
        const definitionKey = reader.readU64Key("definition key");
        const statCount = reader.readU32("signal stat count");
        const signalStats = new Array(statCount);
        for (let statIndex = 0; statIndex < statCount; statIndex += 1) {
          const signalNameId = reader.readU32("signal name id");
          const signalKindId = reader.readU32("signal kind id");
          signalStats[statIndex] = {
            signalName: stringAt(strings, signalNameId, "signal name") || "",
            signalKind: stringAt(strings, signalKindId, "signal kind") || "",
            signalCount: reader.readU32("signal count"),
            totalBits: reader.readU64Number("total bits")
          };
        }
        definitions[definitionIndex] = {
          definitionKey,
          signalStats
        };
      }
      return definitions;
    }

    async function fetchBinaryFile(url, startPercent, endPercent, stageTitle, waitingMessage) {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} while loading ${url}`);
      }
      const totalBytes = Number(response.headers.get("content-length")) || 0;
      let fetchedBytes = 0;

      if (response.body && typeof response.body.getReader === "function") {
        const reader = response.body.getReader();
        const chunks = [];
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

        let bytes;
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

    let DATA;
    try {
      setLoadingState(4, "Opening bundle...", "Loading viewer-meta.json.");
      await afterPaint();
      const metaResponse = await fetch(VIEWER_META_URL, { cache: "no-store" });
      if (!metaResponse.ok) {
        throw new Error(`HTTP ${metaResponse.status} while loading viewer-meta.json`);
      }
      const meta = await metaResponse.json();
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
      document.body.innerHTML = `<div style="padding: 32px; font: 16px/1.5 Iowan Old Style, Palatino Linotype, Book Antiqua, Georgia, serif; color: #26180e;"><h1 style="margin-top: 0;">Failed to load viewer data</h1><p>Open this bundle through a static server such as VSCode Live Server, and make sure <code>viewer-meta.json</code> and <code>viewer-core.bin</code> are next to <code>index.html</code>.</p><p><strong>Detail:</strong> ${escapeHtml(message)}</p></div>`;
      return;
    }
    const nodes = DATA.nodes;
    const app = document.querySelector(".app");
    const canvas = document.getElementById("treemap");
    const canvasPanel = canvas.closest(".canvas-panel");
    const treemapStage = document.getElementById("treemap-stage");
    const treemapAnalysisLegend = document.getElementById("treemap-analysis-legend");
    const treemapAnalysisLegendTitle = document.getElementById("treemap-analysis-legend-title");
    const treemapAnalysisLegendSubtitle = document.getElementById("treemap-analysis-legend-subtitle");
    const treemapAnalysisLegendList = document.getElementById("treemap-analysis-legend-list");
    const treemapAnalysisLegendHead = treemapAnalysisLegend
      ? treemapAnalysisLegend.querySelector(".treemap-analysis-legend-head")
      : null;
    const chartPanel = document.getElementById("chart-panel");
    const viewTreemapBtn = document.getElementById("view-treemap-btn");
    const viewPieBtn = document.getElementById("view-pie-btn");
    const viewThreeBtn = document.getElementById("view-three-btn");
    const zenToggleBtn = document.getElementById("zen-toggle-btn");
    const zenOverlayShell = document.getElementById("zen-overlay-shell");
    const zenViewTreemapBtn = document.getElementById("zen-view-treemap-btn");
    const zenViewPieBtn = document.getElementById("zen-view-pie-btn");
    const zenViewThreeBtn = document.getElementById("zen-view-three-btn");
    const zenExitBtn = document.getElementById("zen-exit-btn");
    const hoverCard = document.getElementById("hover-card");
    const hoverTopbar = document.getElementById("hover-topbar");
    const hoverSelectedPill = document.getElementById("hover-selected-pill");
    const hoverDismissBtn = document.getElementById("hover-dismiss-btn");
    const hoverPath = document.getElementById("hover-path");
    const hoverTitle = document.getElementById("hover-title");
    const hoverMeta = document.getElementById("hover-meta");
    const hoverActions = document.getElementById("hover-actions");
    const treemapToggleTooltip = document.getElementById("treemap-toggle-tooltip");
    const treemapToggleTooltipInstance = document.getElementById("treemap-toggle-tooltip-instance");
    const treemapToggleTooltipModule = document.getElementById("treemap-toggle-tooltip-module");
    const openInstanceSourceBtn = document.getElementById("open-instance-source-btn");
    const openModuleSourceBtn = document.getElementById("open-module-source-btn");
    const pageTitle = document.getElementById("page-title");
    const pageSubtitle = document.getElementById("page-subtitle");
    const breadcrumbs = document.getElementById("breadcrumbs");
    const statusLeft = document.getElementById("status-left");
    const statusRight = document.getElementById("status-right");
    const homeBtn = document.getElementById("home-btn");
    const upBtn = document.getElementById("up-btn");
    const zoomOutBtn = document.getElementById("zoom-out-btn");
    const zoomInBtn = document.getElementById("zoom-in-btn");
    const fitBtn = document.getElementById("fit-btn");
    const clearTreemapCollapsesBtn = document.getElementById("clear-treemap-collapses-btn");
    const selectModeBtn = document.getElementById("select-mode-btn");
    const toggleTreeBtn = document.getElementById("toggle-tree-btn");
    const toggleMatchBtn = document.getElementById("toggle-match-btn");
    const advancedControlsBtn = document.getElementById("advanced-controls-btn");
    const advancedPopover = document.getElementById("advanced-popover");
    const advancedPopoverHeader = document.getElementById("advanced-popover-header");
    const filterScopeSelect = document.getElementById("filter-scope-select");
    const filterModeSelect = document.getElementById("filter-mode-select");
    const depthSelect = document.getElementById("depth-select");
    const metricSelect = document.getElementById("metric-select");
    const weightedMetricGroup = document.getElementById("weighted-metric-group");
    const weightedVariableInput = document.getElementById("weighted-variable-input");
    const weightedNetInput = document.getElementById("weighted-net-input");
    const themeSelect = document.getElementById("theme-select");
    const layoutSelect = document.getElementById("layout-select");
    const decompositionSelect = document.getElementById("decomposition-select");
    const analysisSelect = document.getElementById("analysis-select");
    const analysisPatternGroup = document.getElementById("analysis-pattern-group");
    const analysisPatternModeSelect = document.getElementById("analysis-pattern-mode-select");
    const analysisPatternInput = document.getElementById("analysis-pattern-input");
    const analysisPatternModeField = analysisPatternModeSelect ? analysisPatternModeSelect.closest(".metric-group") : null;
    const analysisPatternInputField = analysisPatternInput ? analysisPatternInput.closest(".metric-group") : null;
    const metricTooltipItems = Array.from(document.querySelectorAll(".metric-tooltip-item"));
    const searchInput = document.getElementById("search-input");
    const treePanel = document.getElementById("tree-panel");
    const treePanelSubtitle = document.getElementById("tree-panel-subtitle");
    const treePanelBody = document.getElementById("tree-panel-body");
    const expandTreeBtn = document.getElementById("expand-tree-btn");
    const collapseTreeBtn = document.getElementById("collapse-tree-btn");
    const closeTreeBtn = document.getElementById("close-tree-btn");
    const treePanelResizer = document.getElementById("tree-panel-resizer");
    const matchPanel = document.getElementById("match-panel");
    const matchPanelSubtitle = document.getElementById("match-panel-subtitle");
    const matchPanelBody = document.getElementById("match-panel-body");
    const copyMatchesBtn = document.getElementById("copy-matches-btn");
    const closeMatchBtn = document.getElementById("close-match-btn");
    const matchPanelResizerX = document.getElementById("match-panel-resizer-x");
    const matchPanelResizerY = document.getElementById("match-panel-resizer-y");
    const matchPanelResizerCorner = document.getElementById("match-panel-resizer-corner");
    const sourcePanel = document.getElementById("source-panel");
    const sourceTitle = document.getElementById("source-title");
    const sourceSubtitle = document.getElementById("source-subtitle");
    const sourceStatus = document.getElementById("source-status");
    const sourceLoadProgress = document.getElementById("source-load-progress");
    const sourceLoadStage = document.getElementById("source-load-stage");
    const sourceLoadDetail = document.getElementById("source-load-detail");
    const sourceLoadBarFill = document.getElementById("source-load-bar-fill");
    const sourceCode = document.getElementById("source-code");
    const openRawSourceLink = document.getElementById("open-raw-source-link");
    const toggleSourceFullscreenBtn = document.getElementById("toggle-source-fullscreen-btn");
    const closeSourceBtn = document.getElementById("close-source-btn");
    const sourceSearchModeSelect = document.getElementById("source-search-mode-select");
    const sourceSearchInput = document.getElementById("source-search-input");
    const sourceSearchStatus = document.getElementById("source-search-status");
    const sourceSearchPrevBtn = document.getElementById("source-search-prev-btn");
    const sourceSearchNextBtn = document.getElementById("source-search-next-btn");
    const sourceBookmarkList = document.getElementById("source-bookmark-list");
    const toolbar = document.getElementById("toolbar");
    const toggleToolbarBtn = document.getElementById("toggle-toolbar-btn");
    const appRoot = document.querySelector(".app");
    const ctx = canvas.getContext("2d");
    let analysisDefinitions = Array.isArray(DATA.analysisDefinitions) ? DATA.analysisDefinitions : null;
    let analysisDefinitionMap = null;
    let analysisDefinitionsPromise = null;
    let analysisDefinitionsLoadError = "";
    const analysisHatchPatternCache = new Map();
    const subtreeDepthCache = new Array(nodes.length).fill(-1);
    const sourceTextCache = new Map();
    const SOURCE_SEARCH_INPUT_DEBOUNCE_MS = 120;
    const ADVANCED_POPOVER_MIN_VISIBLE_WIDTH = 160;
    const ADVANCED_POPOVER_MIN_VISIBLE_HEADER = 72;
    const SEARCH_HISTORY_LIMIT = 24;
    const SOURCE_VIRTUALIZED_LINE_THRESHOLD = 320;
    const SOURCE_VIRTUALIZED_OVERSCAN_LINES = 120;
    const SOURCE_COMPACT_RENDER_INSTANCE_LINE_THRESHOLD = 2200;
    const SOURCE_COMPACT_RENDER_INSTANCE_CHAR_THRESHOLD = 320000;
    const SOURCE_COMPACT_RENDER_DEFINITION_LINE_THRESHOLD = 1800;
    const SOURCE_COMPACT_RENDER_DEFINITION_CHAR_THRESHOLD = 260000;
    const SOURCE_PLAIN_TEXT_INSTANCE_LINE_THRESHOLD = 500000;
    const SOURCE_PLAIN_TEXT_INSTANCE_CHAR_THRESHOLD = 40000000;
    const SOURCE_PLAIN_TEXT_DEFINITION_LINE_THRESHOLD = 300000;
    const SOURCE_PLAIN_TEXT_DEFINITION_CHAR_THRESHOLD = 24000000;
    const defaultHint = "Wheel to zoom. Drag to pan. Click to drill down. Filter supports text, wc:pattern, and re:regex. Signal analysis supports wildcard/text/regex over internal signal names. Press Escape to close source.";
    const selectModeHint = "Select mode: single-click pins a node and keeps the hover card open. Double-click enters child hierarchy or opens source at a leaf. Right-click returns to the parent hierarchy.";
    const STORAGE_KEY = `hier-viewer:${window.location.pathname}`;
    let currentSourceView = null;
    let sourceSearchMatchElements = [];
    let sourceSearchInputTimer = null;
    const sourceLineHeightCache = new Map();
    let sourceVirtualRenderQueued = false;
    let sourceVirtualRenderForce = false;
    const searchHistorySessions = new Map();

    const state = {
      homeRoot: DATA.rootId,
      currentRoot: DATA.rootId,
      theme: "solarized-light",
      metric: DATA.defaultMetric,
      weightedVariableWeight: 1,
      weightedNetWeight: 0.15,
      layoutMode: DATA.defaultMetric === "weighted_signals" || DATA.defaultMetric === "signals"
        ? "accurate"
        : "classic",
      decomposition: "subtree",
      analysisMode: "none",
      analysisPatternMode: "wildcard",
      analysisPattern: "",
      analysisError: "",
      analysisLocalCounts: new Array(nodes.length).fill(0),
      analysisSubtreeCounts: new Array(nodes.length).fill(0),
      analysisLocalLocs: new Array(nodes.length).fill(0),
      analysisSubtreeLocs: new Array(nodes.length).fill(0),
      analysisLocalRatios: new Array(nodes.length).fill(0),
      analysisSubtreeRatios: new Array(nodes.length).fill(0),
      analysisMaxSubtreeCount: 0,
      analysisVisibleMaxCount: 0,
      analysisVisibleMaxLoc: 0,
      analysisVisibleMaxRatio: 0,
      analysisVisibleSubtreeQualified: new Array(nodes.length).fill(false),
      analysisLegendFilter: [],
      analysisLegendVisibleSubtree: new Array(nodes.length).fill(false),
      analysisHatchDisabledUntil: 0,
      advancedPopoverOpen: false,
      advancedPopoverLeft: null,
      advancedPopoverTop: null,
      draggingAdvancedPopover: false,
      advancedPopoverDragOffsetX: 0,
      advancedPopoverDragOffsetY: 0,
      toolbarCollapsed: false,
      selectMode: false,
      depthLimit: null,
      zoom: 1,
      viewX: 0,
      viewY: 0,
      areas: [],
      hoverId: null,
      hoverAreaKind: "node",
      hoveredTreemapToggleId: null,
      treemapToggleTooltipNodeId: null,
      treemapToggleTooltipClientX: 0,
      treemapToggleTooltipClientY: 0,
      selectedId: null,
      selectedAreaKind: "node",
      hoverCardActive: false,
      hoverCardLeft: null,
      hoverCardTop: 18,
      draggingHoverCard: false,
      hoverCardDragOffsetX: 0,
      hoverCardDragOffsetY: 0,
      hoverUpdateTimer: null,
      selectClickTimer: null,
      sourceNodeId: null,
      sourceTargetKind: "instance",
      search: "",
      filterScope: "both",
      filterMode: "text",
      searchError: "",
      matches: [],
      matchIds: new Set(),
      matchVisibleIds: new Set(),
      matchSubtreeIds: new Set(),
      matchLines: [],
      sourceRequestToken: 0,
      sourceAbortController: null,
      sourcePanelFullscreen: false,
      sourceSearchMode: "wildcard",
      sourceSearch: "",
      sourceSearchError: "",
      sourceSearchMatchIndex: -1,
      sourceBookmarkEditingKey: null,
      sourceBookmarkEditingLine: null,
      sourceBookmarkEditingDraft: "",
      sourceBookmarksByFile: {},
      searchHistoryByField: {},
      treePanelOpen: false,
      treePanelWidth: 360,
      draggingTreePanelResize: false,
      treePanelResizeStartX: 0,
      treePanelResizeStartWidth: 360,
      matchPanelOpen: false,
      treeCollapsedIds: new Set(),
      matchPanelWidth: 360,
      matchPanelHeight: 480,
      matchPanelLeft: null,
      matchPanelTop: 12,
      draggingMatchPanel: false,
      matchPanelDragOffsetX: 0,
      matchPanelDragOffsetY: 0,
      draggingMatchPanelResizeX: false,
      draggingMatchPanelResizeY: false,
      matchPanelResizeStartX: 0,
      matchPanelResizeStartY: 0,
      matchPanelResizeStartWidth: 360,
      matchPanelResizeStartHeight: 480,
      treePanelDirty: true,
      matchPanelDirty: true,
      mainViewMode: "treemap",
      chartPanelOpen: false,
      chartMode: "weighted_bits",
      chartRenderMode: "pie2d",
      chartLevel: null,
      chartPanelDirty: true,
      zenMode: false,
      zenOverlayLeft: null,
      zenOverlayTop: null,
      draggingZenOverlay: false,
      zenOverlayDragOffsetX: 0,
      zenOverlayDragOffsetY: 0,
      treemapAnalysisLegendLeft: null,
      treemapAnalysisLegendTop: null,
      draggingTreemapAnalysisLegend: false,
      treemapAnalysisLegendDragOffsetX: 0,
      treemapAnalysisLegendDragOffsetY: 0,
      chartPanelWidth: 1080,
      chartPanelHeight: 760,
      chartPanelLeft: 16,
      chartPanelTop: 16,
      draggingChartPanelResize: false,
      chartPanelResizeStartX: 0,
      chartPanelResizeStartY: 0,
      chartPanelResizeStartWidth: 1080,
      chartPanelResizeStartHeight: 760,
      isDragging: false,
      dragMoved: false,
      lastPointerX: 0,
      lastPointerY: 0,
      devicePixelRatio: Math.max(1, window.devicePixelRatio || 1)
    };

    function getNode(id) {
      return nodes[id];
    }

    function sanitizeWeight(value, fallback) {
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < 0) {
        return fallback;
      }
      return parsed;
    }

    function applyLegacyMetricAlias() {
      if (state.metric === "signals") {
        state.metric = "weighted_signals";
        state.weightedVariableWeight = 1;
        state.weightedNetWeight = 1;
      }
    }

    function getAnalysisDefinitionMap() {
      if (analysisDefinitionMap === null) {
        analysisDefinitionMap = new Map(
          (analysisDefinitions || []).map((definition) => [definition.definitionKey, definition.signalStats || []])
        );
      }
      return analysisDefinitionMap;
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

    function formatMetricValue(value) {
      if (!Number.isFinite(value)) {
        return "0";
      }
      const rounded = Math.round(value * 100) / 100;
      if (Math.abs(rounded - Math.round(rounded)) < 1e-9) {
        return Math.round(rounded).toLocaleString();
      }
      return rounded.toLocaleString(undefined, {
        minimumFractionDigits: 0,
        maximumFractionDigits: 2
      });
    }

    function weightedBits(variableBits, netBits) {
      return (
        variableBits * state.weightedVariableWeight +
        netBits * state.weightedNetWeight
      );
    }

    function clampValue(value, min, max) {
      if (min > max) {
        return (min + max) / 2;
      }
      return Math.max(min, Math.min(max, value));
    }

    function subtreeWeightedBits(node) {
      return weightedBits(node.subtreeVariableBits || 0, node.subtreeNetBits || 0);
    }

    function localWeightedBits(node) {
      return weightedBits(node.moduleVariableBits || 0, node.moduleNetBits || 0);
    }

    function hoverMetaLine(label, value) {
      return `<div class="hover-meta-line"><span class="hover-meta-label">${escapeHtml(label)}:</span> ${escapeHtml(value)}</div>`;
    }

    function nodeInstanceLabel(node) {
      const value = typeof node?.name === "string" ? node.name.trim() : "";
      return value || "(root)";
    }

    function hideTreemapToggleTooltip() {
      state.treemapToggleTooltipNodeId = null;
      if (!treemapToggleTooltip) {
        return;
      }
      treemapToggleTooltip.classList.add("hidden");
    }

    function positionTreemapToggleTooltip(clientX = state.treemapToggleTooltipClientX, clientY = state.treemapToggleTooltipClientY) {
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

    function showTreemapToggleTooltip(nodeId, clientX, clientY) {
      if (!Number.isInteger(nodeId) || nodeId < 0 || nodeId >= nodes.length || !treemapToggleTooltip) {
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

    function isGenericViewerTitle(title) {
      const normalized = (title || "").trim().toLowerCase();
      return (
        !normalized ||
        normalized === "hiers" ||
        normalized === "hier" ||
        normalized === "hierarchy" ||
        normalized === "hierarchy viewer"
      );
    }

    function formatBuildTime(unixMs) {
      if (!Number.isFinite(unixMs) || unixMs <= 0) {
        return "";
      }
      const date = new Date(unixMs);
      if (Number.isNaN(date.getTime())) {
        return "";
      }
      return new Intl.DateTimeFormat(undefined, {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).format(date);
    }

    function buildSubtitleText(title, builtAtUnixMs) {
      const parts = [];
      if (!isGenericViewerTitle(title)) {
        parts.push(title);
      }
      const buildTime = formatBuildTime(builtAtUnixMs);
      if (buildTime) {
        parts.push(`Built ${buildTime}`);
      }
      return parts.join(" · ");
    }

    const THEME_VISUALS = {
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
        canvasClassic: "#eef2f6",
        canvasAccurate: "#e9eef3",
        canvasBase: "#eaeef2",
        panel: "#ffffff",
        text: "#1f2328",
        textSoft: "#59636e",
        accents: ["#1f883d", "#0969da", "#8250df", "#bc4c00", "#cf222e", "#1b7f83", "#bf8700"],
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
      return THEME_VISUALS[state.theme] || THEME_VISUALS["solarized-light"];
    }

    function hexToRgb(hex) {
      const normalized = hex.replace("#", "");
      if (normalized.length !== 6) {
        return { r: 0, g: 0, b: 0 };
      }
      return {
        r: Number.parseInt(normalized.slice(0, 2), 16),
        g: Number.parseInt(normalized.slice(2, 4), 16),
        b: Number.parseInt(normalized.slice(4, 6), 16)
      };
    }

    function rgbToHex(rgb) {
      const toHex = (value) => clamp(Math.round(value), 0, 255).toString(16).padStart(2, "0");
      return `#${toHex(rgb.r)}${toHex(rgb.g)}${toHex(rgb.b)}`;
    }

    function mixHexColors(left, right, ratio) {
      const amount = clampValue(ratio, 0, 1);
      const a = hexToRgb(left);
      const b = hexToRgb(right);
      return rgbToHex({
        r: a.r + (b.r - a.r) * amount,
        g: a.g + (b.g - a.g) * amount,
        b: a.b + (b.b - a.b) * amount
      });
    }

    function hexToRgba(hex, alpha) {
      const rgb = hexToRgb(hex);
      return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${clampValue(alpha, 0, 1)})`;
    }

    function themeNodeAccent(level) {
      const theme = currentThemeVisuals();
      return theme.accents[level % theme.accents.length];
    }

    function themeAnalysisBuckets() {
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

    function validTheme(theme) {
      return [
        "warm-paper",
        "vscode-dark",
        "github-light",
        "tokyo-night",
        "nord",
        "solarized-light",
        "catppuccin-latte",
      ].includes(theme);
    }

    function applyTheme() {
      document.body.dataset.theme = state.theme;
      if (themeSelect) {
        themeSelect.value = state.theme;
      }
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

    function metricDescription(metric) {
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

    function setAdvancedPopoverOpen(open) {
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

    function savePersistedState() {
      try {
        const snapshot = {
          theme: state.theme,
          metric: state.metric,
          weightedVariableWeight: state.weightedVariableWeight,
          weightedNetWeight: state.weightedNetWeight,
          layoutMode: state.layoutMode,
          decomposition: state.decomposition,
          analysisMode: state.analysisMode,
          analysisPatternMode: state.analysisPatternMode,
          analysisPattern: state.analysisPattern,
          analysisLegendFilter: state.analysisLegendFilter,
          toolbarCollapsed: state.toolbarCollapsed,
          selectMode: state.selectMode,
          advancedPopoverLeft: state.advancedPopoverLeft,
          advancedPopoverTop: state.advancedPopoverTop,
          depthLimit: state.depthLimit,
          search: state.search,
          filterScope: state.filterScope,
          filterMode: state.filterMode,
          sourceBookmarksByFile: state.sourceBookmarksByFile,
          searchHistoryByField: state.searchHistoryByField,
          treePanelOpen: state.treePanelOpen,
          matchPanelOpen: state.matchPanelOpen,
          mainViewMode: state.mainViewMode,
          chartPanelOpen: state.chartPanelOpen,
          chartMode: state.chartMode,
          chartRenderMode: state.chartRenderMode,
          chartLevel: state.chartLevel,
          chartPanelWidth: state.chartPanelWidth,
          chartPanelHeight: state.chartPanelHeight,
          chartPanelLeft: state.chartPanelLeft,
          chartPanelTop: state.chartPanelTop,
          treeCollapsedIds: Array.from(state.treeCollapsedIds),
          treePanelWidth: state.treePanelWidth,
          matchPanelWidth: state.matchPanelWidth,
          matchPanelHeight: state.matchPanelHeight,
          matchPanelLeft: state.matchPanelLeft,
          matchPanelTop: state.matchPanelTop,
          hoverCardLeft: state.hoverCardLeft,
          hoverCardTop: state.hoverCardTop,
          zenOverlayLeft: state.zenOverlayLeft,
          zenOverlayTop: state.zenOverlayTop,
          treemapAnalysisLegendLeft: state.treemapAnalysisLegendLeft,
          treemapAnalysisLegendTop: state.treemapAnalysisLegendTop
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
      } catch (_) {
      }
    }

    function restorePersistedState() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return;
        const saved = JSON.parse(raw);
        if (typeof saved.theme === "string" && validTheme(saved.theme)) {
          state.theme = saved.theme;
        }
        if (["instances", "leaves", "signals", "weighted_signals"].includes(saved.metric)) {
          state.metric = saved.metric;
        }
        if (typeof saved.weightedVariableWeight === "number" && saved.weightedVariableWeight >= 0) {
          state.weightedVariableWeight = saved.weightedVariableWeight;
        }
        if (typeof saved.weightedNetWeight === "number" && saved.weightedNetWeight >= 0) {
          state.weightedNetWeight = saved.weightedNetWeight;
        }
        if (["classic", "accurate"].includes(saved.layoutMode)) {
          state.layoutMode = saved.layoutMode;
        }
        if (["subtree", "self"].includes(saved.decomposition)) {
          state.decomposition = saved.decomposition;
        }
        if (["none", "ratio", "count", "loc"].includes(saved.analysisMode)) {
          state.analysisMode = saved.analysisMode;
        }
        if (["text", "wildcard", "regex"].includes(saved.analysisPatternMode)) {
          state.analysisPatternMode = saved.analysisPatternMode;
        }
        if (typeof saved.analysisPattern === "string") {
          state.analysisPattern = saved.analysisPattern;
        }
        state.analysisLegendFilter = normalizeAnalysisLegendFilter(saved.analysisLegendFilter);
        if (saved.sourceBookmarksByFile && typeof saved.sourceBookmarksByFile === "object") {
          state.sourceBookmarksByFile = normalizeSourceBookmarks(saved.sourceBookmarksByFile);
        }
        state.searchHistoryByField = normalizeSearchHistoryMap(saved.searchHistoryByField);
        state.toolbarCollapsed = !!saved.toolbarCollapsed;
        state.selectMode = !!saved.selectMode;
        if (typeof saved.advancedPopoverLeft === "number") state.advancedPopoverLeft = saved.advancedPopoverLeft;
        if (typeof saved.advancedPopoverTop === "number") state.advancedPopoverTop = saved.advancedPopoverTop;
        state.depthLimit = saved.depthLimit === null
          ? null
          : Number.isInteger(saved.depthLimit) && saved.depthLimit > 0
            ? saved.depthLimit
            : null;
        if (typeof saved.search === "string") state.search = saved.search;
        if (["both", "path", "instance", "module"].includes(saved.filterScope)) {
          state.filterScope = saved.filterScope;
        }
        if (["text", "wildcard", "regex"].includes(saved.filterMode)) {
          state.filterMode = saved.filterMode;
        }
        state.treePanelOpen = !!saved.treePanelOpen;
        state.matchPanelOpen = !!saved.matchPanelOpen;
        if (["treemap", "pie2d", "three3d"].includes(saved.mainViewMode)) {
          state.mainViewMode = saved.mainViewMode;
        } else if (saved.chartPanelOpen) {
          state.mainViewMode = saved.chartRenderMode === "three3d" ? "three3d" : "pie2d";
        }
        state.chartPanelOpen = state.mainViewMode !== "treemap";
        if (["weighted_bits", "analysis"].includes(saved.chartMode)) {
          state.chartMode = saved.chartMode;
        }
        if (["pie2d", "three3d"].includes(saved.chartRenderMode)) {
          state.chartRenderMode = saved.chartRenderMode;
        }
        if (saved.chartLevel === null) {
          state.chartLevel = null;
        } else if (Number.isInteger(saved.chartLevel) && saved.chartLevel > 0) {
          state.chartLevel = saved.chartLevel;
        }
        if (typeof saved.chartPanelWidth === "number") state.chartPanelWidth = saved.chartPanelWidth;
        if (typeof saved.chartPanelHeight === "number") state.chartPanelHeight = saved.chartPanelHeight;
        if (typeof saved.chartPanelLeft === "number") state.chartPanelLeft = saved.chartPanelLeft;
        if (typeof saved.chartPanelTop === "number") state.chartPanelTop = saved.chartPanelTop;
        if (Array.isArray(saved.treeCollapsedIds)) {
          state.treeCollapsedIds = new Set(
            saved.treeCollapsedIds.filter((id) => Number.isInteger(id) && id >= 0 && id < nodes.length)
          );
        }
        if (typeof saved.treePanelWidth === "number") state.treePanelWidth = saved.treePanelWidth;
        if (typeof saved.matchPanelWidth === "number") state.matchPanelWidth = saved.matchPanelWidth;
        if (typeof saved.matchPanelHeight === "number") state.matchPanelHeight = saved.matchPanelHeight;
        if (typeof saved.matchPanelLeft === "number") state.matchPanelLeft = saved.matchPanelLeft;
        if (typeof saved.matchPanelTop === "number") state.matchPanelTop = saved.matchPanelTop;
        if (typeof saved.hoverCardLeft === "number") state.hoverCardLeft = saved.hoverCardLeft;
        if (typeof saved.hoverCardTop === "number") state.hoverCardTop = saved.hoverCardTop;
        if (typeof saved.zenOverlayLeft === "number") state.zenOverlayLeft = saved.zenOverlayLeft;
        if (typeof saved.zenOverlayTop === "number") state.zenOverlayTop = saved.zenOverlayTop;
        if (typeof saved.treemapAnalysisLegendLeft === "number") {
          state.treemapAnalysisLegendLeft = saved.treemapAnalysisLegendLeft;
        }
        if (typeof saved.treemapAnalysisLegendTop === "number") {
          state.treemapAnalysisLegendTop = saved.treemapAnalysisLegendTop;
        }
        expandTreePath(state.currentRoot);
      } catch (_) {
      }
    }

    function formatLocation(node) {
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
    pageTitle.textContent = "Hierarchy Viewer";
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

    function syncLinkedAnalysisPatternInputs(value, source = null) {
      analysisPatternInput.value = value;
      const chartInput = document.getElementById("chart-analysis-pattern-input");
      if (chartInput && chartInput !== source) {
        chartInput.value = value;
      }
    }

    function applySourceSearchValue(value, options = {}) {
      state.sourceSearch = value;
      sourceSearchInput.value = value;
      state.sourceSearchMatchIndex = 0;
      if (sourceSearchInputTimer !== null) {
        clearTimeout(sourceSearchInputTimer);
        sourceSearchInputTimer = null;
      }
      if (options.immediate) {
        renderCurrentSourceView(false);
        return;
      }
      sourceSearchInputTimer = setTimeout(() => {
        sourceSearchInputTimer = null;
        renderCurrentSourceView(false);
      }, SOURCE_SEARCH_INPUT_DEBOUNCE_MS);
    }

    function applyFilterSearchValue(value) {
      state.search = value;
      searchInput.value = value;
      buildMatches();
      savePersistedState();
      draw();
    }

    function applyAnalysisPatternValue(value, source = null) {
      state.analysisPattern = value;
      syncLinkedAnalysisPatternInputs(value, source);
      buildSignalAnalysis();
      syncAnalysisControls();
      savePersistedState();
      draw();
    }

    window.applySharedAnalysisPatternValue = (value, source = null) => {
      applyAnalysisPatternValue(value, source);
    };

    function applyMainViewMode() {
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

    function setZenMode(enabled) {
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

    function setMainViewMode(mode) {
      const nextMode = ["treemap", "pie2d", "three3d"].includes(mode) ? mode : "treemap";
      state.mainViewMode = nextMode;
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

    function nodeHasInstanceSource(node) {
      return !!(node && node.filePath && node.sourceHref);
    }

    function nodeHasDefinitionSource(node) {
      return !!(node && node.definitionFilePath && node.definitionSourceHref);
    }

    function nodeHasAnySource(node) {
      return nodeHasInstanceSource(node) || nodeHasDefinitionSource(node);
    }

    function buildSourceTarget(node, kind) {
      if (!node) {
        return null;
      }
      if (kind === "definition") {
        if (!nodeHasDefinitionSource(node)) {
          return null;
        }
        return {
          kind: "definition",
          filePath: node.definitionFilePath,
          sourceHref: node.definitionSourceHref,
          line: node.definitionLine || 1,
          column: node.definitionColumn || 1,
          endLine: node.definitionEndLine || node.definitionLine || 1,
          endColumn: node.definitionEndColumn || node.definitionColumn || 1,
          snippetText: node.definitionSnippetText || "",
          snippetStartLine: node.definitionSnippetStartLine || node.definitionLine || 1,
          snippetEndLine: node.definitionSnippetEndLine || node.definitionEndLine || node.definitionLine || 1,
          titleSuffix: "Module Source",
          locationLabel: "module source"
        };
      }
      if (!nodeHasInstanceSource(node)) {
        return null;
      }
      return {
        kind: "instance",
        filePath: node.filePath,
        sourceHref: node.sourceHref,
        line: node.line || 1,
        column: node.column || 1,
        endLine: node.endLine || node.line || 1,
        endColumn: node.endColumn || node.column || 1,
        snippetText: node.snippetText || "",
        snippetStartLine: node.snippetStartLine || node.line || 1,
        snippetEndLine: node.snippetEndLine || node.endLine || node.line || 1,
        titleSuffix: "Instantiation",
        locationLabel: "instantiation"
      };
    }

    function preferredSourceTargetKind(node) {
      if (nodeHasDefinitionSource(node)) {
        return "definition";
      }
      if (nodeHasInstanceSource(node)) {
        return "instance";
      }
      return null;
    }

    function normalizeSourceBookmarkPreview(text, useBlankFallback = false) {
      const compact = String(text ?? "").replace(/\s+/g, " ").trim();
      if (compact.length > 0) {
        return compact;
      }
      return useBlankFallback ? "(blank line)" : "";
    }

    function normalizeSourceBookmarkEntry(entry) {
      if (Number.isInteger(entry) && entry > 0) {
        return { line: entry, label: "", preview: "" };
      }
      if (!entry || typeof entry !== "object") {
        return null;
      }
      const line = Number(entry.line);
      if (!Number.isInteger(line) || line <= 0) {
        return null;
      }
      return {
        line,
        label: typeof entry.label === "string" ? entry.label.trim() : "",
        preview: typeof entry.preview === "string"
          ? normalizeSourceBookmarkPreview(entry.preview, false)
          : ""
      };
    }

    function normalizeSourceBookmarks(raw) {
      if (!raw || typeof raw !== "object") {
        return {};
      }
      const normalized = {};
      for (const [key, value] of Object.entries(raw)) {
        if (typeof key !== "string" || key.length === 0 || !Array.isArray(value)) {
          continue;
        }
        const bookmarkMap = new Map();
        for (const item of value) {
          const bookmark = normalizeSourceBookmarkEntry(item);
          if (!bookmark) {
            continue;
          }
          bookmarkMap.set(bookmark.line, bookmark);
        }
        const bookmarks = Array.from(bookmarkMap.values()).sort((left, right) => left.line - right.line);
        if (bookmarks.length) {
          normalized[key] = bookmarks;
        }
      }
      return normalized;
    }

    function sourceBookmarkKeyForTarget(target) {
      if (!target) {
        return null;
      }
      if (target.sourceHref) {
        return `${target.kind}:href:${target.sourceHref}`;
      }
      if (target.filePath) {
        return `${target.kind}:path:${target.filePath}`;
      }
      return null;
    }

    function resolveSourceUrl(target) {
      if (!target || !target.sourceHref) {
        return null;
      }
      try {
        return new URL(target.sourceHref, window.location.href).href;
      } catch (_) {
        return target.sourceHref;
      }
    }

    function showSourceStatus(message) {
      if (!message) {
        sourceStatus.textContent = "";
        sourceStatus.classList.add("hidden");
        return;
      }
      sourceStatus.textContent = message;
      sourceStatus.classList.remove("hidden");
    }

    function setSourceLoadProgress(percent, stage, detail = "") {
      if (!sourceLoadProgress) {
        return;
      }
      const clamped = Math.max(0, Math.min(100, percent));
      sourceLoadProgress.classList.remove("hidden");
      sourceLoadBarFill.style.width = `${clamped}%`;
      sourceLoadStage.textContent = stage;
      sourceLoadDetail.textContent = detail;
    }

    function hideSourceLoadProgress() {
      if (!sourceLoadProgress) {
        return;
      }
      sourceLoadProgress.classList.add("hidden");
      sourceLoadBarFill.style.width = "0%";
      sourceLoadStage.textContent = "Loading source...";
      sourceLoadDetail.textContent = "";
    }

    function nextFrame() {
      return new Promise((resolve) => {
        requestAnimationFrame(() => resolve());
      });
    }

    function normalizeSearchHistoryMap(raw) {
      if (!raw || typeof raw !== "object") {
        return {};
      }
      const normalized = {};
      for (const [key, entries] of Object.entries(raw)) {
        if (!Array.isArray(entries)) {
          continue;
        }
        const seen = new Set();
        const cleaned = [];
        for (const entry of entries) {
          if (typeof entry !== "string") {
            continue;
          }
          const trimmed = entry.trim();
          if (!trimmed || seen.has(trimmed)) {
            continue;
          }
          seen.add(trimmed);
          cleaned.push(trimmed);
          if (cleaned.length >= SEARCH_HISTORY_LIMIT) {
            break;
          }
        }
        if (cleaned.length) {
          normalized[key] = cleaned;
        }
      }
      return normalized;
    }

    function normalizeAnalysisLegendFilter(raw) {
      if (Array.isArray(raw)) {
        const seen = new Set();
        const normalized = [];
        for (const entry of raw) {
          if (typeof entry !== "string") {
            continue;
          }
          if (entry !== "descendant" && !/^bucket-[1-4]$/.test(entry)) {
            continue;
          }
          if (seen.has(entry)) {
            continue;
          }
          seen.add(entry);
          normalized.push(entry);
        }
        return normalized;
      }
      if (
        raw === "descendant" ||
        (typeof raw === "string" && /^bucket-[1-4]$/.test(raw))
      ) {
        return [raw];
      }
      return [];
    }

    function analysisLegendFilterSet() {
      return new Set(normalizeAnalysisLegendFilter(state.analysisLegendFilter));
    }

    function hasAnalysisLegendFilter(filterKey) {
      if (!filterKey) {
        return false;
      }
      return analysisLegendFilterSet().has(filterKey);
    }

    function toggleAnalysisLegendFilter(filterKey) {
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

    function searchHistoryEntries(historyKey) {
      return state.searchHistoryByField[historyKey] || [];
    }

    function commitSearchHistoryEntry(historyKey, value) {
      if (!historyKey) {
        return;
      }
      const trimmed = typeof value === "string" ? value.trim() : "";
      if (!trimmed) {
        return;
      }
      const nextEntries = [
        trimmed,
        ...searchHistoryEntries(historyKey).filter((entry) => entry !== trimmed),
      ].slice(0, SEARCH_HISTORY_LIMIT);
      state.searchHistoryByField[historyKey] = nextEntries;
      savePersistedState();
    }

    function searchHistorySession(historyKey) {
      if (!searchHistorySessions.has(historyKey)) {
        searchHistorySessions.set(historyKey, {
          index: -1,
          draft: "",
        });
      }
      return searchHistorySessions.get(historyKey);
    }

    function resetSearchHistorySession(historyKey, draft = "") {
      const session = searchHistorySession(historyKey);
      session.index = -1;
      session.draft = draft;
    }

    function buildSourceLineOffsets(lines) {
      const offsets = new Array(lines.length);
      let cursor = 0;
      for (let index = 0; index < lines.length; index += 1) {
        offsets[index] = cursor;
        cursor += lines[index].length;
        if (index + 1 < lines.length) {
          cursor += 1;
        }
      }
      return offsets;
    }

    function ensureSourceLineOffsets(view) {
      if (!view) {
        return [];
      }
      if (!Array.isArray(view.lineOffsets)) {
        view.lineOffsets = buildSourceLineOffsets(view.lines || []);
      }
      return view.lineOffsets;
    }

    function estimateSourceTextLength(view) {
      if (!view) {
        return 0;
      }
      if (Number.isInteger(view.textLength) && view.textLength >= 0) {
        return view.textLength;
      }
      if (typeof view.text === "string") {
        view.textLength = view.text.length;
        return view.textLength;
      }
      const lines = Array.isArray(view.lines) ? view.lines : [];
      let total = lines.length > 0 ? lines.length - 1 : 0;
      for (let index = 0; index < lines.length; index += 1) {
        total += lines[index].length;
      }
      view.textLength = total;
      return total;
    }

    function ensureSourceText(view) {
      if (!view) {
        return "";
      }
      if (typeof view.text !== "string") {
        view.text = Array.isArray(view.lines) ? view.lines.join("\n") : "";
      }
      view.textLength = view.text.length;
      return view.text;
    }

    function currentStructuredSourceMatches() {
      return currentSourceView?.searchMatchRecords || [];
    }

    function currentStructuredSourceMatchMap() {
      return currentSourceView?.searchMatchRangesByLine || new Map();
    }

    function navigateSearchHistory(historyKey, direction, getCurrentValue, applyValue) {
      const entries = searchHistoryEntries(historyKey);
      if (!entries.length) {
        return false;
      }
      const session = searchHistorySession(historyKey);
      if (session.index === -1) {
        session.draft = getCurrentValue();
      }
      if (direction < 0) {
        if (session.index >= entries.length - 1) {
          return false;
        }
        session.index += 1;
      } else {
        if (session.index === -1) {
          return false;
        }
        session.index -= 1;
      }
      const nextValue = session.index === -1 ? session.draft : entries[session.index];
      applyValue(nextValue, { fromHistory: true });
      return true;
    }

    function registerSearchHistoryInput(input, historyKey, options = {}) {
      if (!input || !historyKey || typeof options.apply !== "function") {
        return;
      }
      const getCurrentValue = typeof options.getValue === "function"
        ? options.getValue
        : () => input.value;
      const commit = (rawValue = getCurrentValue()) => {
        commitSearchHistoryEntry(historyKey, rawValue);
        resetSearchHistorySession(historyKey, getCurrentValue());
      };
      input.addEventListener("input", () => {
        resetSearchHistorySession(historyKey, getCurrentValue());
      });
      input.addEventListener("blur", () => {
        commit();
      });
      input.addEventListener("keydown", (event) => {
        if (event.altKey || event.ctrlKey || event.metaKey) {
          return;
        }
        if (event.key === "ArrowUp" || event.key === "ArrowDown") {
          const moved = navigateSearchHistory(
            historyKey,
            event.key === "ArrowUp" ? -1 : 1,
            getCurrentValue,
            options.apply,
          );
          if (moved) {
            event.preventDefault();
          }
          return;
        }
        if (event.key === "Enter") {
          commit();
        }
      });
    }

    window.registerSearchHistoryInput = registerSearchHistoryInput;

    function currentSourceBookmarkKey() {
      if (currentSourceView && currentSourceView.bookmarkKey) {
        return currentSourceView.bookmarkKey;
      }
      if (state.sourceNodeId === null || state.sourceNodeId === undefined) {
        return null;
      }
      return sourceBookmarkKeyForTarget(
        buildSourceTarget(getNode(state.sourceNodeId), state.sourceTargetKind || "instance")
      );
    }

    function currentSourceBookmarkLines() {
      return currentSourceBookmarks().map((bookmark) => bookmark.line);
    }

    function currentSourceBookmarks() {
      const bookmarkKey = currentSourceBookmarkKey();
      if (!bookmarkKey) {
        return [];
      }
      return state.sourceBookmarksByFile[bookmarkKey] || [];
    }

    function findCurrentSourceBookmark(lineNo) {
      return currentSourceBookmarks().find((bookmark) => bookmark.line === lineNo) || null;
    }

    function sourceBookmarkPreviewForLine(lineNo) {
      if (!currentSourceView || !Array.isArray(currentSourceView.lines)) {
        return "";
      }
      const index = lineNo - currentSourceView.firstLineNumber;
      if (index < 0 || index >= currentSourceView.lines.length) {
        return "";
      }
      return normalizeSourceBookmarkPreview(currentSourceView.lines[index], true);
    }

    function syncCurrentSourceBookmarkPreviews() {
      const bookmarkKey = currentSourceBookmarkKey();
      if (!bookmarkKey) {
        return;
      }
      const bookmarks = state.sourceBookmarksByFile[bookmarkKey];
      if (!Array.isArray(bookmarks) || !bookmarks.length) {
        return;
      }
      let changed = false;
      for (const bookmark of bookmarks) {
        const preview = sourceBookmarkPreviewForLine(bookmark.line);
        if (!preview || bookmark.preview === preview) {
          continue;
        }
        bookmark.preview = preview;
        changed = true;
      }
      if (changed) {
        savePersistedState();
      }
    }

    function sourceBookmarkDisplayTitle(bookmark) {
      return bookmark.label || bookmark.preview || `Line ${bookmark.line}`;
    }

    function sourceBookmarkDisplayMeta(bookmark) {
      if (bookmark.label) {
        return bookmark.preview
          ? `L${bookmark.line} · ${bookmark.preview}`
          : `Line ${bookmark.line}`;
      }
      return `Line ${bookmark.line}`;
    }

    function clearSourceBookmarkRename() {
      state.sourceBookmarkEditingKey = null;
      state.sourceBookmarkEditingLine = null;
      state.sourceBookmarkEditingDraft = "";
    }

    function startSourceBookmarkRename(lineNo) {
      const bookmark = findCurrentSourceBookmark(lineNo);
      if (!bookmark) {
        return;
      }
      const bookmarkKey = currentSourceBookmarkKey();
      if (!bookmarkKey) {
        return;
      }
      state.sourceBookmarkEditingKey = bookmarkKey;
      state.sourceBookmarkEditingLine = lineNo;
      state.sourceBookmarkEditingDraft = bookmark.label;
      renderSourceBookmarkBar();
    }

    function commitSourceBookmarkRename(lineNo) {
      const bookmarkKey = currentSourceBookmarkKey();
      const bookmark = findCurrentSourceBookmark(lineNo);
      if (!bookmarkKey || !bookmark || state.sourceBookmarkEditingKey !== bookmarkKey) {
        clearSourceBookmarkRename();
        renderSourceBookmarkBar();
        return;
      }
      const label = state.sourceBookmarkEditingDraft.trim();
      bookmark.label = label;
      clearSourceBookmarkRename();
      renderSourceBookmarkBar();
      savePersistedState();
      showSourceStatus(label
        ? `Renamed bookmark at line ${lineNo}.`
        : `Cleared custom name for bookmark line ${lineNo}.`);
    }

    function setSourceLineBookmarkState(lineElement, bookmarked) {
      if (!lineElement) {
        return;
      }
      lineElement.classList.toggle("bookmarked", bookmarked);
      const gutterButton = lineElement.querySelector(".source-lineno");
      if (!gutterButton) {
        return;
      }
      gutterButton.classList.toggle("bookmarked", bookmarked);
      gutterButton.setAttribute("aria-pressed", bookmarked ? "true" : "false");
      const lineNo = Number(lineElement.dataset.line);
      gutterButton.title = bookmarked
        ? `Remove bookmark at line ${lineNo}`
        : `Bookmark line ${lineNo}`;
    }

    function sourceBookmarkEmptyMessage() {
      if (currentSourceView?.renderMode === "plain") {
        return "Plain large-source mode disables inline line bookmarking.";
      }
      return "Click a line number to bookmark it.";
    }

    function renderSourceBookmarkBar() {
      if (!sourceBookmarkList) {
        return;
      }
      const bookmarkKey = currentSourceBookmarkKey();
      const lines = bookmarkKey ? currentSourceBookmarkLines() : [];
      sourceBookmarkList.innerHTML = "";
      if (!bookmarkKey) {
        sourceBookmarkList.innerHTML = '<span class="source-bookmark-empty">Bookmarks follow the current file.</span>';
        return;
      }
      const bookmarks = currentSourceBookmarks();
      if (!bookmarks.length) {
        sourceBookmarkList.innerHTML = `<span class="source-bookmark-empty">${escapeHtml(sourceBookmarkEmptyMessage())}</span>`;
        return;
      }
      const fragment = document.createDocumentFragment();
      for (const bookmark of bookmarks) {
        const lineNo = bookmark.line;
        const isEditing = state.sourceBookmarkEditingKey === bookmarkKey
          && state.sourceBookmarkEditingLine === lineNo;
        const card = document.createElement("div");
        card.className = "source-bookmark-card";
        if (isEditing) {
          card.classList.add("editing");
        }
        if (isEditing) {
          const editor = document.createElement("div");
          editor.className = "source-bookmark-editor";

          const lineBadge = document.createElement("span");
          lineBadge.className = "source-bookmark-line";
          lineBadge.textContent = `L${lineNo}`;

          const input = document.createElement("input");
          input.type = "text";
          input.className = "source-bookmark-input";
          input.value = state.sourceBookmarkEditingDraft;
          input.placeholder = bookmark.preview || `Bookmark line ${lineNo}`;
          input.title = "Enter a custom bookmark name. Leave empty to show the source preview.";
          input.addEventListener("input", () => {
            state.sourceBookmarkEditingDraft = input.value;
          });
          input.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commitSourceBookmarkRename(lineNo);
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              clearSourceBookmarkRename();
              renderSourceBookmarkBar();
            }
          });

          const saveButton = document.createElement("button");
          saveButton.type = "button";
          saveButton.className = "source-bookmark-save";
          saveButton.textContent = "Save";
          saveButton.addEventListener("click", () => {
            commitSourceBookmarkRename(lineNo);
          });

          const cancelButton = document.createElement("button");
          cancelButton.type = "button";
          cancelButton.className = "source-bookmark-cancel";
          cancelButton.textContent = "Cancel";
          cancelButton.addEventListener("click", () => {
            clearSourceBookmarkRename();
            renderSourceBookmarkBar();
          });

          const hint = document.createElement("div");
          hint.className = "source-bookmark-editor-hint";
          hint.textContent = bookmark.preview
            ? `Preview: ${bookmark.preview}`
            : `Preview unavailable for line ${lineNo} in the current inline view.`;

          editor.appendChild(lineBadge);
          editor.appendChild(input);
          editor.appendChild(saveButton);
          editor.appendChild(cancelButton);
          card.appendChild(editor);
          card.appendChild(hint);
          fragment.appendChild(card);
          continue;
        }

        const mainButton = document.createElement("button");
        mainButton.type = "button";
        mainButton.className = "source-bookmark-main";
        mainButton.title = `${sourceBookmarkDisplayTitle(bookmark)} · ${sourceBookmarkDisplayMeta(bookmark)}`;
        if (
          currentSourceView &&
          lineNo >= currentSourceView.focusStartLine &&
          lineNo <= currentSourceView.focusEndLine
        ) {
          card.classList.add("current");
          mainButton.classList.add("current");
        }
        mainButton.addEventListener("click", () => {
          focusSourceBookmark(lineNo);
        });

        const lineBadge = document.createElement("span");
        lineBadge.className = "source-bookmark-line";
        lineBadge.textContent = `L${lineNo}`;

        const copy = document.createElement("span");
        copy.className = "source-bookmark-copy";

        const title = document.createElement("span");
        title.className = "source-bookmark-title";
        title.textContent = sourceBookmarkDisplayTitle(bookmark);

        const meta = document.createElement("span");
        meta.className = "source-bookmark-meta";
        meta.textContent = sourceBookmarkDisplayMeta(bookmark);

        copy.appendChild(title);
        copy.appendChild(meta);
        mainButton.appendChild(lineBadge);
        mainButton.appendChild(copy);

        const actions = document.createElement("div");
        actions.className = "source-bookmark-actions";

        const editButton = document.createElement("button");
        editButton.type = "button";
        editButton.className = "source-bookmark-action";
        editButton.textContent = "Edit";
        editButton.title = `Rename bookmark at line ${lineNo}`;
        editButton.addEventListener("click", () => {
          startSourceBookmarkRename(lineNo);
        });

        const deleteButton = document.createElement("button");
        deleteButton.type = "button";
        deleteButton.className = "source-bookmark-action remove";
        deleteButton.textContent = "Del";
        deleteButton.title = `Delete bookmark at line ${lineNo}`;
        deleteButton.setAttribute("aria-label", `Delete bookmark at line ${lineNo}`);
        deleteButton.addEventListener("click", () => {
          toggleSourceBookmark(lineNo);
        });

        card.appendChild(mainButton);
        actions.appendChild(editButton);
        actions.appendChild(deleteButton);
        card.appendChild(actions);
        fragment.appendChild(card);
      }
      sourceBookmarkList.appendChild(fragment);
      if (state.sourceBookmarkEditingKey === bookmarkKey && state.sourceBookmarkEditingLine !== null) {
        const input = sourceBookmarkList.querySelector(".source-bookmark-input");
        if (input) {
          requestAnimationFrame(() => {
            input.focus();
            input.select();
          });
        }
      }
    }

    function syncSourceBookmarksInView() {
      if (isPlainTextSourceView()) {
        renderSourceBookmarkBar();
        return;
      }
      const bookmarkSet = new Set(currentSourceBookmarkLines());
      for (const lineElement of sourceCode.querySelectorAll(".source-line[data-line]")) {
        const lineNo = Number(lineElement.dataset.line);
        setSourceLineBookmarkState(lineElement, bookmarkSet.has(lineNo));
      }
      renderSourceBookmarkBar();
    }

    function focusSourceBookmark(lineNo) {
      if (isPlainTextSourceView()) {
        const range = plainSourceLineRange(currentSourceView, lineNo);
        if (!range) {
          showSourceStatus(`Bookmark line ${lineNo} is outside the current inline view. Use Open Raw for the full file.`);
          renderSourceBookmarkBar();
          return;
        }
        selectPlainSourceRange(range.start, range.end, true, lineNo);
        showSourceStatus(`Jumped to bookmark line ${lineNo}.`);
        renderSourceBookmarkBar();
        return;
      }
      for (const element of sourceCode.querySelectorAll(".source-line.bookmark-jump")) {
        element.classList.remove("bookmark-jump");
      }
      scrollSourceLineIntoView(lineNo, "center");
      const target = sourceCode.querySelector(`.source-line[data-line="${lineNo}"]`);
      if (!target) {
        showSourceStatus(`Bookmark line ${lineNo} is outside the current inline view. Use Open Raw for the full file.`);
        renderSourceBookmarkBar();
        return;
      }
      target.classList.add("bookmark-jump");
      showSourceStatus(`Jumped to bookmark line ${lineNo}.`);
      renderSourceBookmarkBar();
    }

    function clearSourceFocusJump() {
      for (const element of sourceCode.querySelectorAll(".source-line.focus-jump")) {
        element.classList.remove("focus-jump");
      }
    }

    function emphasizeFocusedSourceRange() {
      if (!currentSourceView) {
        return false;
      }
      const startLine = currentSourceView.focusStartLine || currentSourceView.firstLineNumber || 1;
      const endLine = Math.max(startLine, currentSourceView.focusEndLine || startLine);
      if (isPlainTextSourceView()) {
        const startRange = plainSourceLineRange(currentSourceView, startLine);
        const endRange = plainSourceLineRange(currentSourceView, endLine) || startRange;
        if (!startRange || !endRange) {
          return false;
        }
        selectPlainSourceRange(startRange.start, endRange.end, true, startLine);
        return true;
      }
      clearSourceFocusJump();
      scrollSourceLineIntoView(startLine, "center");
      let emphasized = false;
      const visibleEndLine = Math.min(endLine, startLine + 31);
      for (let lineNo = startLine; lineNo <= visibleEndLine; lineNo += 1) {
        const element = sourceCode.querySelector(`.source-line[data-line="${lineNo}"]`);
        if (!element) {
          continue;
        }
        element.classList.add("focus-jump");
        emphasized = true;
      }
      return emphasized;
    }

    function toggleSourceBookmark(lineNo) {
      const bookmarkKey = currentSourceBookmarkKey();
      if (!bookmarkKey || !Number.isInteger(lineNo) || lineNo <= 0) {
        return;
      }
      const bookmarks = [...currentSourceBookmarks()];
      const existingIndex = bookmarks.findIndex((bookmark) => bookmark.line === lineNo);
      if (existingIndex >= 0) {
        bookmarks.splice(existingIndex, 1);
        if (
          state.sourceBookmarkEditingKey === bookmarkKey
          && state.sourceBookmarkEditingLine === lineNo
        ) {
          clearSourceBookmarkRename();
        }
        showSourceStatus(`Removed bookmark at line ${lineNo}.`);
      } else {
        bookmarks.push({
          line: lineNo,
          label: "",
          preview: sourceBookmarkPreviewForLine(lineNo)
        });
        bookmarks.sort((left, right) => left.line - right.line);
        showSourceStatus(`Bookmarked line ${lineNo}.`);
      }
      if (bookmarks.length) {
        state.sourceBookmarksByFile[bookmarkKey] = bookmarks;
      } else {
        delete state.sourceBookmarksByFile[bookmarkKey];
      }
      syncSourceBookmarksInView();
      savePersistedState();
    }

    function escapeHtml(text) {
      return text
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll("\"", "&quot;")
        .replaceAll("'", "&#39;");
    }

    function buildSourceSearchRegExp() {
      const raw = state.sourceSearch.trim();
      if (!raw) {
        return { regex: null, error: "" };
      }
      try {
        if (state.sourceSearchMode === "regex") {
          return { regex: new RegExp(raw, "gi"), error: "" };
        }
        const fragment = raw
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replaceAll("*", ".*?")
          .replaceAll("?", ".");
        return { regex: new RegExp(fragment, "gi"), error: "" };
      } catch (error) {
        return {
          regex: null,
          error: `Invalid source search: ${error instanceof Error ? error.message : String(error)}`
        };
      }
    }

    function collectSourceSearchRanges(rawLine, searchRegex) {
      if (!searchRegex || !rawLine.length) {
        return [];
      }
      const regex = new RegExp(searchRegex.source, searchRegex.flags);
      const ranges = [];
      let match;
      while ((match = regex.exec(rawLine)) !== null) {
        const text = match[0] || "";
        if (!text.length) {
          if (regex.lastIndex >= rawLine.length) {
            break;
          }
          regex.lastIndex += 1;
          continue;
        }
        const start = match.index ?? 0;
        ranges.push({ start, end: start + text.length });
        if (!regex.global) {
          break;
        }
      }
      return ranges;
    }

    function renderSourceStyledSlice(text, className) {
      if (!text) {
        return "";
      }
      const escaped = escapeHtml(text);
      return className ? `<span class="${className}">${escaped}</span>` : escaped;
    }

    function renderSourceSegmentWithSearch(text, segmentStart, className, matchRanges) {
      if (!text.length) {
        return "";
      }
      let out = "";
      let cursor = 0;
      const segmentEnd = segmentStart + text.length;
      for (const range of matchRanges) {
        if (range.end <= segmentStart) {
          continue;
        }
        if (range.start >= segmentEnd) {
          break;
        }
        const localStart = Math.max(range.start, segmentStart) - segmentStart;
        const localEnd = Math.min(range.end, segmentEnd) - segmentStart;
        if (localStart > cursor) {
          out += renderSourceStyledSlice(text.slice(cursor, localStart), className);
        }
        if (localEnd > localStart) {
          const matchIndex = Number.isInteger(range.matchIndex) ? range.matchIndex : null;
          const currentClass = matchIndex !== null && matchIndex === state.sourceSearchMatchIndex
            ? " current"
            : "";
          const matchAttr = matchIndex !== null ? ` data-match-index="${matchIndex}"` : "";
          out += `<mark class="source-find-hit${currentClass}"${matchAttr}>${renderSourceStyledSlice(text.slice(localStart, localEnd), className)}</mark>`;
        }
        cursor = localEnd;
      }
      if (cursor < text.length) {
        out += renderSourceStyledSlice(text.slice(cursor), className);
      }
      return out;
    }

    function highlightVerilogLine(rawLine, matchRanges = []) {
      const pattern = /"(?:\\.|[^"])*"|\/\/.*|`[A-Za-z_][A-Za-z0-9_]*|\b(?:alias|always|always_comb|always_ff|always_latch|assign|assume|assert|automatic|before|begin|bit|break|byte|case|casex|casez|checker|class|clocking|const|constraint|continue|cover|covergroup|coverpoint|cross|default|disable|do|else|end|endcase|endchecker|endclass|endclocking|endfunction|endgenerate|endgroup|endinterface|endmodule|endpackage|endprogram|endproperty|endsequence|endtask|enum|event|export|extends|final|for|force|foreach|forever|fork|function|genvar|generate|if|ignore_bins|illegal_bins|implements|import|inout|input|inside|int|integer|interface|join|join_any|join_none|local|localparam|logic|longint|modport|module|new|null|output|package|parameter|priority|program|property|protected|pure|rand|randc|randcase|randsequence|real|realtime|ref|reg|release|repeat|return|sequence|shortint|shortreal|signed|solve|static|string|struct|super|supply0|supply1|task|this|time|tri|typedef|union|unique|unsigned|uwire|var|virtual|void|wait|while|wire|with|within|wor|wand)\b|\b\d+(?:'[bdhoBDHO][0-9a-fA-F_xXzZ?]+)?\b/g;
      let out = "";
      let last = 0;
      for (const match of rawLine.matchAll(pattern)) {
        const index = match.index ?? 0;
        out += renderSourceSegmentWithSearch(
          rawLine.slice(last, index),
          last,
          null,
          matchRanges
        );
        const token = match[0];
        let cls = "tok-keyword";
        if (token.startsWith("//")) {
          cls = "tok-comment";
        } else if (token.startsWith("\"")) {
          cls = "tok-string";
        } else if (token.startsWith("`")) {
          cls = "tok-directive";
        } else if (/^\d/.test(token)) {
          cls = "tok-number";
        }
        out += renderSourceSegmentWithSearch(token, index, cls, matchRanges);
        last = index + token.length;
      }
      out += renderSourceSegmentWithSearch(
        rawLine.slice(last),
        last,
        null,
        matchRanges
      );
      return out.length ? out : "&nbsp;";
    }

    function updateSourceSearchStatus() {
      const activeQuery = state.sourceSearch.trim();
      const totalMatches = currentSourceSearchTotalMatches();
      sourceSearchStatus.classList.toggle("error", !!state.sourceSearchError);
      if (state.sourceSearchError) {
        sourceSearchStatus.textContent = state.sourceSearchError;
      } else if (!activeQuery) {
        sourceSearchStatus.textContent = "Search current view";
      } else if (!totalMatches) {
        sourceSearchStatus.textContent = "0 matches";
      } else {
        sourceSearchStatus.textContent = `${state.sourceSearchMatchIndex + 1}/${totalMatches} matches`;
      }
      const disabled = !totalMatches || !!state.sourceSearchError;
      sourceSearchPrevBtn.disabled = disabled;
      sourceSearchNextBtn.disabled = disabled;
    }

    function isPlainTextSourceView() {
      return !!(currentSourceView && currentSourceView.renderMode === "plain");
    }

    function plainSourceTextarea() {
      return sourceCode.querySelector(".source-plain-text");
    }

    function plainSourceLineRange(view, lineNo) {
      if (!view || !Array.isArray(view.lines)) {
        return null;
      }
      const lineOffsets = ensureSourceLineOffsets(view);
      const index = lineNo - view.firstLineNumber;
      if (index < 0 || index >= view.lines.length) {
        return null;
      }
      const start = lineOffsets[index];
      const end = start + view.lines[index].length;
      return { start, end, index };
    }

    function measurePlainSourceMetrics(view, textarea) {
      if (!view || !textarea) {
        return null;
      }
      const cached = view.plainMetrics;
      if (
        cached
        && cached.width === textarea.clientWidth
        && cached.height === textarea.clientHeight
      ) {
        return cached;
      }
      const style = window.getComputedStyle(textarea);
      const metrics = {
        lineHeight: Number.parseFloat(style.lineHeight) || 21.33,
        paddingTop: Number.parseFloat(style.paddingTop) || 0,
        paddingBottom: Number.parseFloat(style.paddingBottom) || 0,
        width: textarea.clientWidth,
        height: textarea.clientHeight,
      };
      view.plainMetrics = metrics;
      return metrics;
    }

    function plainSourceScrollTopForLine(view, textarea, lineNo, block = "center") {
      if (!view || !textarea) {
        return null;
      }
      const index = lineNo - view.firstLineNumber;
      if (index < 0 || index >= view.lines.length) {
        return null;
      }
      const metrics = measurePlainSourceMetrics(view, textarea);
      if (!metrics) {
        return null;
      }
      const viewportHeight = Math.max(
        1,
        textarea.clientHeight - metrics.paddingTop - metrics.paddingBottom,
      );
      const maxScrollTop = Math.max(0, textarea.scrollHeight - textarea.clientHeight);
      const lineTop = metrics.paddingTop + index * metrics.lineHeight;
      if (block === "start") {
        return Math.max(0, Math.min(maxScrollTop, lineTop));
      }
      if (block === "nearest") {
        const currentTop = textarea.scrollTop;
        const currentBottom = currentTop + textarea.clientHeight;
        const lineBottom = lineTop + metrics.lineHeight;
        if (lineTop >= currentTop && lineBottom <= currentBottom) {
          return currentTop;
        }
      }
      const centered = lineTop - Math.max(0, (viewportHeight - metrics.lineHeight) / 2);
      return Math.max(0, Math.min(maxScrollTop, centered));
    }

    function scrollPlainSourceLineIntoView(lineNo, block = "center") {
      const textarea = plainSourceTextarea();
      if (!textarea || !currentSourceView) {
        return;
      }
      const nextScrollTop = plainSourceScrollTopForLine(
        currentSourceView,
        textarea,
        lineNo,
        block,
      );
      if (nextScrollTop === null) {
        return;
      }
      textarea.scrollTop = nextScrollTop;
    }

    function selectPlainSourceRange(start, end, scrollIntoView = true, lineNo = null) {
      const textarea = plainSourceTextarea();
      if (!textarea) {
        return;
      }
      try {
        textarea.focus({ preventScroll: !scrollIntoView });
      } catch (_) {
        textarea.focus();
      }
      textarea.setSelectionRange(start, end);
      if (scrollIntoView && Number.isInteger(lineNo)) {
        scrollPlainSourceLineIntoView(lineNo, "center");
      }
    }

    function buildPlainSourceSearchMatches(view, search) {
      if (!view || !search.regex || search.error) {
        return [];
      }
      const lineOffsets = ensureSourceLineOffsets(view);
      const matches = [];
      for (let index = 0; index < view.lines.length; index += 1) {
        const ranges = collectSourceSearchRanges(view.lines[index], search.regex);
        if (!ranges.length) {
          continue;
        }
        const lineOffset = lineOffsets[index];
        const lineNo = view.firstLineNumber + index;
        for (const range of ranges) {
          matches.push({
            lineNo,
            start: lineOffset + range.start,
            end: lineOffset + range.end,
          });
        }
      }
      return matches;
    }

    function buildStructuredSourceSearchMatches(view, search) {
      const records = [];
      const rangesByLine = new Map();
      if (!view || !search.regex || search.error) {
        return { records, rangesByLine };
      }
      for (let index = 0; index < view.lines.length; index += 1) {
        const ranges = collectSourceSearchRanges(view.lines[index], search.regex);
        if (!ranges.length) {
          continue;
        }
        const lineNo = view.firstLineNumber + index;
        const enrichedRanges = new Array(ranges.length);
        for (let rangeIndex = 0; rangeIndex < ranges.length; rangeIndex += 1) {
          const range = ranges[rangeIndex];
          const enriched = {
            start: range.start,
            end: range.end,
            lineNo,
            matchIndex: records.length,
          };
          records.push(enriched);
          enrichedRanges[rangeIndex] = enriched;
        }
        rangesByLine.set(lineNo, enrichedRanges);
      }
      return { records, rangesByLine };
    }

    function sourceSearchSignature(search) {
      if (!search) {
        return "";
      }
      if (search.error) {
        return `error:${search.error}`;
      }
      if (!search.regex) {
        return "";
      }
      return `${search.regex.source}/${search.regex.flags}`;
    }

    function ensureStructuredSourceSearchData(view, search) {
      if (!view) {
        return;
      }
      const signature = sourceSearchSignature(search);
      if (view.searchSignature === signature) {
        return;
      }
      const { records, rangesByLine } = buildStructuredSourceSearchMatches(view, search);
      view.searchSignature = signature;
      view.searchMatchRecords = records;
      view.searchMatchRangesByLine = rangesByLine;
    }

    function currentSourceSearchTotalMatches() {
      return isPlainTextSourceView()
        ? (currentSourceView?.plainSearchMatches || []).length
        : currentStructuredSourceMatches().length;
    }

    function applyCurrentSourceSearchSelection(scrollIntoView = true) {
      if (isPlainTextSourceView()) {
        const plainMatches = currentSourceView?.plainSearchMatches || [];
        if (
          state.sourceSearchMatchIndex < 0 ||
          state.sourceSearchMatchIndex >= plainMatches.length
        ) {
          updateSourceSearchStatus();
          return;
        }
        const current = plainMatches[state.sourceSearchMatchIndex];
        selectPlainSourceRange(current.start, current.end, scrollIntoView, current.lineNo);
        updateSourceSearchStatus();
        return;
      }
      clearVisibleSourceSearchSelection();
      const structuredMatches = currentStructuredSourceMatches();
      if (
        state.sourceSearchMatchIndex < 0 ||
        state.sourceSearchMatchIndex >= structuredMatches.length
      ) {
        updateSourceSearchStatus();
        return;
      }
      const current = structuredMatches[state.sourceSearchMatchIndex];
      if (scrollIntoView) {
        scrollSourceLineIntoView(current.lineNo, "center");
      }
      const currentElement = sourceCode.querySelector(`.source-find-hit[data-match-index="${current.matchIndex}"]`);
      if (currentElement) {
        currentElement.classList.add("current");
        currentElement.closest(".source-line")?.classList.add("search-current");
        if (scrollIntoView && !currentSourceView?.virtualized) {
          currentElement.scrollIntoView({ block: "center", inline: "nearest" });
        }
      }
      updateSourceSearchStatus();
    }

    function moveSourceSearch(delta) {
      const total = currentSourceSearchTotalMatches();
      if (!total) {
        return;
      }
      const current = state.sourceSearchMatchIndex < 0 ? 0 : state.sourceSearchMatchIndex;
      state.sourceSearchMatchIndex = (current + delta + total) % total;
      applyCurrentSourceSearchSelection(true);
    }

    function shouldUseCompactSourceRender(view) {
      if (!view) {
        return false;
      }
      const textLength = estimateSourceTextLength(view);
      if (view.targetKind === "definition") {
        return view.lines.length >= SOURCE_COMPACT_RENDER_DEFINITION_LINE_THRESHOLD
          || textLength >= SOURCE_COMPACT_RENDER_DEFINITION_CHAR_THRESHOLD;
      }
      return view.lines.length >= SOURCE_COMPACT_RENDER_INSTANCE_LINE_THRESHOLD
        || textLength >= SOURCE_COMPACT_RENDER_INSTANCE_CHAR_THRESHOLD;
    }

    function shouldUsePlainTextSourceRender(view) {
      if (!view) {
        return false;
      }
      const textLength = estimateSourceTextLength(view);
      if (view.targetKind === "definition") {
        return view.lines.length >= SOURCE_PLAIN_TEXT_DEFINITION_LINE_THRESHOLD
          || textLength >= SOURCE_PLAIN_TEXT_DEFINITION_CHAR_THRESHOLD;
      }
      return view.lines.length >= SOURCE_PLAIN_TEXT_INSTANCE_LINE_THRESHOLD
        || textLength >= SOURCE_PLAIN_TEXT_INSTANCE_CHAR_THRESHOLD;
    }

    function resolveSourceRenderMode(view) {
      if (!view) {
        return "full";
      }
      if (shouldUsePlainTextSourceRender(view)) {
        return "plain";
      }
      if (shouldUseCompactSourceRender(view)) {
        return "compact";
      }
      return "full";
    }

    function renderSourceLineContent(line, matchRanges) {
      return highlightVerilogLine(line, matchRanges);
    }

    function shouldVirtualizeSourceRender(view) {
      return !!(view && view.lines.length >= SOURCE_VIRTUALIZED_LINE_THRESHOLD);
    }

    function buildSourceLineHtml(line, lineNo, focusStartLine, focusEndLine, bookmarkSet, matchRanges, renderMode = "full") {
      const classes = ["source-line"];
      if (renderMode === "compact") {
        classes.push("compact");
      }
      if (lineNo >= focusStartLine && lineNo <= focusEndLine) {
        classes.push("active");
      }
      if (matchRanges.length > 0) {
        classes.push("search-match");
      }
      if (matchRanges.some((range) => range.matchIndex === state.sourceSearchMatchIndex)) {
        classes.push("search-current");
      }
      if (bookmarkSet.has(lineNo)) {
        classes.push("bookmarked");
      }
      const bookmarkTitle = bookmarkSet.has(lineNo)
        ? `Remove bookmark at line ${lineNo}`
        : `Bookmark line ${lineNo}`;
      if (renderMode === "compact") {
        return `<div class="${classes.join(" ")}" data-line="${lineNo}"><button class="source-lineno${bookmarkSet.has(lineNo) ? " bookmarked" : ""}" type="button" data-line="${lineNo}" aria-pressed="${bookmarkSet.has(lineNo) ? "true" : "false"}" title="${bookmarkTitle}"><span class="source-bookmark-dot" aria-hidden="true"></span><span class="source-lineno-value">${lineNo}</span></button><span class="source-code-text">${renderSourceLineContent(line, matchRanges)}</span></div>`;
      }
      return `<div class="${classes.join(" ")}" data-line="${lineNo}"><button class="source-lineno${bookmarkSet.has(lineNo) ? " bookmarked" : ""}" type="button" data-line="${lineNo}" aria-pressed="${bookmarkSet.has(lineNo) ? "true" : "false"}" title="${bookmarkTitle}"><span class="source-bookmark-dot" aria-hidden="true"></span><span class="source-lineno-value">${lineNo}</span></button><span class="source-code-text">${renderSourceLineContent(line, matchRanges)}</span></div>`;
    }

    function measureSourceLineHeight(renderMode) {
      const cacheKey = renderMode === "compact" ? "compact" : "full";
      const cached = sourceLineHeightCache.get(cacheKey);
      if (cached) {
        return cached;
      }
      const probe = document.createElement("div");
      probe.className = renderMode === "compact" ? "source-line compact" : "source-line";
      probe.dataset.line = "1";
      probe.style.position = "absolute";
      probe.style.visibility = "hidden";
      probe.style.pointerEvents = "none";
      probe.style.inset = "0 auto auto 0";
      if (renderMode === "compact") {
        probe.innerHTML = '<span class="source-code-text"><span class="tok-keyword">module</span> probe;</span>';
      } else {
        probe.innerHTML = '<button class="source-lineno" type="button" data-line="1" aria-pressed="false"><span class="source-bookmark-dot" aria-hidden="true"></span><span class="source-lineno-value">1</span></button><span class="source-code-text"><span class="tok-keyword">module</span> probe;</span>';
      }
      sourceCode.appendChild(probe);
      const height = Math.max(20, Math.ceil(probe.getBoundingClientRect().height || 22));
      probe.remove();
      sourceLineHeightCache.set(cacheKey, height);
      return height;
    }

    function sourceLineIndex(view, lineNo) {
      if (!view) {
        return -1;
      }
      const index = lineNo - view.firstLineNumber;
      if (index < 0 || index >= view.lines.length) {
        return -1;
      }
      return index;
    }

    function sourceScrollTopForLine(view, lineNo, block = "center") {
      const index = sourceLineIndex(view, lineNo);
      if (index < 0) {
        return null;
      }
      const lineHeight = view.lineHeight || measureSourceLineHeight(view.renderMode);
      view.lineHeight = lineHeight;
      const viewportHeight = Math.max(sourceCode.clientHeight, lineHeight * 10);
      const maxScrollTop = Math.max(0, view.lines.length * lineHeight - viewportHeight);
      const lineTop = index * lineHeight;
      if (block === "start") {
        return Math.min(maxScrollTop, lineTop);
      }
      if (block === "nearest") {
        const currentTop = sourceCode.scrollTop;
        const currentBottom = currentTop + viewportHeight;
        const lineBottom = lineTop + lineHeight;
        if (lineTop >= currentTop && lineBottom <= currentBottom) {
          return currentTop;
        }
      }
      const centered = lineTop - Math.max(0, (viewportHeight - lineHeight) / 2);
      return Math.max(0, Math.min(maxScrollTop, centered));
    }

    function clearVisibleSourceSearchSelection() {
      for (const element of sourceCode.querySelectorAll(".source-find-hit.current")) {
        element.classList.remove("current");
      }
      for (const lineElement of sourceCode.querySelectorAll(".source-line.search-current")) {
        lineElement.classList.remove("search-current");
      }
    }

    function applyVisibleSourceSearchSelection() {
      clearVisibleSourceSearchSelection();
      const matches = currentStructuredSourceMatches();
      if (
        state.sourceSearchMatchIndex < 0 ||
        state.sourceSearchMatchIndex >= matches.length
      ) {
        return;
      }
      const current = matches[state.sourceSearchMatchIndex];
      const currentElement = sourceCode.querySelector(`.source-find-hit[data-match-index="${current.matchIndex}"]`);
      if (!currentElement) {
        return;
      }
      currentElement.classList.add("current");
      currentElement.closest(".source-line")?.classList.add("search-current");
    }

    function ensureSourceVirtualElements() {
      let shell = sourceCode.querySelector(".source-virtual-shell");
      let topSpacer = sourceCode.querySelector(".source-virtual-spacer-top");
      let content = sourceCode.querySelector(".source-virtual-content");
      let bottomSpacer = sourceCode.querySelector(".source-virtual-spacer-bottom");
      if (shell && topSpacer && content && bottomSpacer) {
        return { shell, topSpacer, content, bottomSpacer };
      }
      shell = document.createElement("div");
      shell.className = "source-virtual-shell";
      topSpacer = document.createElement("div");
      topSpacer.className = "source-virtual-spacer source-virtual-spacer-top";
      content = document.createElement("div");
      content.className = "source-virtual-content";
      bottomSpacer = document.createElement("div");
      bottomSpacer.className = "source-virtual-spacer source-virtual-spacer-bottom";
      shell.appendChild(topSpacer);
      shell.appendChild(content);
      shell.appendChild(bottomSpacer);
      sourceCode.replaceChildren(shell);
      return { shell, topSpacer, content, bottomSpacer };
    }

    function renderVisibleVirtualSourceWindow(force = false) {
      const view = currentSourceView;
      if (!view || !view.virtualized) {
        return;
      }
      const { topSpacer, content, bottomSpacer } = ensureSourceVirtualElements();
      const lineHeight = view.lineHeight || measureSourceLineHeight(view.renderMode);
      view.lineHeight = lineHeight;
      const viewportHeight = Math.max(sourceCode.clientHeight, lineHeight * 12);
      const startIndex = Math.max(0, Math.floor(sourceCode.scrollTop / lineHeight) - SOURCE_VIRTUALIZED_OVERSCAN_LINES);
      const endIndex = Math.min(
        view.lines.length,
        Math.ceil((sourceCode.scrollTop + viewportHeight) / lineHeight) + SOURCE_VIRTUALIZED_OVERSCAN_LINES,
      );
      if (!force && startIndex === view.virtualStart && endIndex === view.virtualEnd) {
        applyVisibleSourceSearchSelection();
        return;
      }
      view.virtualStart = startIndex;
      view.virtualEnd = endIndex;
      topSpacer.style.height = `${startIndex * lineHeight}px`;
      bottomSpacer.style.height = `${Math.max(0, (view.lines.length - endIndex) * lineHeight)}px`;
      const bookmarkSet = new Set(currentSourceBookmarkLines());
      const matchMap = currentStructuredSourceMatchMap();
      let html = "";
      for (let index = startIndex; index < endIndex; index += 1) {
        const lineNo = view.firstLineNumber + index;
        html += buildSourceLineHtml(
          view.lines[index],
          lineNo,
          view.focusStartLine,
          view.focusEndLine,
          bookmarkSet,
          matchMap.get(lineNo) || [],
          view.renderMode,
        );
      }
      content.innerHTML = html;
      sourceSearchMatchElements = Array.from(content.querySelectorAll(".source-find-hit"));
      syncSourceBookmarksInView();
      applyVisibleSourceSearchSelection();
    }

    function scheduleSourceVirtualRender(force = false) {
      if (!currentSourceView?.virtualized) {
        return;
      }
      sourceVirtualRenderForce = sourceVirtualRenderForce || force;
      if (sourceVirtualRenderQueued) {
        return;
      }
      sourceVirtualRenderQueued = true;
      requestAnimationFrame(() => {
        sourceVirtualRenderQueued = false;
        const forceNow = sourceVirtualRenderForce;
        sourceVirtualRenderForce = false;
        renderVisibleVirtualSourceWindow(forceNow);
      });
    }

    function scrollSourceLineIntoView(lineNo, block = "center") {
      if (!currentSourceView) {
        return;
      }
      if (currentSourceView.virtualized) {
        const nextScrollTop = sourceScrollTopForLine(currentSourceView, lineNo, block);
        if (nextScrollTop === null) {
          return;
        }
        sourceCode.scrollTop = nextScrollTop;
        renderVisibleVirtualSourceWindow(true);
        return;
      }
      const focusElement = sourceCode.querySelector(`[data-line="${lineNo}"]`);
      if (focusElement) {
        focusElement.scrollIntoView({ block, inline: "nearest" });
      }
    }

    function finalizeRenderedSource(preferFocusLine) {
      if (isPlainTextSourceView()) {
        sourceSearchMatchElements = [];
        currentSourceView.plainSearchMatches = buildPlainSourceSearchMatches(
          currentSourceView,
          buildSourceSearchRegExp(),
        );
        if (!currentSourceView.plainSearchMatches.length) {
          state.sourceSearchMatchIndex = -1;
        } else if (
          state.sourceSearchMatchIndex < 0 ||
          state.sourceSearchMatchIndex >= currentSourceView.plainSearchMatches.length
        ) {
          state.sourceSearchMatchIndex = 0;
        }
        syncSourceBookmarksInView();
        if (state.sourceSearch.trim().length > 0 && currentSourceView.plainSearchMatches.length > 0) {
          applyCurrentSourceSearchSelection(true);
          return;
        }
        updateSourceSearchStatus();
        if (preferFocusLine && currentSourceView) {
          emphasizeFocusedSourceRange();
        }
        return;
      }
      const totalMatches = currentStructuredSourceMatches().length;
      clearSourceFocusJump();
      if (!totalMatches) {
        state.sourceSearchMatchIndex = -1;
      } else if (
        state.sourceSearchMatchIndex < 0 ||
        state.sourceSearchMatchIndex >= totalMatches
      ) {
        state.sourceSearchMatchIndex = 0;
      }

      const shouldFocusSearch = state.sourceSearch.trim().length > 0 && totalMatches > 0;
      syncSourceBookmarksInView();
      if (shouldFocusSearch) {
        applyCurrentSourceSearchSelection(true);
        return;
      }
      updateSourceSearchStatus();
      if (preferFocusLine && currentSourceView) {
        emphasizeFocusedSourceRange();
        return;
      }
      applyVisibleSourceSearchSelection();
    }

    function renderCurrentSourceView(preferFocusLine = true) {
      if (!currentSourceView) {
        sourceCode.innerHTML = "";
        sourceSearchMatchElements = [];
        state.sourceSearchMatchIndex = -1;
        sourceCode.classList.remove("compact-mode");
        sourceCode.classList.remove("plain-mode");
        renderSourceBookmarkBar();
        updateSourceSearchStatus();
        return;
      }
      const search = buildSourceSearchRegExp();
      state.sourceSearchError = search.error;
      const { lines, firstLineNumber, focusStartLine, focusEndLine } = currentSourceView;
      syncCurrentSourceBookmarkPreviews();
      const bookmarkSet = new Set(currentSourceBookmarkLines());
      const renderMode = resolveSourceRenderMode(currentSourceView);
      const compactMode = renderMode === "compact";
      const plainMode = renderMode === "plain";
      currentSourceView.renderMode = renderMode;
      currentSourceView.virtualized = !plainMode && shouldVirtualizeSourceRender(currentSourceView);
      sourceCode.classList.toggle("compact-mode", compactMode);
      sourceCode.classList.toggle("plain-mode", plainMode);
      if (plainMode) {
        const textarea = document.createElement("textarea");
        textarea.className = "source-plain-text";
        textarea.readOnly = true;
        textarea.spellcheck = false;
        textarea.wrap = "off";
        textarea.value = ensureSourceText(currentSourceView);
        sourceCode.replaceChildren(textarea);
        finalizeRenderedSource(preferFocusLine);
        return;
      }
      ensureStructuredSourceSearchData(currentSourceView, search);
      if (currentSourceView.virtualized) {
        currentSourceView.lineHeight = measureSourceLineHeight(renderMode);
        currentSourceView.virtualStart = -1;
        currentSourceView.virtualEnd = -1;
        ensureSourceVirtualElements();
        if (preferFocusLine) {
          const focusScrollTop = sourceScrollTopForLine(currentSourceView, focusStartLine, "center");
          if (focusScrollTop !== null) {
            sourceCode.scrollTop = focusScrollTop;
          }
        }
        renderVisibleVirtualSourceWindow(true);
        finalizeRenderedSource(false);
        return;
      }
      const matchMap = currentStructuredSourceMatchMap();
      sourceCode.innerHTML = lines
        .map((line, index) => buildSourceLineHtml(
          line,
          firstLineNumber + index,
          focusStartLine,
          focusEndLine,
          bookmarkSet,
          matchMap.get(firstLineNumber + index) || [],
          renderMode,
        ))
        .join("");
      sourceSearchMatchElements = Array.from(sourceCode.querySelectorAll(".source-find-hit"));
      finalizeRenderedSource(preferFocusLine);
    }

    function renderSourceLines(lines, firstLineNumber, focusStartLine, focusEndLine, options = {}) {
      currentSourceView = {
        lines,
        text: typeof options.text === "string" ? options.text : null,
        textLength: Number.isInteger(options.textLength) ? options.textLength : null,
        lineOffsets: Array.isArray(options.lineOffsets) ? options.lineOffsets : null,
        plainMetrics: null,
        plainSearchMatches: [],
        searchMatchRecords: [],
        searchMatchRangesByLine: new Map(),
        searchSignature: null,
        firstLineNumber,
        focusStartLine,
        focusEndLine,
        renderMode: "full",
        virtualized: false,
        lineHeight: null,
        virtualStart: -1,
        virtualEnd: -1,
        targetKind: options.targetKind || currentSourceView?.targetKind || "instance",
        bookmarkKey: options.bookmarkKey || currentSourceView?.bookmarkKey || null
      };
      if (state.sourceBookmarkEditingKey !== currentSourceView.bookmarkKey) {
        clearSourceBookmarkRename();
      }
      renderCurrentSourceView(true);
    }

    function sourceRenderModeStatusSuffix(view) {
      if (!view) {
        return "";
      }
      if (view.renderMode === "plain") {
        return "Large-source mode keeps the viewer responsive; line-click bookmarking is unavailable in this mode.";
      }
      if (view.renderMode === "compact") {
        return "Large-source highlighted mode keeps syntax colors while staying responsive.";
      }
      return "";
    }

    function applySourcePanelWindowState() {
      const sourceOpen = state.sourceNodeId !== null;
      sourcePanel.classList.toggle("fullscreen", state.sourcePanelFullscreen);
      document.body.classList.toggle("source-fullscreen-active", state.sourcePanelFullscreen);
      document.body.classList.toggle("source-open", sourceOpen);
      if (appRoot) {
        appRoot.classList.toggle("source-open", sourceOpen);
      }
      toggleSourceFullscreenBtn.textContent = state.sourcePanelFullscreen ? "Windowed" : "Fullscreen";
      toggleSourceFullscreenBtn.setAttribute("aria-pressed", state.sourcePanelFullscreen ? "true" : "false");
      scheduleUiAnnotations();
    }

    function formatSourceLocation(target) {
      if (!target || !target.filePath) {
        return "Source location unavailable";
      }
      const line = target.line || 1;
      const column = target.column || 1;
      return `${target.filePath}:${line}:${column}`;
    }

    function renderSourceRange(node, target, sourceData, startLine, endLine, message, bookmarkKey) {
      const lines = sourceData.lines;
      if (!lines.length) {
        sourceSubtitle.textContent = `${node.module} · ${target.locationLabel} · ${formatSourceLocation(target)} · ${message}`;
        sourceCode.innerHTML = '<div class="source-line"><span class="source-lineno">-</span><span class="source-code-text">Source file is empty.</span></div>';
        sourceCode.classList.remove("compact-mode");
        sourceCode.classList.remove("plain-mode");
        currentSourceView = {
          firstLineNumber: 1,
          focusStartLine: 1,
          focusEndLine: 1,
          bookmarkKey: bookmarkKey || sourceBookmarkKeyForTarget(target)
        };
        renderSourceBookmarkBar();
        return;
      }
      const clampedStart = Math.min(Math.max(1, startLine), lines.length);
      const clampedEnd = Math.min(Math.max(clampedStart, endLine), lines.length);
      const subsetLines = lines.slice(clampedStart - 1, clampedEnd);
      sourceSubtitle.textContent = `${node.module} · ${target.locationLabel} · ${formatSourceLocation(target)} · lines ${clampedStart}-${clampedEnd} · ${message}`;
      renderSourceLines(
        subsetLines,
        clampedStart,
        clampedStart,
        clampedEnd,
        {
          bookmarkKey,
          targetKind: target.kind,
        },
      );
    }

    async function loadFullSource(target, signal) {
      const sourceUrl = resolveSourceUrl(target);
      if (!sourceUrl) {
        throw new Error("relative source path unavailable");
      }
      if (sourceTextCache.has(sourceUrl)) {
        return sourceTextCache.get(sourceUrl);
      }

      const response = await fetch(sourceUrl, { signal, cache: "no-store" });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const totalBytes = Number(response.headers.get("content-length")) || 0;
      let fetchedBytes = 0;
      let text = "";
      if (response.body && typeof response.body.getReader === "function") {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const parts = [];
        setSourceLoadProgress(
          totalBytes > 0 ? 2 : 8,
          "Downloading source...",
          totalBytes > 0 ? `0 / ${formatLoadingBytes(totalBytes)}` : "Receiving source bytes...",
        );
        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }
          fetchedBytes += value.byteLength;
          parts.push(decoder.decode(value, { stream: true }));
          const percent = totalBytes > 0
            ? (fetchedBytes / totalBytes) * 100
            : Math.min(92, 10 + parts.length * 8);
          setSourceLoadProgress(
            percent,
            "Downloading source...",
            totalBytes > 0
              ? `${formatLoadingBytes(fetchedBytes)} / ${formatLoadingBytes(totalBytes)}`
              : `${formatLoadingBytes(fetchedBytes)} received`,
          );
        }
        parts.push(decoder.decode());
        text = parts.join("");
      } else {
        setSourceLoadProgress(12, "Downloading source...", "Streaming progress is unavailable in this browser.");
        text = await response.text();
        fetchedBytes = text.length;
      }
      const sourceData = {
        text,
        lines: text.split("\n"),
        lineOffsets: null,
      };
      sourceTextCache.set(sourceUrl, sourceData);
      return sourceData;
    }

    async function renderSource(nodeId, targetKind = null) {
      const node = getNode(nodeId);
      const resolvedKind = targetKind || preferredSourceTargetKind(node);
      const target = buildSourceTarget(node, resolvedKind);
      if (!target) {
        return;
      }
      cancelScheduledHoverUpdate();

      const focusStartLine = target.line || 1;
      const focusEndLine = target.endLine || focusStartLine;
      const sourceUrl = resolveSourceUrl(target);
      const bookmarkKey = sourceBookmarkKeyForTarget(target);

      sourceTitle.textContent = `${node.path} · ${target.titleSuffix}`;
      if (sourceUrl) {
        openRawSourceLink.href = sourceUrl;
        openRawSourceLink.classList.remove("hidden");
      } else {
        openRawSourceLink.href = "#";
        openRawSourceLink.classList.add("hidden");
      }

      hoverCard.classList.add("hidden");
      clearUiAnnotationHoverTargetWithin(hoverCard);
      state.sourceNodeId = nodeId;
      state.sourceTargetKind = target.kind;
      sourcePanel.classList.add("visible");
      applySourcePanelWindowState();
      const requestToken = state.sourceRequestToken + 1;
      state.sourceRequestToken = requestToken;
      if (state.sourceAbortController) {
        state.sourceAbortController.abort();
      }
      state.sourceAbortController = new AbortController();

      sourceSubtitle.textContent = `${node.module} · ${target.locationLabel} · ${formatSourceLocation(target)} · loading full file...`;
      sourceCode.innerHTML = '<div class="source-line"><span class="source-lineno">-</span><span class="source-code-text">Loading...</span></div>';
      hideSourceLoadProgress();
      showSourceStatus(sourceUrl ? "Loading full file..." : "Source file unavailable.");

      if (!sourceUrl) {
        return;
      }

      try {
        await nextFrame();
        const sourceData = await loadFullSource(target, state.sourceAbortController.signal);
        if (state.sourceNodeId !== nodeId || state.sourceRequestToken !== requestToken) {
          return;
        }
        const lineCount = sourceData.lines.length;
        setSourceLoadProgress(100, "Rendering source...", `${lineCount} lines ready`);
        await nextFrame();
        if (
          target.kind === "definition" &&
          Number.isFinite(target.line) &&
          Number.isFinite(target.endLine) &&
          target.endLine >= target.line
        ) {
          renderSourceRange(
            node,
            target,
            sourceData,
            target.line,
            target.endLine,
            "module definition",
            bookmarkKey,
          );
          hideSourceLoadProgress();
          const shownLineCount = Math.max(0, target.endLine - target.line + 1);
          const modeSuffix = sourceRenderModeStatusSuffix(currentSourceView);
          showSourceStatus(
            modeSuffix
              ? `Module source loaded (${shownLineCount} lines shown). ${modeSuffix}`
              : `Module source loaded (${shownLineCount} lines shown).`
          );
          return;
        }
        sourceSubtitle.textContent = `${node.module} · ${target.locationLabel} · ${formatSourceLocation(target)} · full file`;
        hideSourceLoadProgress();
        renderSourceLines(sourceData.lines, 1, focusStartLine, focusEndLine, {
          bookmarkKey,
          text: sourceData.text,
          textLength: sourceData.text.length,
          lineOffsets: sourceData.lineOffsets,
          targetKind: target.kind,
        });
        await nextFrame();
        if (state.sourceNodeId === nodeId && state.sourceRequestToken === requestToken) {
          emphasizeFocusedSourceRange();
          await nextFrame();
          emphasizeFocusedSourceRange();
        }
        const modeSuffix = sourceRenderModeStatusSuffix(currentSourceView);
        showSourceStatus(
          modeSuffix
            ? `Full file loaded (${lineCount} lines). ${modeSuffix}`
            : `Full file loaded (${lineCount} lines).`
        );
      } catch (error) {
        if (state.sourceNodeId !== nodeId || state.sourceRequestToken !== requestToken) {
          return;
        }
        if (error && typeof error === "object" && error.name === "AbortError") {
          hideSourceLoadProgress();
          showSourceStatus("");
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        sourceSubtitle.textContent = `${node.module} · ${target.locationLabel} · ${formatSourceLocation(target)} · source unavailable`;
        sourceCode.innerHTML = `<div class="source-line"><span class="source-lineno">-</span><span class="source-code-text">${escapeHtml(`Full file unavailable in this browser session (${message}). Use Open Raw or serve the bundle over HTTP.`)}</span></div>`;
        sourceCode.classList.remove("compact-mode");
        sourceCode.classList.remove("plain-mode");
        hideSourceLoadProgress();
        showSourceStatus("Full file load failed.");
      }
    }

    function closeSourcePanel() {
      if (sourceSearchInputTimer !== null) {
        clearTimeout(sourceSearchInputTimer);
        sourceSearchInputTimer = null;
      }
      cancelScheduledHoverUpdate();
      if (state.sourceAbortController) {
        state.sourceAbortController.abort();
        state.sourceAbortController = null;
      }
      state.sourceNodeId = null;
      state.sourceTargetKind = "instance";
      state.sourceRequestToken += 1;
      currentSourceView = null;
      sourceSearchMatchElements = [];
      state.sourceSearchMatchIndex = -1;
      state.sourceSearchError = "";
      state.sourcePanelFullscreen = false;
      clearSourceBookmarkRename();
      sourceCode.innerHTML = "";
      sourceCode.classList.remove("compact-mode");
      sourceCode.classList.remove("plain-mode");
      hideSourceLoadProgress();
      showSourceStatus("");
      openRawSourceLink.href = "#";
      openRawSourceLink.classList.add("hidden");
      applySourcePanelWindowState();
      sourcePanel.classList.remove("visible");
      renderSourceBookmarkBar();
      updateSourceSearchStatus();
      if (state.hoverId === null || state.hoverId === undefined) {
        hoverCard.classList.add("hidden");
        clearUiAnnotationHoverTargetWithin(hoverCard);
        return;
      }
      updateHover(state.hoverId, state.hoverAreaKind);
    }

    function subtreeDepth(nodeId) {
      if (subtreeDepthCache[nodeId] !== -1) {
        return subtreeDepthCache[nodeId];
      }
      const node = getNode(nodeId);
      if (!node.children.length) {
        subtreeDepthCache[nodeId] = 0;
        return 0;
      }
      const depth = 1 + Math.max(...node.children.map((childId) => subtreeDepth(childId)));
      subtreeDepthCache[nodeId] = depth;
      return depth;
    }

    function currentMaxDepth() {
      return subtreeDepth(state.currentRoot);
    }

    function visibleDepthLabel() {
      return state.depthLimit === null ? "max" : `${state.depthLimit}/${currentMaxDepth()}`;
    }

    function weightForNode(nodeId) {
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

    function localWeightForNode(nodeId) {
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

    function nodeColor(level) {
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

    function selfAreaColor(level) {
      const theme = currentThemeVisuals();
      if (analysisActive()) {
        return hexToRgba(mixHexColors(theme.panel, theme.canvasBase, theme.dark ? 0.54 : 0.34), theme.dark ? 0.92 : 0.94);
      }
      const accent = themeNodeAccent(level);
      const fill = mixHexColors(theme.panel, accent, theme.dark ? 0.18 : 0.10);
      return hexToRgba(fill, theme.dark ? 0.86 : 0.92);
    }

    function nodeStroke(level) {
      const theme = currentThemeVisuals();
      if (analysisActive()) {
        return mixHexColors(theme.text, theme.canvasBase, theme.dark ? 0.34 : 0.26);
      }
      return mixHexColors(theme.text, themeNodeAccent(level), theme.dark ? 0.48 : 0.38);
    }

    function selfAreaStroke(level) {
      const theme = currentThemeVisuals();
      if (analysisActive()) {
        return hexToRgba(mixHexColors(theme.text, theme.canvasBase, theme.dark ? 0.28 : 0.24), 0.92);
      }
      return hexToRgba(mixHexColors(theme.text, themeNodeAccent(level), theme.dark ? 0.38 : 0.30), 0.90);
    }

    function analysisBucketIndex(nodeId) {
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

    function analysisLocalBucketStyle(nodeId) {
      const bucket = analysisBucketIndex(nodeId);
      const buckets = themeAnalysisBuckets();
      return buckets[Math.max(1, bucket)] || buckets[1];
    }

    function analysisContentFillColor(nodeId) {
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

    function analysisContentStrokeColor(nodeId) {
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

    function analysisLocalShellFill(nodeId) {
      return analysisLocalBucketStyle(nodeId).shellFill;
    }

    function analysisLocalShellStroke(nodeId) {
      return analysisLocalBucketStyle(nodeId).shellStroke;
    }

    function analysisLocalLabelColor(nodeId) {
      return analysisLocalBucketStyle(nodeId).labelText;
    }

    function analysisDescendantShellFill() {
      return mixHexColors(currentThemeVisuals().canvasBase, currentThemeVisuals().match, currentThemeVisuals().dark ? 0.56 : 0.42);
    }

    function analysisDescendantShellStroke() {
      return mixHexColors(currentThemeVisuals().text, currentThemeVisuals().match, currentThemeVisuals().dark ? 0.54 : 0.44);
    }

    function analysisBadgeFill(nodeId) {
      return analysisNodeHighlightState(nodeId) === "local"
        ? analysisLocalShellFill(nodeId)
        : analysisDescendantShellFill();
    }

    function analysisBadgeTextColor(nodeId) {
      return analysisNodeHighlightState(nodeId) === "local"
        ? analysisLocalBucketStyle(nodeId).badgeText
        : (currentThemeVisuals().dark ? "rgba(236, 239, 244, 0.96)" : "rgba(46, 27, 11, 0.96)");
    }

    function analysisHeaderStripHeight(areaHeight) {
      return clampValue(areaHeight * 0.16, 8, 22);
    }

    function analysisValueText(nodeId) {
      if (state.analysisMode === "count") {
        return formatMetricValue(state.analysisLocalCounts[nodeId] || 0);
      }
      if (state.analysisMode === "loc") {
        return formatMetricValue(state.analysisLocalLocs[nodeId] || 0);
      }
      return `${formatMetricValue((state.analysisLocalRatios[nodeId] || 0) * 100)}%`;
    }

    function visibleParent(nodeId) {
      const node = getNode(nodeId);
      if (node.parent === null || node.parent === undefined) {
        return null;
      }
      if (state.homeRoot !== 0 && node.parent === 0) {
        return null;
      }
      return node.parent;
    }

    function expandTreePath(nodeId) {
      let cursor = nodeId;
      while (cursor !== null && cursor !== undefined) {
        state.treeCollapsedIds.delete(cursor);
        if (cursor === state.homeRoot) {
          break;
        }
        cursor = visibleParent(cursor);
      }
    }

    function nodeIsVisibleDescendantOf(rootId, nodeId) {
      let cursor = nodeId;
      while (cursor !== null && cursor !== undefined) {
        if (cursor === rootId) {
          return true;
        }
        cursor = visibleParent(cursor);
      }
      return false;
    }

    function buildBreadcrumbs(nodeId) {
      const chain = [];
      let cursor = nodeId;
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

    function wildcardToRegExp(pattern) {
      const escaped = pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replaceAll("*", ".*")
        .replaceAll("?", ".");
      return new RegExp(`^${escaped}$`, "i");
    }

    function splitSearchTerms(raw) {
      return raw
        .split(/[;\n]+/)
        .map((term) => term.trim())
        .filter((term) => term.length > 0);
    }

    function buildSignalMatcher(term) {
      if (term.startsWith("re:")) {
        const regex = new RegExp(term.slice(3), "i");
        return (signalName) => regex.test(signalName);
      }
      if (term.startsWith("wc:")) {
        const regex = wildcardToRegExp(term.slice(3));
        return (signalName) => regex.test(signalName);
      }
      if (state.analysisPatternMode === "regex") {
        const regex = new RegExp(term, "i");
        return (signalName) => regex.test(signalName);
      }
      if (state.analysisPatternMode === "wildcard") {
        const regex = wildcardToRegExp(term);
        return (signalName) => regex.test(signalName);
      }
      const q = term.toLowerCase();
      return (signalName) => signalName.toLowerCase().includes(q);
    }

    function moduleLocalLoc(node) {
      if (!node) {
        return 0;
      }
      const startLine = Number.isFinite(node.definitionLine) ? node.definitionLine : null;
      if (startLine === null || startLine <= 0) {
        return 0;
      }
      const endLine = Number.isFinite(node.definitionEndLine) && node.definitionEndLine >= startLine
        ? node.definitionEndLine
        : startLine;
      return Math.max(0, endLine - startLine + 1);
    }

    function computeAnalysisSubtree(nodeId) {
      const node = getNode(nodeId);
      const localCount = state.analysisLocalCounts[nodeId] || 0;
      const localLoc = state.analysisLocalLocs[nodeId] || 0;
      let subtreeCount = localCount;
      let subtreeLoc = localLoc;
      for (const childId of node.children) {
        const childTotals = computeAnalysisSubtree(childId);
        subtreeCount += childTotals.count;
        subtreeLoc += childTotals.loc;
      }
      state.analysisSubtreeCounts[nodeId] = subtreeCount;
      state.analysisSubtreeLocs[nodeId] = subtreeLoc;
      state.analysisLocalRatios[nodeId] = node.moduleInternalSignalCount > 0
        ? localCount / node.moduleInternalSignalCount
        : 0;
      state.analysisSubtreeRatios[nodeId] = node.subtreeInternalSignalCount > 0
        ? subtreeCount / node.subtreeInternalSignalCount
        : 0;
      return { count: subtreeCount, loc: subtreeLoc };
    }

    function ensureAnalysisDefinitionsRequested() {
      if (Array.isArray(analysisDefinitions) || !DATA.analysisFile || analysisDefinitionsPromise) {
        return;
      }
      analysisDefinitionsLoadError = "";
      state.analysisError = `Loading signal analysis data from ${DATA.analysisFile}...`;
      analysisDefinitionsPromise = loadAnalysisDefinitions()
        .then((definitions) => {
          analysisDefinitions = definitions;
          analysisDefinitionMap = null;
          state.analysisError = "";
        })
        .catch((error) => {
          analysisDefinitions = [];
          analysisDefinitionMap = null;
          analysisDefinitionsLoadError = `Failed to load signal analysis data: ${error.message || error}`;
          state.analysisError = analysisDefinitionsLoadError;
        })
        .finally(() => {
          analysisDefinitionsPromise = null;
          if (!state.analysisError && state.analysisMode !== "none") {
            buildSignalAnalysis();
          }
          draw();
        });
    }

    function buildSignalAnalysis() {
      state.analysisError = "";
      state.analysisLocalCounts.fill(0);
      state.analysisSubtreeCounts.fill(0);
      state.analysisLocalLocs.fill(0);
      state.analysisSubtreeLocs.fill(0);
      state.analysisLocalRatios.fill(0);
      state.analysisSubtreeRatios.fill(0);
      state.analysisMaxSubtreeCount = 0;

      if (state.analysisMode === "none") {
        return;
      }
      if (state.analysisMode === "loc") {
        let hasAnyLoc = false;
        for (const node of nodes) {
          const localLoc = moduleLocalLoc(node);
          state.analysisLocalLocs[node.id] = localLoc;
          if (localLoc > 0) {
            hasAnyLoc = true;
          }
        }
        if (!hasAnyLoc) {
          state.analysisError = "This bundle has no module definition LOC data.";
          return;
        }
        computeAnalysisSubtree(0);
        return;
      }

      if (analysisDefinitionsLoadError) {
        state.analysisError = analysisDefinitionsLoadError;
        return;
      }

      if (!Array.isArray(analysisDefinitions)) {
        ensureAnalysisDefinitionsRequested();
        return;
      }

      if (!analysisDefinitions.length) {
        state.analysisError = "This bundle has no signal analysis data. Re-export from slang-hier-exporter --sqlite.";
        return;
      }

      const raw = state.analysisPattern.trim();
      if (!raw) {
        return;
      }

      let matchers;
      try {
        matchers = splitSearchTerms(raw).map((term) => buildSignalMatcher(term));
      } catch (error) {
        state.analysisError = `Invalid analysis pattern: ${error.message}`;
        return;
      }
      if (!matchers.length) {
        return;
      }

      const definitionMap = getAnalysisDefinitionMap();

      for (const node of nodes) {
        if (node.definitionKey === null || node.definitionKey === undefined) {
          continue;
        }
        const signalStats = definitionMap.get(node.definitionKey) || [];
        let localCount = 0;
        for (const stat of signalStats) {
          if (matchers.some((matcher) => matcher(stat.signalName))) {
            localCount += stat.signalCount || 0;
          }
        }
        state.analysisLocalCounts[node.id] = localCount;
      }

      computeAnalysisSubtree(0);
      state.analysisMaxSubtreeCount = state.analysisLocalCounts.reduce(
        (maxValue, value) => Math.max(maxValue, value || 0),
        0
      );
    }

    function analysisActive() {
      return state.analysisMode === "loc"
        ? !state.analysisError
        : state.analysisMode !== "none" && !state.analysisError && state.analysisPattern.trim().length > 0;
    }

    function analysisLabel() {
      if (state.analysisMode === "count") return "local pattern count";
      if (state.analysisMode === "loc") return "local module loc";
      if (state.analysisMode === "ratio") return "local pattern ratio";
      return "disabled";
    }

    function analysisLocalValue(nodeId) {
      if (!analysisActive()) {
        return 0;
      }
      if (state.analysisMode === "count") {
        return state.analysisLocalCounts[nodeId] || 0;
      }
      if (state.analysisMode === "loc") {
        return state.analysisLocalLocs[nodeId] || 0;
      }
      return state.analysisLocalRatios[nodeId] || 0;
    }

    function analysisValueForNode(nodeId) {
      return analysisLocalValue(nodeId);
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

    function appendTreemapAnalysisLegendRow({ shellFill, contentFill, label, meta, descendant = false, filterKey = "" }) {
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

    function updateAnalysisVisibleExtents() {
      state.analysisVisibleMaxCount = 0;
      state.analysisVisibleMaxLoc = 0;
      state.analysisVisibleMaxRatio = 0;
      state.analysisVisibleSubtreeQualified.fill(false);
      if (!analysisActive()) {
        return;
      }

      const maxDepth = state.depthLimit === null ? Infinity : state.depthLimit;

      function walk(nodeId, depth) {
        state.analysisVisibleMaxCount = Math.max(
          state.analysisVisibleMaxCount,
          state.analysisLocalCounts[nodeId] || 0
        );
        state.analysisVisibleMaxLoc = Math.max(
          state.analysisVisibleMaxLoc,
          state.analysisLocalLocs[nodeId] || 0
        );
        state.analysisVisibleMaxRatio = Math.max(
          state.analysisVisibleMaxRatio,
          state.analysisLocalRatios[nodeId] || 0
        );
        let subtreeQualified = analysisNodeQualified(nodeId);
        if (depth < maxDepth) {
          for (const childId of getNode(nodeId).children) {
            if (walk(childId, depth + 1)) {
              subtreeQualified = true;
            }
          }
        }
        state.analysisVisibleSubtreeQualified[nodeId] = subtreeQualified;
        return subtreeQualified;
      }

      walk(state.currentRoot, 0);
    }

    function analysisNodeQualified(nodeId) {
      if (!analysisActive()) {
        return false;
      }
      return analysisLocalValue(nodeId) > 0;
    }

    function analysisNormalizedValue(nodeId) {
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

    function analysisOverlayAlpha(nodeId) {
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

    function analysisLegendLocalBucketMatches(nodeId) {
      const buckets = selectedAnalysisLegendBuckets();
      return buckets.length > 0
        && analysisNodeQualified(nodeId)
        && buckets.includes(analysisBucketIndex(nodeId));
    }

    function updateAnalysisLegendVisibleSubtree() {
      state.analysisLegendVisibleSubtree.fill(false);
      const selectedBuckets = selectedAnalysisLegendBuckets();
      if (!analysisActive() || !selectedBuckets.length) {
        return;
      }

      const maxDepth = state.depthLimit === null ? Infinity : state.depthLimit;
      function walk(nodeId, depth) {
        let subtreeQualified = analysisLegendLocalBucketMatches(nodeId);
        if (depth < maxDepth) {
          for (const childId of getNode(nodeId).children) {
            subtreeQualified = walk(childId, depth + 1) || subtreeQualified;
          }
        }
        state.analysisLegendVisibleSubtree[nodeId] = subtreeQualified;
        return subtreeQualified;
      }

      walk(state.currentRoot, 0);
    }

    function analysisBaseHighlightState(nodeId) {
      if (!analysisActive()) {
        return "none";
      }
      if (analysisNodeQualified(nodeId)) {
        return "local";
      }
      return state.analysisVisibleSubtreeQualified[nodeId] ? "descendant" : "none";
    }

    function analysisNodeHighlightState(nodeId) {
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

    function getAnalysisHatchPattern(kind) {
      const key = kind === "self" ? "self" : "node";
      if (analysisHatchPatternCache.has(key)) {
        return analysisHatchPatternCache.get(key);
      }

      const tile = document.createElement("canvas");
      tile.width = 12;
      tile.height = 12;
      const tileCtx = tile.getContext("2d");
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

    function shouldDrawAnalysisHatch(area, width, height, alpha) {
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

    function filterTargetText(node) {
      if (state.filterScope === "path") return node.path;
      if (state.filterScope === "instance") return node.name;
      if (state.filterScope === "module") return node.module;
      return `${node.path} ${node.module}`;
    }

    function buildMatcher(term) {
      if (term.startsWith("re:")) {
        const regex = new RegExp(term.slice(3), "i");
        return (node) => regex.test(filterTargetText(node));
      }
      if (term.startsWith("wc:")) {
        const regex = wildcardToRegExp(term.slice(3));
        return (node) => regex.test(filterTargetText(node));
      }
      if (state.filterMode === "regex") {
        const regex = new RegExp(term, "i");
        return (node) => regex.test(filterTargetText(node));
      }
      if (state.filterMode === "wildcard") {
        const regex = wildcardToRegExp(term);
        return (node) => regex.test(filterTargetText(node));
      }
      const q = term.toLowerCase();
      return (node) => filterTargetText(node).toLowerCase().includes(q);
    }

    function buildMatches() {
      const raw = state.search.trim();
      state.searchError = "";
      state.matches = [];
      state.matchIds = new Set();
      state.matchVisibleIds = new Set();
      state.matchSubtreeIds = new Set();
      state.matchLines = [];
      if (!raw) {
        return;
      }

      const terms = splitSearchTerms(raw);
      let matchers;
      try {
        matchers = terms.map((term) => buildMatcher(term));
      } catch (error) {
        state.searchError = `Invalid filter: ${error.message}`;
        return;
      }

      state.matches = nodes
        .filter((node) => matchers.some((matcher) => matcher(node)))
        .map((node) => node.id);
      state.matchIds = new Set(state.matches);
      state.matchLines = state.matches.map((id) => {
        const node = getNode(id);
        return `${node.path} <${node.module}>`;
      });
      state.treePanelDirty = true;
      state.matchPanelDirty = true;

      const visible = new Set();
      const subtree = new Set();
      for (const id of state.matches) {
        let cursor = id;
        while (cursor !== null && cursor !== undefined) {
          subtree.add(cursor);
          visible.add(cursor);
          cursor = visibleParent(cursor);
        }
        cursor = getNode(id).parent;
        while (cursor !== null && cursor !== undefined) {
          subtree.add(cursor);
          cursor = getNode(cursor).parent;
        }
      }
      state.matchVisibleIds = visible;
      state.matchSubtreeIds = subtree;
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
        `<strong>${root.path || "(root)"}</strong> · ${root.children.length} direct children · ` +
        `${metricLabel()}: <strong>${metricValue}</strong> · layout <strong>${layoutModeLabel()}</strong> · decomp <strong>${decompositionLabel()}</strong> · level <strong>${visibleDepthLabel()}</strong> · ` +
        `zoom <strong>${zoomLabel}</strong>${analysisText}${selectText}${matchText}`;
      statusRight.textContent = state.searchError || state.analysisError || (mainViewStatus && mainViewStatus.hintText) || (state.mainViewMode === "treemap" && state.selectMode ? selectModeHint : defaultHint);
      if (clearTreemapCollapsesBtn) {
        clearTreemapCollapsesBtn.disabled = state.treeCollapsedIds.size === 0;
      }
    }

    function revealNodeInMainView(nodeId) {
      const node = getNode(nodeId);
      if (node.children.length) {
        setRootAndReset(nodeId);
        return;
      }
      const parentId = visibleParent(nodeId);
      setRootAndReset(parentId !== null && parentId !== undefined ? parentId : nodeId);
    }

    function focusNodeInMainView(nodeId) {
      const node = getNode(nodeId);
      if (!node.children.length && nodeHasAnySource(node)) {
        revealNodeInMainView(nodeId);
        renderSource(nodeId);
        return;
      }
      revealNodeInMainView(nodeId);
    }

    async function copyText(text) {
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

    function forEachVisibleTreeNode(visitor) {
      const treeRootId = state.homeRoot;
      const maxDepth = state.depthLimit === null ? Infinity : state.depthLimit;
      const currentPathIds = new Set();
      let cursor = state.currentRoot;
      while (cursor !== null && cursor !== undefined) {
        currentPathIds.add(cursor);
        if (cursor === treeRootId) {
          break;
        }
        cursor = visibleParent(cursor);
      }

      function walk(nodeId, depth) {
        visitor(nodeId, depth);
        const node = getNode(nodeId);
        if (!node.children.length) {
          return;
        }
        if (depth >= maxDepth && !currentPathIds.has(nodeId)) {
          return;
        }
        if (state.treeCollapsedIds.has(nodeId)) {
          return;
        }
        for (const childId of node.children) {
          walk(childId, depth + 1);
        }
      }

      walk(treeRootId, 0);
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
      let cursor = state.currentRoot;
      while (cursor !== null && cursor !== undefined) {
        currentPathIds.add(cursor);
        if (cursor === treeRootId) {
          break;
        }
        cursor = visibleParent(cursor);
      }
      let rowCount = 0;

      function isExpanded(nodeId, depth) {
        const node = getNode(nodeId);
        if (!node.children.length) {
          return false;
        }
        if (depth >= maxDepth && !currentPathIds.has(nodeId)) {
          return false;
        }
        return !state.treeCollapsedIds.has(nodeId);
      }

      function countRows(nodeId, depth) {
        rowCount += 1;
        if (!isExpanded(nodeId, depth)) {
          return;
        }
        for (const childId of getNode(nodeId).children) {
          countRows(childId, depth + 1);
        }
      }
      countRows(treeRootId, 0);

      treePanelSubtitle.textContent = state.currentRoot === treeRootId
        ? `${root.path || "(root)"} · ${rowCount} rows`
        : `${root.path || "(root)"} · current ${current.path || current.name || "(root)"} · ${rowCount} rows`;
      treePanelBody.innerHTML = "";
      if (!rowCount) {
        treePanelBody.innerHTML = '<div class="side-empty">No hierarchy rows.</div>';
        return;
      }

      const fragment = document.createDocumentFragment();

      function appendRow(nodeId, depth) {
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

        if (!childrenVisible || !isExpanded(nodeId, depth)) {
          return;
        }
        for (const childId of node.children) {
          appendRow(childId, depth + 1);
        }
      }

      appendRow(treeRootId, 0);
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

    function clamp(value, min, max) {
      return Math.min(max, Math.max(min, value));
    }

    function viewportSize() {
      return {
        width: canvas.clientWidth,
        height: canvas.clientHeight
      };
    }

    function virtualSize() {
      const { width, height } = viewportSize();
      return {
        width: width * state.zoom,
        height: height * state.zoom
      };
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

    function changeZoom(factor, anchorX, anchorY) {
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
      draw();
    }

    function setRootAndReset(rootId) {
      cancelScheduledHoverUpdate();
      clearPendingSelectClick();
      hideTreemapToggleTooltip();
      const preservedSelectedId = state.selectedId;
      const preservedSelectedAreaKind = state.selectedAreaKind;
      const preserveSelection =
        hasLockedSelection() &&
        nodeIsVisibleDescendantOf(rootId, state.selectedId);
      if (!preserveSelection) {
        resetLockedSelection();
      }
      state.currentRoot = rootId;
      expandTreePath(rootId);
      if (preserveSelection) {
        expandTreePath(preservedSelectedId);
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
      if (!preserveSelection) {
        draw();
      }
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

    function rectIntersectsViewport(rect, width, height) {
      return !(
        rect.x + rect.w < 0 ||
        rect.y + rect.h < 0 ||
        rect.x > width ||
        rect.y > height
      );
    }

    function layoutItemsForNode(nodeId) {
      const node = getNode(nodeId);
      const items = [];

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

    function fillRoundedBadge(x, y, width, height, radius) {
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

    function orderedAccurateItems(nodeId) {
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

    function buildClassicDivTree(childIds) {
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

      const left = [];
      const right = [];
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
        children: [buildClassicDivTree(left), buildClassicDivTree(right)]
      };
    }

    function divideClassicRects(divNode, rect, out) {
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

      let rectA;
      let rectB;
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

    function layoutChildrenClassic(nodeId, rect) {
      const childIds = getNode(nodeId).children;
      const divTree = buildClassicDivTree(childIds);
      const areas = [];
      divideClassicRects(divTree, rect, areas);
      return areas;
    }

    function sumItemWeight(items) {
      return items.reduce((sum, item) => sum + item.weight, 0);
    }

    function accurateOrientation(rect) {
      return rect.w >= rect.h ? "columns" : "rows";
    }

    function splitRect(rect, orientation, firstRatio) {
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

    function makeAccurateLeaf(item) {
      return {
        kind: "leaf",
        areaKind: item.kind,
        nodeId: item.nodeId,
        size: item.weight
      };
    }

    function buildAccurateDivTree(items) {
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

      const left = [];
      const right = [];
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
            buildAccurateDivTree(items.slice(0, midpoint)),
            buildAccurateDivTree(items.slice(midpoint))
          ]
        };
      }

      return {
        kind: "split",
        size: totalWeight,
        children: [buildAccurateDivTree(left), buildAccurateDivTree(right)]
      };
    }

    function divideAccurateRects(divNode, rect, out) {
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

      let rectA;
      let rectB;
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

    function reserveSelfStrip(items, rect, out) {
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

    function layoutChildrenAccurate(nodeId, rect, level) {
      const items = orderedAccurateItems(nodeId);
      if (!items.length || rect.w <= 0 || rect.h <= 0) {
        return [];
      }

      const areas = [];
      const reserved = reserveSelfStrip(items, rect, areas);
      if (!reserved.rect || !reserved.items.length) {
        return areas;
      }

      const divTree = buildAccurateDivTree(reserved.items);
      divideAccurateRects(divTree, reserved.rect, areas);
      return areas;
    }

    function layoutChildren(nodeId, rect, level) {
      if (state.layoutMode === "classic") {
        return layoutChildrenClassic(nodeId, rect);
      }
      return layoutChildrenAccurate(nodeId, rect, level);
    }

    function createAreas(rootId, width, height) {
      const margin = { left: 8, top: 28, right: 8, bottom: 8 };
      const rootArea = {
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
        const next = [];
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

    function isMatch(nodeId) {
      return !!state.search && state.matchIds.has(nodeId);
    }

    function shouldDim(nodeId) {
      const filterDimmed = (
        state.search &&
        !state.searchError &&
        state.matches.length > 0 &&
        !state.matchSubtreeIds.has(nodeId)
      );
      const analysisDimmed = analysisActive() && analysisNodeHighlightState(nodeId) === "none";
      return filterDimmed || analysisDimmed;
    }

    function hasMatchedDescendant(nodeId) {
      return (
        state.search &&
        !state.searchError &&
        state.matches.length > 0 &&
        state.matchSubtreeIds.has(nodeId) &&
        !isMatch(nodeId)
      );
    }

    function hiddenSelectedMarkerIds(worldAreas) {
      const markerIds = new Set();
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
        : visibleParent(state.selectedId);
      while (cursor !== null && cursor !== undefined) {
        markerIds.add(cursor);
        if (cursor === state.currentRoot) {
          break;
        }
        cursor = visibleParent(cursor);
      }

      return markerIds;
    }

    function isHoveredArea(area) {
      return area.nodeId === state.hoverId && area.kind === state.hoverAreaKind;
    }

    function setHoveredTreemapToggle(nodeId) {
      if (state.hoveredTreemapToggleId === nodeId) {
        return false;
      }
      state.hoveredTreemapToggleId = nodeId;
      return true;
    }

    function hasLockedSelection() {
      return state.selectedId !== null && state.selectedId !== undefined;
    }

    function isSelectedArea(area) {
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

    function lockSelectedArea(nodeId, areaKind = "node") {
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

    function visibleAreaRect(area) {
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

    function visibleNodeContentRect(area, outerRect = null) {
      const outer = outerRect || visibleAreaRect(area);
      return {
        x: outer.x + 8,
        y: outer.y + 28,
        w: Math.max(0, outer.w - 16),
        h: Math.max(0, outer.h - 36)
      };
    }

    function isTreemapCollapsibleNode(area) {
      return !!(
        area &&
        area.kind === "node" &&
        getNode(area.nodeId).children.length > 0
      );
    }

    function treemapCollapseToggleRect(area) {
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

    function isTreemapNodeCollapsed(nodeId) {
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

    function toggleTreemapCollapsedNode(nodeId) {
      if (!Number.isInteger(nodeId) || nodeId < 0 || nodeId >= nodes.length) {
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

    function fitLabel(text, maxWidth) {
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

    function drawLabels(area) {
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
        ctx.font = "600 11px Iowan Old Style, Palatino Linotype, Book Antiqua, Georgia, serif";
        const label = fitLabel("local self", badgeWidth - 16);
        if (label) {
          ctx.fillText(label, x + 16, y + 21);
        }
      } else {
        ctx.font = state.layoutMode === "accurate"
          ? (hovered
            ? "600 13px Iowan Old Style, Palatino Linotype, Book Antiqua, Georgia, serif"
            : "600 12px Iowan Old Style, Palatino Linotype, Book Antiqua, Georgia, serif")
          : "bold 14px Iowan Old Style, Palatino Linotype, Book Antiqua, Georgia, serif";
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

    function nodeIsLeaf(nodeId) {
      return getNode(nodeId).children.length === 0;
    }

    function shouldDrawLeafBadge(area, width, height) {
      return area.kind === "node" && nodeIsLeaf(area.nodeId) && width >= 18 && height >= 18;
    }

    function drawLeafBadge(area) {
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

    function drawTreemapCollapseToggle(area) {
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

    function drawTreemapCornerIndicator(area, slotIndex, fillStyle, outlineStyle, radius = 4.5) {
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

    function draw() {
      applyMainViewMode();
      applyZenModeState();
      resizeCanvas();
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      syncDepthControl();
      updateAnalysisVisibleExtents();
      updateAnalysisLegendVisibleSubtree();
      renderTreemapAnalysisLegend();
      const virtual = virtualSize();
      const worldAreas = createAreas(state.currentRoot, virtual.width, virtual.height);
      const selectedHiddenMarkerIds = hiddenSelectedMarkerIds(worldAreas);
      state.areas = worldAreas
        .map((area) => ({
          nodeId: area.nodeId,
          kind: area.kind,
          level: area.level,
          rect: {
            x: area.rect.x - state.viewX,
            y: area.rect.y - state.viewY,
            w: area.rect.w,
            h: area.rect.h
          }
        }))
        .filter((area) => area.level === 0 || rectIntersectsViewport(area.rect, width, height));

      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = state.layoutMode === "accurate"
        ? currentThemeVisuals().canvasAccurate
        : currentThemeVisuals().canvasClassic;
      ctx.fillRect(0, 0, width, height);

      for (const area of state.areas) {
        if (area.level === 0) continue;
        const { x, y, w, h } = visibleAreaRect(area);
        if (w <= 0 || h <= 0) continue;
        const analysisHighlightState = analysisNodeHighlightState(area.nodeId);
        ctx.fillStyle = area.kind === "self" ? selfAreaColor(area.level) : nodeColor(area.level);
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
            ctx.font = "600 11px Iowan Old Style, Palatino Linotype, Book Antiqua, Georgia, serif";
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
                : (state.layoutMode === "accurate" ? 1 : 1.5);
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
          const selectedNode = getNode(state.selectedId);
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

      buildBreadcrumbs(state.currentRoot);
      updateStatus();
      renderTreePanel();
      renderMatchPanel();
      if (chartController) {
        chartController.render();
      }
      applyHoverCardPosition();
      homeBtn.disabled = state.currentRoot === state.homeRoot;
      upBtn.disabled = visibleParent(state.currentRoot) === null;
      scheduleUiAnnotations();
    }

    function hitTestArea(clientX, clientY) {
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

    function hitTestTreemapCollapseToggle(clientX, clientY) {
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

    function isPointInsideElement(element, clientX, clientY) {
      if (!element || !Number.isFinite(clientX) || !Number.isFinite(clientY)) {
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

    function pointInPolygon(points, x, y) {
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

    function isPointInsideHoverBridge(clientX, clientY) {
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

    function updateHover(nodeId, areaKind = "node", options = {}) {
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
      const hoverMetaLines = [];
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
      draw();
    }

    function cancelScheduledHoverUpdate() {
      if (state.hoverUpdateTimer !== null) {
        window.clearTimeout(state.hoverUpdateTimer);
        state.hoverUpdateTimer = null;
      }
    }

    function scheduleHoverUpdate(area, immediate = false) {
      cancelScheduledHoverUpdate();
      if (area) {
        updateHover(area.nodeId, area.kind);
      } else {
        updateHover(null);
      }
    }

    function activateTreemapArea(area) {
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
      if (event.target.closest("button, a, input, select, textarea")) {
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
        draw();
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
      if (hasLockedSelection()) {
        if (toggleChanged) {
          draw();
        }
        return;
      }
      if (state.hoverCardActive || isPointInsideElement(hoverCard, event.clientX, event.clientY)) {
        if (toggleChanged) {
          draw();
        }
        return;
      }
      if (isPointInsideHoverBridge(event.clientX, event.clientY)) {
        if (toggleChanged) {
          draw();
        }
        return;
      }
      scheduleHoverUpdate(hitTestArea(event.clientX, event.clientY));
    });

    canvas.addEventListener("mouseleave", (event) => {
      const toggleChanged = setHoveredTreemapToggle(null);
      hideTreemapToggleTooltip();
      canvas.style.cursor = "default";
      if (
        isHoverCardVisible() &&
        event.relatedTarget &&
        hoverCard.contains(event.relatedTarget)
      ) {
        if (toggleChanged) {
          draw();
        }
        return;
      }
      if (hasLockedSelection()) {
        if (toggleChanged) {
          draw();
        }
        return;
      }
      if (!state.isDragging) {
        if (isPointInsideHoverBridge(event.clientX, event.clientY)) {
          if (toggleChanged) {
            draw();
          }
          return;
        }
        scheduleHoverUpdate(null);
      } else if (toggleChanged) {
        draw();
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
        })
      : null;

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
        if (event.target.closest("button, a, input, select, textarea")) {
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
        const original = copyMatchesBtn.textContent;
        copyMatchesBtn.textContent = "Copied";
        setTimeout(() => {
          copyMatchesBtn.textContent = original;
        }, 1200);
      } catch (error) {
        statusRight.textContent = `Copy failed: ${error.message || error}`;
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
      if (event.button !== 0) {
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
      if (advancedPopover.contains(event.target) || advancedControlsBtn.contains(event.target)) {
        return;
      }
      setAdvancedPopoverOpen(false);
    });

    closeSourceBtn.addEventListener("click", () => {
      closeSourcePanel();
    });

    toggleSourceFullscreenBtn.addEventListener("click", () => {
      state.sourcePanelFullscreen = !state.sourcePanelFullscreen;
      applySourcePanelWindowState();
      scheduleSourceVirtualRender(true);
    });

    sourceSearchModeSelect.addEventListener("change", () => {
      state.sourceSearchMode = sourceSearchModeSelect.value;
      state.sourceSearchMatchIndex = 0;
      renderCurrentSourceView(false);
    });

    sourceSearchInput.addEventListener("input", () => {
      applySourceSearchValue(sourceSearchInput.value);
    });

    sourceSearchInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") {
        return;
      }
      event.preventDefault();
      moveSourceSearch(event.shiftKey ? -1 : 1);
    });

    sourceSearchPrevBtn.addEventListener("click", () => {
      moveSourceSearch(-1);
    });

    sourceSearchNextBtn.addEventListener("click", () => {
      moveSourceSearch(1);
    });

    sourceCode.addEventListener("click", (event) => {
      const gutterButton = event.target.closest(".source-lineno");
      if (!gutterButton || !sourceCode.contains(gutterButton)) {
        return;
      }
      const lineNo = Number(gutterButton.dataset.line);
      if (!Number.isInteger(lineNo) || lineNo <= 0) {
        return;
      }
      event.preventDefault();
      toggleSourceBookmark(lineNo);
    });

    sourceCode.addEventListener("scroll", () => {
      scheduleSourceVirtualRender(false);
    });

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
      state.metric = metricSelect.value;
      if (state.metric === "weighted_signals") {
        state.layoutMode = "accurate";
        layoutSelect.value = state.layoutMode;
      }
      syncMetricHelp();
      savePersistedState();
      draw();
    });

    function updateWeightedMetricParameter(input, fieldName, fallback) {
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
      state.layoutMode = layoutSelect.value;
      syncMetricHelp();
      savePersistedState();
      draw();
    });

    decompositionSelect.addEventListener("change", () => {
      state.decomposition = decompositionSelect.value;
      syncMetricHelp();
      savePersistedState();
      draw();
    });

    analysisSelect.addEventListener("change", () => {
      state.analysisMode = analysisSelect.value;
      syncAnalysisControls();
      buildSignalAnalysis();
      savePersistedState();
      draw();
    });

    analysisPatternModeSelect.addEventListener("change", () => {
      state.analysisPatternMode = analysisPatternModeSelect.value;
      buildSignalAnalysis();
      savePersistedState();
      draw();
    });

    analysisPatternInput.addEventListener("input", () => {
      applyAnalysisPatternValue(analysisPatternInput.value, analysisPatternInput);
    });

    filterScopeSelect.addEventListener("change", () => {
      state.filterScope = filterScopeSelect.value;
      buildMatches();
      savePersistedState();
      draw();
    });

    filterModeSelect.addEventListener("change", () => {
      state.filterMode = filterModeSelect.value;
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

    registerSearchHistoryInput(sourceSearchInput, "source-search", {
      apply: (value) => {
        applySourceSearchValue(value, { immediate: true });
      },
      getValue: () => state.sourceSearch
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

    const matchPanelHeader = matchPanel.querySelector(".side-header");
    matchPanelHeader.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      if (event.target.closest("button, a, input, select, textarea")) {
        return;
      }
      if (!state.matchPanelOpen) {
        return;
      }
      applyMatchPanelPosition();
      const panelRect = canvasPanel.getBoundingClientRect();
      state.draggingMatchPanel = true;
      state.matchPanelDragOffsetX = event.clientX - panelRect.left - state.matchPanelLeft;
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
    setLoadingState(100, "Ready", `${nodes.length} hierarchy nodes ready.`);
    requestAnimationFrame(() => {
      loadingOverlay.classList.add("hidden");
      if (DATA.debugUiLabels) {
        scheduleUiAnnotations();
      }
    });
    })();
