import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { createTreemapRuntime } from "../rust-hier-viewer/src/html/frontend/treemap.js";
import type { TreemapDependencies } from "../rust-hier-viewer/src/html/frontend/treemap.js";
import { createViewerState } from "../rust-hier-viewer/src/html/frontend/state.js";
import { createHierarchyRuntime } from "../rust-hier-viewer/src/html/frontend/hierarchy-core.js";
import { hexToRgba } from "../rust-hier-viewer/src/html/frontend/ui.js";
import type { HierarchyNode, TreemapArea, ViewerData } from "../rust-hier-viewer/src/html/frontend/types.js";

// Small DOM and canvas stand-ins keep these runtime tests independent of a browser.
class TestElement {
  clientWidth = 900;
  clientHeight = 600;
  width = 900;
  height = 600;
  innerHTML = "";
  textContent = "";
  style = {};
  classes = new Set<string>();
  classList = {
    add: (name: string) => this.classes.add(name),
    remove: (name: string) => this.classes.delete(name),
    contains: (name: string) => this.classes.has(name),
    toggle: (name: string, enabled: boolean) => enabled ? this.classes.add(name) : this.classes.delete(name),
  };
  listeners = new Map<string, (event: Record<string, unknown>) => void>();
  appendChild = vi.fn();
  setAttribute() {}
  contains() { return false; }
  getBoundingClientRect() {
    return { left: 0, top: 0, right: this.clientWidth, bottom: this.clientHeight, width: this.clientWidth, height: this.clientHeight };
  }
  addEventListener(name: string, callback: (event: Record<string, unknown>) => void) {
    this.listeners.set(name, callback);
  }
  emit(name: string, properties: Record<string, unknown> = {}) {
    this.listeners.get(name)!({ clientX: 0, clientY: 0, button: 0, preventDefault() {}, ...properties });
  }
}

function node(id: number, parent: number | null, children: number[] = []): HierarchyNode {
  return {
    id, parent, children, name: `node-${id}`, module: "Block", path: `top.node-${id}`,
    depth: parent === null ? 0 : parent === 0 ? 1 : 2, definitionKey: null,
    subtreeInstances: children.length + 1, subtreeLeaves: Math.max(1, children.length),
    subtreeSignalCount: 10, subtreeInternalSignalCount: 10, subtreeSignalBits: 100,
    subtreeVariableBits: 80, subtreeNetBits: 20,
    moduleVariableCount: 8, moduleNetCount: 2, moduleSignalCount: 10,
    moduleVariableBits: 8, moduleNetBits: 2, moduleSignalBits: 10, moduleInternalSignalCount: 10,
    filePath: null, sourceHref: null, definitionFilePath: null, definitionSourceHref: null,
    line: null, column: null, endLine: null, endColumn: null,
    definitionLine: null, definitionColumn: null, definitionEndLine: null, definitionEndColumn: null,
  };
}

function fixture() {
  let nextFrame = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.stubGlobal("window", {
    devicePixelRatio: 1,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
  });
  vi.stubGlobal("document", { createElement: () => new TestElement(), getElementById: () => null });
  const data: ViewerData = {
    nodes: [node(0, null, [1, 2]), node(1, 0, [3, 4]), node(2, 0), node(3, 1), node(4, 1)],
    title: "Treemap tests", builtAtUnixMs: 0, debugUiLabels: false, rootId: 0,
    defaultMetric: "instances", analysisDefinitions: [], analysisFile: null,
  };
  const state = createViewerState(data);
  const canvas = new TestElement();
  const depthSelect = new TestElement();
  const hoverCard = new TestElement();
  hoverCard.clientWidth = 0;
  hoverCard.clientHeight = 0;
  hoverCard.classes.add("hidden");
  const fills: string[] = [];
  const ctx = {
    fillStyle: "", clearRect: vi.fn(), setTransform() {},
    fillRect() { fills.push(this.fillStyle); },
    strokeRect() {}, save() {}, restore() {}, beginPath() {}, closePath() {},
    rect() {}, clip() {}, setLineDash() {}, arc() {}, fill() {}, stroke() {},
    moveTo() {}, lineTo() {}, roundRect() {}, fillText() {},
    measureText: (text: string) => ({ width: text.length * 7 }),
  };
  const subtreeDepth = vi.fn((id: number) => id === 0 ? 2 : id === 1 ? 1 : 0);
  const controls = {
    applyMainViewMode: vi.fn(), applyZenModeState: vi.fn(),
    updateAnalysisVisibleExtents: vi.fn(), updateAnalysisLegendVisibleSubtree: vi.fn(),
    renderTreemapAnalysisLegend: vi.fn(), buildBreadcrumbs: vi.fn(), updateStatus: vi.fn(),
    renderTreePanel: vi.fn(), renderMatchPanel: vi.fn(), scheduleUiAnnotations: vi.fn(),
  };
  const chartRender = vi.fn();
  const dependencies = {
    state, canvas, ctx, depthSelect, hoverCard, nodes: data.nodes, DATA: data,
    getNode: (id: number) => data.nodes[id], subtreeDepth,
    currentMaxDepth: () => state.currentRoot === 0 ? 2 : 1,
    visibleParent: (id: number) => data.nodes[id].parent,
    analysisActive: () => state.analysisMode !== "none",
    analysisLocalValue: (id: number) => state.analysisLocalCounts[id],
    analysisNodeQualified: (id: number) => state.analysisLocalCounts[id] > 0,
    chartController: { render: chartRender },
    savePersistedState() {}, hideTreemapToggleTooltip() {}, showTreemapToggleTooltip() {},
    clearUiAnnotationHoverTargetWithin() {}, expandTreePath() {},
    nodeIsVisibleDescendantOf: (root: number, id: number) => root === 0 || id === root || data.nodes[id].parent === root,
    applyHoverCardPosition() {}, applyTreemapAnalysisLegendPosition() {},
    nodeHasInstanceSource: () => false, nodeHasDefinitionSource: () => false,
    nodeHasAnySource: () => false, renderSource: async () => {},
    decompositionLabel: () => "subtree only",
    themeSelect: new TestElement(), selectModeBtn: new TestElement(),
    hoverTopbar: new TestElement(), hoverSelectedPill: new TestElement(), hoverDismissBtn: new TestElement(),
    homeBtn: new TestElement(), upBtn: new TestElement(), sourcePanel: new TestElement(),
    hoverActions: new TestElement(), hoverPath: new TestElement(), hoverTitle: new TestElement(),
    hoverMeta: new TestElement(), openInstanceSourceBtn: new TestElement(), openModuleSourceBtn: new TestElement(),
    canvasPanel: new TestElement(), treemapAnalysisLegendHead: null,
    treemapAnalysisLegend: new TestElement(), treemapStage: new TestElement(),
    ...controls,
  } as unknown as TreemapDependencies;
  const runtime = createTreemapRuntime(dependencies);
  runtime.bindTreemapEvents();
  function flushFrame() {
    const callbacks = [...frames.values()];
    frames.clear();
    for (const callback of callbacks) callback(0);
  }
  function area(id: number, kind = "node") {
    return state.areas.find((entry) => entry.nodeId === id && entry.kind === kind)!;
  }
  return { runtime, state, data, canvas, depthSelect, hoverCard, ctx, fills, subtreeDepth, controls, chartRender, frames, flushFrame, area };
}

function coverageFixture() {
  const f = fixture();
  const coverage = {
    name: "test", metric: "line" as "line" | "condition" | "off", filterMask: 0,
    summary: {
      release: "test", roots: [0], byPath: new Map<string, number>(),
      scopes: f.data.nodes.map((entry, id) => ({
        name: entry.name, path: entry.path, parent: entry.parent, children: entry.children,
        metrics: {
          line: { covered: [90, 90, 0, 100, 0][id], total: 100, excluded: 0 },
          condition: { covered: id === 1 ? 0 : 100, total: 100, excluded: 0 },
        },
      })),
    },
    mapping: {
      sourceRoot: 0, targetRoot: 0, scopeByNode: new Int32Array([0, 1, 2, 3, -1]),
      matched: 4, unmatchedScopes: [], unmatchedNodeIds: [4],
    },
  };
  f.state.coverage = coverage;
  const hierarchy = createHierarchyRuntime(f.data.nodes, f.state, {
    analysisDefinitions: [], analysisFile: null, loadAnalysisDefinitions: async () => [],
    draw: f.runtime.draw,
    selectedAnalysisLegendBuckets: f.runtime.selectedAnalysisLegendBuckets,
    analysisLegendLocalBucketMatches: f.runtime.analysisLegendLocalBucketMatches,
  });
  function refreshFilter() {
    hierarchy.buildMatches();
    f.runtime.draw();
  }
  return { ...f, coverage, refreshFilter };
}

function center(area: TreemapArea) {
  return { clientX: area.rect.x + area.rect.w / 2, clientY: area.rect.y + area.rect.h / 2 };
}

afterEach(() => vi.unstubAllGlobals());

test("pan events paint once per frame and reuse layout, analysis and controls", () => {
  const f = fixture();
  f.runtime.draw();
  const initial = structuredClone(f.area(2).rect);
  const options = f.depthSelect.appendChild.mock.calls.length;
  f.canvas.emit("mousedown");
  for (let i = 1; i <= 40; i += 1) {
    f.canvas.emit("mousemove", { clientX: i, clientY: i * 2 });
  }
  assert.equal(f.ctx.clearRect.mock.calls.length, 1);
  assert.equal(f.frames.size, 1);
  f.flushFrame();
  assert.equal(f.ctx.clearRect.mock.calls.length, 2);
  assert.equal(f.subtreeDepth.mock.calls.length, 1);
  assert.equal(f.depthSelect.appendChild.mock.calls.length, options);
  for (const update of Object.values(f.controls)) assert.equal(update.mock.calls.length, 1);
  assert.equal(f.chartRender.mock.calls.length, 1);
  assert.equal(f.area(2).rect.x, initial.x + 40);
  assert.equal(f.area(2).rect.y, initial.y + 80);
});

test("wheel events use the final zoom once and refresh zoom status without content work", () => {
  const f = fixture();
  f.runtime.draw();
  for (let i = 0; i < 12; i += 1) {
    f.canvas.emit("wheel", { deltaY: -1, clientX: 300, clientY: 200 });
  }
  assert.equal(f.subtreeDepth.mock.calls.length, 1);
  assert.equal(f.frames.size, 1);
  f.flushFrame();
  assert.equal(f.subtreeDepth.mock.calls.length, 2);
  assert.equal(f.ctx.clearRect.mock.calls.length, 2);
  assert.equal(f.area(0).rect.w, f.canvas.clientWidth * f.state.zoom);
  assert.equal(f.area(0).rect.x, -f.state.viewX);
  assert.equal(f.controls.updateStatus.mock.calls.length, 2);
  assert.equal(f.controls.updateAnalysisVisibleExtents.mock.calls.length, 1);
  assert.equal(f.controls.renderTreePanel.mock.calls.length, 1);
  assert.equal(f.frames.size, 0);
});

test("hover changes and clearing coalesce paints without rebuilding layout", () => {
  const f = fixture();
  f.runtime.draw();
  for (const id of [2, 3, 4, 2]) f.runtime.updateHover(id);
  assert.equal(f.frames.size, 1);
  f.flushFrame();
  assert.equal(f.state.hoverId, 2);
  assert.equal(f.ctx.clearRect.mock.calls.length, 2);
  assert.equal(f.subtreeDepth.mock.calls.length, 1);
  const projectedAreas = f.state.areas;
  f.canvas.emit("mousemove", center(f.area(2)));
  assert.equal(f.frames.size, 0);
  assert.equal(f.state.areas, projectedAreas);
  f.runtime.updateHover(null);
  f.flushFrame();
  assert.equal(f.ctx.clearRect.mock.calls.length, 3);
  assert.equal(f.hoverCard.classes.has("hidden"), true);
  assert.equal(f.controls.updateAnalysisLegendVisibleSubtree.mock.calls.length, 1);
});

test("hover hit testing catches up with pan before the scheduled paint", () => {
  const f = fixture();
  f.runtime.draw();
  const target = center(f.area(2));
  f.canvas.emit("mousedown");
  f.canvas.emit("mousemove", { clientX: 110, clientY: 40 });
  f.state.isDragging = false;
  f.canvas.emit("mousemove", { clientX: target.clientX + 110, clientY: target.clientY + 40 });
  assert.equal(f.state.hoverId, 2);
  assert.equal(f.ctx.clearRect.mock.calls.length, 1);
  assert.equal(f.subtreeDepth.mock.calls.length, 1);
  f.flushFrame();
  assert.equal(f.ctx.clearRect.mock.calls.length, 2);
});

test("collapse hit testing uses new zoom geometry before the scheduled paint", () => {
  const f = fixture();
  f.runtime.draw();
  f.runtime.changeZoom(2, 0, 0);
  // The heavier right branch reaches the root's right and bottom inner margins.
  const rootWidth = f.canvas.clientWidth * 2;
  const rootHeight = f.canvas.clientHeight * 2;
  f.canvas.emit("click", { clientX: rootWidth - 8 - 14.5, clientY: rootHeight - 8 - 14.5 });
  assert.equal(f.state.treeCollapsedIds.has(1), true);
  assert.equal(f.state.areas.some((entry) => entry.nodeId === 3), false);
});

test("full draws invalidate in-place collapse, metric, weights, layout, decomposition and depth changes", () => {
  const f = fixture();
  f.runtime.draw();
  assert.ok(f.area(3));
  f.state.treeCollapsedIds.add(1);
  f.runtime.draw();
  assert.equal(f.area(3), undefined);
  f.runtime.clearAllTreemapCollapsedNodes();
  assert.ok(f.area(3));
  f.state.depthLimit = 1;
  f.runtime.draw();
  assert.equal(f.area(3), undefined);
  f.state.depthLimit = null;
  f.state.metric = "weighted_signals";
  f.state.layoutMode = "accurate";
  f.state.decomposition = "self";
  f.data.nodes[1].subtreeVariableBits = 100;
  f.data.nodes[1].subtreeNetBits = 1;
  f.data.nodes[2].subtreeVariableBits = 1;
  f.data.nodes[2].subtreeNetBits = 100;
  f.runtime.draw();
  assert.ok(f.area(1, "self"));
  const variableArea = f.area(1).rect.w * f.area(1).rect.h;
  f.state.weightedVariableWeight = 0.01;
  f.state.weightedNetWeight = 1;
  f.runtime.draw();
  assert.ok(f.area(1).rect.w * f.area(1).rect.h < variableArea);
  f.state.layoutMode = "classic";
  f.runtime.draw();
  assert.equal(f.area(1, "self"), undefined);
});

test("root changes with locked selection invalidate content and cancel stale interaction frames", () => {
  const f = fixture();
  f.runtime.draw();
  f.state.selectedId = 3;
  f.runtime.updateHover(3);
  f.runtime.setRootAndReset(1);
  assert.equal(f.state.selectedId, 3);
  assert.equal(f.area(1).level, 0);
  assert.equal(f.area(2), undefined);
  assert.equal(f.frames.size, 0);
  assert.equal(f.controls.buildBreadcrumbs.mock.lastCall?.[0], 1);
});

test("resize during an interaction rebuilds geometry and canvas backing dimensions", () => {
  const f = fixture();
  f.runtime.draw();
  f.canvas.clientWidth = 1200;
  f.canvas.clientHeight = 800;
  f.runtime.updateHover(2);
  f.flushFrame();
  assert.equal(f.canvas.width, 1200);
  assert.equal(f.canvas.height, 800);
  assert.equal(f.area(0).rect.w, 1200);
  assert.equal(f.area(0).rect.h, 800);
  assert.equal(f.subtreeDepth.mock.calls.length, 2);
});

for (const mode of ["pie2d", "three3d"] as const) {
  test(`${mode} skips treemap geometry and painting but retains global updates`, () => {
    const f = fixture();
    f.runtime.draw();
    f.runtime.updateHover(2);
    f.state.mainViewMode = mode;
    f.runtime.draw();
    assert.equal(f.frames.size, 0);
    assert.equal(f.state.areas.length, 0);
    assert.equal(f.subtreeDepth.mock.calls.length, 1);
    assert.equal(f.ctx.clearRect.mock.calls.length, 1);
    for (const update of Object.values(f.controls)) assert.equal(update.mock.calls.length, 2);
    assert.equal(f.chartRender.mock.calls.length, 2);
    f.state.treeCollapsedIds.add(1);
    f.state.mainViewMode = "treemap";
    f.runtime.draw();
    assert.equal(f.area(3), undefined);
    assert.equal(f.ctx.clearRect.mock.calls.length, 2);
  });
}

test("full draws refresh search, analysis and in-place coverage colors", () => {
  const f = fixture();
  f.runtime.draw();
  f.state.search = "node-2";
  f.state.matches = [2];
  f.state.matchIds.add(2);
  f.state.matchSubtreeIds.add(0);
  f.state.matchSubtreeIds.add(2);
  f.runtime.draw();
  assert.equal(f.runtime.isMatch(2), true);
  assert.equal(f.runtime.shouldDim(1), true);
  f.state.search = "";
  f.state.analysisMode = "count";
  f.state.analysisLocalCounts[2] = 5;
  f.state.analysisVisibleMaxCount = 5;
  f.runtime.draw();
  assert.equal(f.runtime.shouldDim(2), false);
  f.state.analysisLegendFilter = ["bucket-1"];
  f.runtime.draw();
  assert.equal(f.runtime.shouldDim(2), true);
  assert.equal(f.controls.updateAnalysisVisibleExtents.mock.calls.length, 4);
  assert.equal(f.controls.updateAnalysisLegendVisibleSubtree.mock.calls.length, 4);
  f.state.analysisMode = "none";
  f.state.coverage = {
    name: "test", metric: "line",
    summary: {
      release: "test", roots: [0], byPath: new Map(),
      scopes: [{ name: "top", path: "top", parent: null, children: [], metrics: { line: { total: 10, covered: 0, excluded: 0 } } }],
    },
    mapping: { sourceRoot: 0, targetRoot: 0, scopeByNode: new Int32Array(5), matched: 5, unmatchedScopes: [], unmatchedNodeIds: [] },
  };
  f.fills.length = 0;
  f.runtime.draw();
  const uncovered = f.fills[0];
  f.state.coverage.summary.scopes[0].metrics.line!.covered = 10;
  f.fills.length = 0;
  f.runtime.draw();
  assert.notEqual(f.fills[0], uncovered);
});

test("coverage filters refresh painted matches and dimming through full and interaction draws", () => {
  const f = coverageFixture();
  const theme = f.runtime.currentThemeVisuals();
  const matchFill = hexToRgba(theme.match, 0.34);
  const dimFill = hexToRgba(theme.panel, 0.88);
  f.refreshFilter();
  const initialGeometry = structuredClone(f.state.areas);

  f.coverage.filterMask = 1;
  f.fills.length = 0;
  f.refreshFilter();
  assert.deepEqual(f.state.matches, [2]);
  assert.equal(f.runtime.isMatch(2), true);
  assert.equal(f.runtime.shouldDim(1), true);
  assert.ok(f.fills.includes(matchFill));
  assert.ok(f.fills.includes(dimFill));
  assert.deepEqual(f.state.areas, initialGeometry);

  f.runtime.updateHover(2);
  f.coverage.filterMask = 1 << 3;
  f.refreshFilter();
  assert.equal(f.frames.size, 0);
  assert.deepEqual(f.state.matches, [3]);
  assert.equal(f.runtime.isMatch(2), false);
  assert.equal(f.runtime.shouldDim(2), true);
  assert.equal(f.runtime.hasMatchedDescendant(1), true);
  const layouts = f.subtreeDepth.mock.calls.length;
  const contentUpdates = f.controls.updateAnalysisVisibleExtents.mock.calls.length;
  f.fills.length = 0;
  f.canvas.emit("mousedown");
  f.canvas.emit("mousemove", { clientX: 10, clientY: 10 });
  f.flushFrame();
  assert.equal(f.subtreeDepth.mock.calls.length, layouts);
  assert.equal(f.controls.updateAnalysisVisibleExtents.mock.calls.length, contentUpdates);
  assert.ok(f.fills.includes(matchFill));
  assert.ok(f.fills.includes(dimFill));

  f.coverage.filterMask = 1 << 1;
  f.fills.length = 0;
  f.refreshFilter();
  assert.deepEqual(f.state.matches, []);
  assert.equal(f.runtime.shouldDim(2), true);
  assert.equal(f.fills.includes(matchFill), false);
  assert.ok(f.fills.includes(dimFill));

  f.coverage.filterMask = 1 << 4;
  f.refreshFilter();
  assert.deepEqual(f.state.matches, [4]);
  assert.equal(f.runtime.isMatch(4), true);
  f.coverage.mapping.scopeByNode[4] = 3;
  f.refreshFilter();
  assert.deepEqual(f.state.matches, []);

  f.coverage.filterMask = 1;
  f.coverage.metric = "condition";
  f.refreshFilter();
  assert.deepEqual(f.state.matches, [1]);
  assert.equal(f.runtime.shouldDim(3), true);
  f.coverage.metric = "off";
  f.coverage.filterMask = 0;
  f.fills.length = 0;
  f.refreshFilter();
  assert.equal(f.runtime.isMatch(1), false);
  assert.equal(f.runtime.shouldDim(2), false);
  assert.equal(f.fills.includes(dimFill), false);
  delete f.state.coverage;
  f.refreshFilter();
  assert.equal(f.runtime.shouldDim(2), false);
});

for (const mode of ["pie2d", "three3d"] as const) {
  test(`${mode} coverage changes and pending interaction frames never access the hidden canvas`, () => {
    const f = coverageFixture();
    f.refreshFilter();
    f.runtime.updateHover(2);
    const canvasBounds = vi.spyOn(f.canvas, "getBoundingClientRect");
    f.state.mainViewMode = mode;
    f.flushFrame();
    f.coverage.filterMask = 1;
    f.refreshFilter();
    assert.deepEqual(f.state.matches, [2]);
    f.coverage.metric = "condition";
    f.refreshFilter();
    assert.deepEqual(f.state.matches, [1]);
    f.runtime.updateHover(1);
    f.canvas.emit("mousemove", { clientX: 200, clientY: 100 });
    f.flushFrame();
    assert.equal(f.frames.size, 0);
    assert.equal(f.state.areas.length, 0);
    assert.equal(canvasBounds.mock.calls.length, 0);
    assert.equal(f.subtreeDepth.mock.calls.length, 1);
    assert.equal(f.ctx.clearRect.mock.calls.length, 1);
    assert.equal(f.controls.updateStatus.mock.calls.length, 3);
    assert.equal(f.controls.renderMatchPanel.mock.calls.length, 3);
    assert.equal(f.chartRender.mock.calls.length, 3);
    f.state.mainViewMode = "treemap";
    f.runtime.draw();
    assert.equal(f.runtime.isMatch(1), true);
    assert.equal(f.runtime.shouldDim(2), true);
    assert.equal(f.ctx.clearRect.mock.calls.length, 2);
  });
}
