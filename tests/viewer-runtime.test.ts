import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { createHierarchyRuntime } from '../rust-hier-viewer/src/html/frontend/hierarchy-core';
import type {
  HierarchyDependencies, HierarchyModelNode, HierarchyState,
} from '../rust-hier-viewer/src/html/frontend/hierarchy-core';
import type { AnalysisDefinition } from '../rust-hier-viewer/src/html/frontend/types';

function node(id: number, children: number[] = [], definitionKey: string | null = null): HierarchyModelNode {
  return {
    id, children, definitionKey,
    name: `hit-${id}`, module: 'Block', path: `hit-${id}`, parent: null,
    moduleInternalSignalCount: 10, subtreeInternalSignalCount: 10,
    definitionLine: 2, definitionEndLine: 4,
  };
}

function runtime(
  nodes: HierarchyModelNode[],
  definitions: AnalysisDefinition[] | null = [],
  callbacks: Partial<Pick<HierarchyDependencies, 'loadAnalysisDefinitions' | 'draw'>> = {},
) {
  const state: HierarchyState = {
    homeRoot: 0, currentRoot: 0, depthLimit: null, treeCollapsedIds: new Set(),
    search: '', filterScope: 'instance', filterMode: 'substring' as HierarchyState['filterMode'], searchError: '',
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
    analysisDefinitions: definitions,
    analysisFile: 'analysis.bin',
    loadAnalysisDefinitions: async () => { throw new Error('Unexpected analysis load'); },
    draw() {},
    selectedAnalysisLegendBuckets: () => [],
    analysisLegendLocalBucketMatches: () => false,
    ...callbacks,
  });
  return Object.assign(hierarchy, { nodes, state });
}

function chain(length: number) {
  return Array.from({ length }, (_, id) => node(id, id + 1 < length ? [id + 1] : []));
}

test('subtreeDepth handles 200,000 children and caches every node', () => {
  const nodes = Array.from({ length: 200001 }, (_, id) => node(id));
  nodes[0].children = Array.from({ length: 200000 }, (_, i) => i + 1);
  const { proxy, revoke } = Proxy.revocable(nodes, {});
  const context = runtime(proxy);
  assert.equal(context.subtreeDepth(0), 1);
  assert.equal(context.subtreeDepthCache[0], 1);
  assert.ok(context.subtreeDepthCache.slice(1).every((depth) => depth === 0));
  // Revoking the input makes every getNode array access fail after caching.
  revoke();
  assert.equal(context.subtreeDepth(0), 1);
  assert.equal(context.subtreeDepth(100000), 0);
});

test('subtreeDepth handles a 30,000-node chain including a cached subtree', () => {
  const context = runtime(chain(30000));
  assert.equal(context.subtreeDepth(15000), 14999);
  assert.equal(context.subtreeDepth(0), 29999);
  for (let id = 0; id < 30000; id += 1) {
    assert.equal(context.subtreeDepthCache[id], 29999 - id);
  }
});

test('computeAnalysisSubtree handles a deep chain and preserves counts, LOC and ratios', () => {
  const context = runtime(chain(30000));
  context.state.analysisLocalCounts.fill(2);
  context.state.analysisLocalLocs.fill(3);
  const totals = context.computeAnalysisSubtree(0);
  assert.equal(totals.count, 60000);
  assert.equal(totals.loc, 90000);
  for (let id = 0; id < 30000; id += 1) {
    assert.equal(context.state.analysisSubtreeCounts[id], (30000 - id) * 2);
    assert.equal(context.state.analysisSubtreeLocs[id], (30000 - id) * 3);
    assert.equal(context.state.analysisLocalRatios[id], 0.2);
    assert.equal(context.state.analysisSubtreeRatios[id], (30000 - id) / 5);
  }
});

test('tree calculations follow child links, not numeric node ordering', () => {
  const nodes = [node(0, [3]), node(1), node(2, [1]), node(3, [2])];
  nodes[1].moduleInternalSignalCount = 0;
  nodes[1].subtreeInternalSignalCount = 0;
  const context = runtime(nodes);
  context.state.analysisLocalCounts = [1, 2, 3, 4];
  context.state.analysisLocalLocs = [2, 4, 6, 8];
  assert.equal(context.subtreeDepth(0), 3);
  assert.equal(context.computeAnalysisSubtree(3).count, 9);
  assert.equal(context.state.analysisSubtreeCounts[0], 0);
  assert.equal(context.computeAnalysisSubtree(0).loc, 20);
  assert.deepEqual(context.state.analysisSubtreeCounts, [10, 2, 5, 9]);
  assert.equal(context.state.analysisLocalRatios[1], 0);
  assert.equal(context.state.analysisSubtreeRatios[1], 0);
});

test('shared definitions read and match each stat once per pattern build', () => {
  let reads = 0;
  const definitions = ['a', 'b'].map((definitionKey) => ({
    definitionKey,
    signalStats: ['hit', 'miss', 'hit_again'].map((name) => ({ signalKind: 'wire', totalBits: 1,
      get signalName() { reads += 1; return name; }, signalCount: 2,
    })),
  }));
  const nodes = Array.from({ length: 10001 }, (_, id) => node(id, [], id % 2 ? 'a' : 'b'));
  nodes[0].children = nodes.slice(1).map((entry) => entry.id);
  const context = runtime(nodes, definitions);
  let matches = 0;
  // Observe the real substring matcher without replacing a production function.
  const firstMatches = vi.spyOn(String.prototype, 'includes');
  context.buildSignalAnalysis();
  matches += firstMatches.mock.calls.length;
  firstMatches.mockRestore();
  assert.equal(context.state.analysisSubtreeCounts[0], nodes.length * 4);
  assert.equal(reads, 6);
  assert.equal(matches, 6);
  context.state.analysisPattern = 'miss';
  const secondMatches = vi.spyOn(String.prototype, 'includes');
  context.buildSignalAnalysis();
  matches += secondMatches.mock.calls.length;
  secondMatches.mockRestore();
  assert.equal(context.state.analysisSubtreeCounts[0], nodes.length * 2);
  assert.equal(reads, 12);
  assert.equal(matches, 12);
});

test('unreferenced definitions are not scanned after hierarchy filtering', () => {
  const definitions = [{ definitionKey: 'used', signalStats: [{ signalKind: 'wire', totalBits: 1, signalName: 'hit', signalCount: 4 }] }];
  for (let i = 0; i < 1000; i += 1) {
    definitions.push({ definitionKey: `unused-${i}`, signalStats: [{ signalKind: 'wire', totalBits: 1,
      get signalName(): string { throw new Error('unreferenced signal was scanned'); }, signalCount: 1,
    }] });
  }
  const context = runtime([node(0, [1], 'used'), node(1, [], 'used')], definitions);
  context.buildSignalAnalysis();
  assert.deepEqual(context.state.analysisLocalCounts, [4, 4]);
  assert.equal(context.state.analysisSubtreeCounts[0], 8);
});

test('pattern and mode changes reset counts, ratios, LOC and unknown definitions', () => {
  const nodes = [node(0, [1, 2, 3]), node(1, [], 'shared'), node(2, [], 'shared'), node(3, [], 'unknown')];
  nodes[0].definitionLine = 0;
  nodes[0].subtreeInternalSignalCount = 30;
  const context = runtime(nodes, [{ definitionKey: 'shared', signalStats: [
    { signalKind: 'wire', totalBits: 1, signalName: 'hit', signalCount: 2 }, { signalKind: 'wire', totalBits: 1, signalName: 'miss', signalCount: 3 },
  ] }]);
  const state = context.state;
  context.buildSignalAnalysis();
  assert.deepEqual(state.analysisLocalCounts, [0, 2, 2, 0]);
  assert.equal(state.analysisMaxSubtreeCount, 2);
  state.analysisMode = 'ratio';
  state.analysisPatternMode = 'regex';
  state.analysisPattern = '^miss$';
  context.buildSignalAnalysis();
  assert.deepEqual(state.analysisLocalCounts, [0, 3, 3, 0]);
  assert.deepEqual(state.analysisLocalRatios, [0, 0.3, 0.3, 0]);
  assert.equal(state.analysisSubtreeRatios[0], 0.2);
  state.analysisPatternMode = 'wildcard';
  context.buildSignalAnalysis();
  assert.deepEqual(state.analysisLocalCounts, [0, 0, 0, 0]);
  state.analysisPattern = 'h*';
  context.buildSignalAnalysis();
  assert.deepEqual(state.analysisLocalCounts, [0, 2, 2, 0]);
  state.analysisMode = 'loc';
  context.buildSignalAnalysis();
  assert.deepEqual(state.analysisLocalCounts, [0, 0, 0, 0]);
  assert.deepEqual(state.analysisLocalLocs, [0, 3, 3, 3]);
  assert.equal(state.analysisSubtreeLocs[0], 9);
  state.analysisMode = 'none';
  context.buildSignalAnalysis();
  for (const field of ['LocalCounts', 'SubtreeCounts', 'LocalLocs', 'SubtreeLocs', 'LocalRatios', 'SubtreeRatios'] as const) {
    assert.ok(state[`analysis${field}`].every((value) => value === 0));
  }
  state.analysisMode = 'count';
  context.buildSignalAnalysis();
  assert.equal(state.analysisSubtreeCounts[0], 4);
  state.analysisPattern = '';
  context.buildSignalAnalysis();
  assert.equal(state.analysisSubtreeCounts[0], 0);
  assert.equal(state.analysisMaxSubtreeCount, 0);
  state.analysisPattern = 're:[';
  context.buildSignalAnalysis();
  assert.match(state.analysisError, /^Invalid analysis pattern:/);
  assert.equal(state.analysisSubtreeCounts[0], 0);
});

for (const outcome of ['success', 'failure']) {
  test(`analysis load ${outcome} marks charts dirty before drawing`, async () => {
    let resolveLoad!: (definitions: AnalysisDefinition[]) => void;
    let rejectLoad!: (reason: unknown) => void;
    const draws: Array<{ dirty: boolean; count: number; error: string }> = [];
    const context = runtime([node(0, [], 'a')], null, {
      loadAnalysisDefinitions: () => new Promise((resolve, reject) => {
        resolveLoad = resolve;
        rejectLoad = reject;
      }),
      draw: () => { draws.push({
        dirty: context.state.chartPanelDirty,
        count: context.state.analysisLocalCounts[0],
        error: context.state.analysisError,
      }); },
    });
    context.ensureAnalysisDefinitionsRequested();
    const pending = context.pendingAnalysis;
    context.ensureAnalysisDefinitionsRequested();
    assert.equal(context.pendingAnalysis, pending);
    assert.equal(draws.length, 0);
    if (outcome === 'success') {
      resolveLoad([{ definitionKey: 'a', signalStats: [{ signalKind: 'wire', totalBits: 1, signalName: 'hit', signalCount: 7 }] }]);
    } else {
      rejectLoad(new Error('load failed'));
    }
    await pending;
    assert.equal(context.pendingAnalysis, null);
    assert.equal(draws.length, 1);
    assert.equal(draws[0].dirty, true);
    if (outcome === 'success') {
      assert.equal(draws[0].count, 7);
      assert.equal(draws[0].error, '');
    } else {
      assert.equal(draws[0].count, 0);
      assert.match(draws[0].error, /Failed to load signal analysis data: load failed/);
    }
  });
}
