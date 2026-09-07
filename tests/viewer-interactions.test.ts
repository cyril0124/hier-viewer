import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createHierarchyRuntime } from '../rust-hier-viewer/src/html/frontend/hierarchy-core';
import type { HierarchyModelNode, HierarchyState } from '../rust-hier-viewer/src/html/frontend/hierarchy-core';

function hierarchy(input: Array<Pick<HierarchyModelNode, 'id' | 'children'>>) {
  const nodes: HierarchyModelNode[] = input.map((node) => Object.assign(node, {
    parent: null, name: `hit-${node.id}`, module: 'Block', path: `hit-${node.id}`,
    definitionKey: null, moduleInternalSignalCount: 10, subtreeInternalSignalCount: 10,
    definitionLine: 2, definitionEndLine: 4,
  }));
  for (const node of nodes) {
    for (const child of node.children) nodes[child].parent = node.id;
  }
  const state: HierarchyState = {
    homeRoot: 0, currentRoot: 0, depthLimit: null, treeCollapsedIds: new Set(),
    search: 'hit', filterScope: 'instance', filterMode: 'substring' as HierarchyState['filterMode'], searchError: '',
    matches: [], matchIds: new Set(), matchVisibleIds: new Set(), matchSubtreeIds: new Set(),
    matchLines: [], treePanelDirty: false, matchPanelDirty: false,
    analysisMode: 'count', analysisPatternMode: 'substring' as HierarchyState['analysisPatternMode'], analysisPattern: 'hit',
    analysisError: '', analysisMaxSubtreeCount: 0, chartPanelDirty: false,
    analysisLocalCounts: new Array<number>(nodes.length).fill(0),
    analysisSubtreeCounts: new Array<number>(nodes.length).fill(0),
    analysisLocalLocs: new Array<number>(nodes.length).fill(0),
    analysisSubtreeLocs: new Array<number>(nodes.length).fill(0),
    analysisLocalRatios: new Array<number>(nodes.length).fill(0),
    analysisSubtreeRatios: new Array<number>(nodes.length).fill(0),
    analysisVisibleMaxCount: 0, analysisVisibleMaxLoc: 0, analysisVisibleMaxRatio: 0,
    analysisVisibleSubtreeQualified: new Array<boolean>(nodes.length).fill(false),
    analysisLegendVisibleSubtree: new Array<boolean>(nodes.length).fill(false),
  };
  const hierarchy = createHierarchyRuntime(nodes, state, {
    analysisDefinitions: [],
    analysisFile: 'analysis.bin',
    loadAnalysisDefinitions: async () => { throw new Error('Unexpected analysis load'); },
    draw() {},
    selectedAnalysisLegendBuckets: () => [1],
    analysisLegendLocalBucketMatches: (id) => state.analysisLocalCounts[id] > 0,
  });
  return Object.assign(hierarchy, { nodes, state });
}

function chain(length: number) {
  return Array.from({ length }, (_, id) => ({ id, children: id + 1 < length ? [id + 1] : [] }));
}

for (const search of ['', '[']) {
  test(`filter ${JSON.stringify(search)} invalidates panels and removes old matches`, () => {
    const context = hierarchy(chain(3));
    context.buildMatches();
    assert.equal(context.state.matches.length, 3);
    Object.assign(context.state, { treePanelDirty: false, matchPanelDirty: false, search, filterMode: 'regex' });
    context.buildMatches();
    assert.equal(context.state.treePanelDirty, true);
    assert.equal(context.state.matchPanelDirty, true);
    assert.equal(context.state.matches.length, 0);
    assert.equal(context.state.matchVisibleIds.size, 0);
    assert.equal(context.state.matchSubtreeIds.size, 0);
    assert.equal(context.state.matchLines.length, 0);
    assert.equal(Boolean(context.state.searchError), Boolean(search));
  });
}

test('broad filters traverse ancestors linearly and retain the hidden forest root', () => {
  const context = hierarchy(chain(30000));
  context.state.homeRoot = 1;
  context.nodes[0].name = 'forest';
  let reads = 0;
  for (const node of context.nodes) {
    const parent = node.parent;
    Object.defineProperty(node, 'parent', { get() { reads += 1; return parent; } });
  }
  context.buildMatches();
  assert.equal(context.state.matches.length, 29999);
  assert.equal(context.state.matchVisibleIds.size, 29999);
  assert.equal(context.state.matchVisibleIds.has(0), false);
  assert.equal(context.state.matchSubtreeIds.size, 30000);
  assert.ok(reads < context.nodes.length * 8, `${reads} parent reads`);
});

test('filter ancestors follow links even when node IDs are not topological', () => {
  const context = hierarchy([{ id: 0, children: [3] }, { id: 1, children: [] },
    { id: 2, children: [1] }, { id: 3, children: [2] }]);
  context.state.homeRoot = 3;
  context.state.search = 'hit-1';
  context.buildMatches();
  assert.deepEqual([...context.state.matchVisibleIds], [1, 2, 3]);
  assert.deepEqual([...context.state.matchSubtreeIds], [1, 2, 3, 0]);
});

test('analysis visibility and legend propagation handle deep trees and depth changes', () => {
  const context = hierarchy(chain(30000));
  const state = context.state;
  state.analysisLocalCounts[29999] = 7;
  state.analysisLocalLocs[29999] = 11;
  state.analysisLocalRatios[29999] = 0.5;
  context.updateAnalysisVisibleExtents();
  context.updateAnalysisLegendVisibleSubtree();
  assert.equal(state.analysisVisibleMaxCount, 7);
  assert.equal(state.analysisVisibleMaxLoc, 11);
  assert.equal(state.analysisVisibleMaxRatio, 0.5);
  assert.ok(state.analysisVisibleSubtreeQualified.every(Boolean));
  assert.ok(state.analysisLegendVisibleSubtree.every(Boolean));
  state.depthLimit = 2;
  context.updateAnalysisVisibleExtents();
  context.updateAnalysisLegendVisibleSubtree();
  assert.equal(state.analysisVisibleMaxCount, 0);
  assert.ok(state.analysisVisibleSubtreeQualified.every((value) => !value));
  assert.ok(state.analysisLegendVisibleSubtree.every((value) => !value));
  state.currentRoot = 29998;
  context.updateAnalysisVisibleExtents();
  context.updateAnalysisLegendVisibleSubtree();
  assert.equal(state.analysisVisibleMaxCount, 7);
  assert.equal(state.analysisVisibleSubtreeQualified[29998], true);
  assert.equal(state.analysisVisibleSubtreeQualified[0], false);
  assert.equal(state.analysisLegendVisibleSubtree[29998], true);
  assert.equal(state.analysisLegendVisibleSubtree[0], false);
});

test('tree traversal handles deep trees and preserves collapse, depth and branch order', () => {
  const context = hierarchy(chain(30000));
  let count = 0;
  context.forEachVisibleTreeNode((id, depth) => {
    assert.equal(id, depth);
    count += 1;
  });
  assert.equal(count, 30000);
  context.state.treeCollapsedIds.add(2);
  const collapsed: number[] = [];
  context.forEachVisibleTreeNode((id) => collapsed.push(id));
  assert.deepEqual(collapsed, [0, 1, 2]);

  const branched = hierarchy([{ id: 0, children: [3, 2] }, { id: 1, children: [] },
    { id: 2, children: [] }, { id: 3, children: [1] }]);
  branched.state.depthLimit = 1;
  let rows: number[] = [];
  branched.forEachVisibleTreeNode((id) => rows.push(id));
  assert.deepEqual(rows, [0, 3, 2]);
  branched.state.currentRoot = 1;
  rows = [];
  branched.forEachVisibleTreeNode((id) => rows.push(id));
  assert.deepEqual(rows, [0, 3, 1, 2]);
});
