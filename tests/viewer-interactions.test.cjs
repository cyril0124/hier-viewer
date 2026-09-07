'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../rust-hier-viewer/src/html/template_app.js'), 'utf8');
function declarations(names) {
  return names.map((name) => {
    const matches = [...source.matchAll(new RegExp(`^    (?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^    \\}`, 'gm'))];
    assert.equal(matches.length, 1, `complete declaration for ${name}`);
    return matches[0][0];
  }).join('\n');
}

function hierarchy(nodes) {
  for (const node of nodes) {
    Object.assign(node, { parent: null, name: `hit-${node.id}`, module: 'Block', path: `hit-${node.id}` });
  }
  for (const node of nodes) {
    for (const child of node.children) nodes[child].parent = node.id;
  }
  const state = {
    search: 'hit', filterScope: 'instance', filterMode: 'substring', homeRoot: 0,
    currentRoot: 0, depthLimit: null, treeCollapsedIds: new Set(),
    analysisMode: 'count', analysisPattern: 'hit', analysisError: '',
    analysisLocalCounts: nodes.map(() => 0), analysisLocalLocs: nodes.map(() => 0),
    analysisLocalRatios: nodes.map(() => 0),
    analysisVisibleSubtreeQualified: nodes.map(() => false),
    analysisLegendVisibleSubtree: nodes.map(() => false),
  };
  const context = vm.createContext({ nodes, state,
    selectedAnalysisLegendBuckets: () => [1],
    analysisLegendLocalBucketMatches: (id) => state.analysisLocalCounts[id] > 0,
  });
  vm.runInContext(declarations([
    'getNode', 'visibleParent', 'splitSearchTerms', 'wildcardToRegExp', 'filterTargetText',
    'buildMatcher', 'buildMatches', 'forEachVisibleTreeNode', 'analysisActive',
    'analysisLocalValue', 'analysisNodeQualified', 'updateAnalysisVisibleExtents',
    'updateAnalysisLegendVisibleSubtree',
  ]), context);
  return context;
}

function chain(length) {
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
  const collapsed = [];
  context.forEachVisibleTreeNode((id) => collapsed.push(id));
  assert.deepEqual(collapsed, [0, 1, 2]);

  const branched = hierarchy([{ id: 0, children: [3, 2] }, { id: 1, children: [] },
    { id: 2, children: [] }, { id: 3, children: [1] }]);
  branched.state.depthLimit = 1;
  let rows = [];
  branched.forEachVisibleTreeNode((id) => rows.push(id));
  assert.deepEqual(rows, [0, 3, 2]);
  branched.state.currentRoot = 1;
  rows = [];
  branched.forEachVisibleTreeNode((id) => rows.push(id));
  assert.deepEqual(rows, [0, 3, 1, 2]);
});

function sourceRuntime(kind) {
  const frames = [];
  const renders = [];
  const statuses = [];
  const element = () => ({ textContent: '', innerHTML: '', href: '', classList: { add() {}, remove() {} } });
  const state = { sourceRequestToken: 0, sourceAbortController: null };
  const context = vm.createContext({
    state, AbortController, currentSourceView: { oldFile: true },
    sourceTitle: element(), sourceSubtitle: element(), sourceCode: element(),
    openRawSourceLink: element(), hoverCard: element(), sourcePanel: element(),
    getNode: (id) => ({ id, path: `node-${id}`, module: 'Block' }),
    preferredSourceTargetKind: () => kind,
    buildSourceTarget: (node) => ({ kind, line: 1, endLine: 2, titleSuffix: 'Source', url: `/${node.id}.sv` }),
    resolveSourceUrl: (target) => target.url,
    sourceBookmarkKeyForTarget: (target) => target.url,
    cancelScheduledHoverUpdate() {}, clearUiAnnotationHoverTargetWithin() {},
    applySourcePanelWindowState() {}, formatSourceLocation: () => 'file:1',
    renderCurrentSourceView() {}, hideSourceLoadProgress() {}, setSourceLoadProgress() {},
    showSourceStatus: (status) => statuses.push(status),
    nextFrame: () => new Promise((resolve) => frames.push(resolve)),
    loadFullSource: async (target) => ({ text: target.url, lines: [target.url, 'endmodule'] }),
    renderSourceRange: (node) => renders.push(node.id),
    renderSourceLines: (lines) => renders.push(lines[0]),
    emphasizeFocusedSourceRange: () => renders.push('focus'),
    sourceRenderModeStatusSuffix: () => '', escapeHtml: (text) => text,
  });
  vm.runInContext(declarations(['renderSource']), context);
  const advance = async () => {
    assert.ok(frames.length, 'render has reached the next frame');
    frames.shift()();
    await new Promise(setImmediate);
  };
  return { context, state, frames, renders, statuses, advance };
}

for (const kind of ['definition', 'instance']) {
  test(`${kind} source finishes rendering when it is not cancelled`, async () => {
    const { context, renders, statuses, advance } = sourceRuntime(kind);
    const pending = context.renderSource(1);
    for (let i = 0; i < (kind === 'definition' ? 2 : 4); i += 1) await advance();
    await pending;
    assert.deepEqual(renders, kind === 'definition' ? [1] : ['/1.sv', 'focus', 'focus']);
    assert.match(statuses.at(-1), /source loaded|Full file loaded/);
  });

  for (const boundary of (kind === 'definition' ? [0, 1] : [0, 1, 2, 3])) {
    test(`${kind} source cancellation at frame ${boundary} prevents stale UI writes`, async () => {
      const { context, state, renders, statuses, advance } = sourceRuntime(kind);
      const pending = context.renderSource(1);
      assert.equal(context.currentSourceView, null, 'old search and bookmark context cleared immediately');
      for (let i = 0; i < boundary; i += 1) await advance();
      state.sourceAbortController.abort();
      state.sourceAbortController = new AbortController();
      state.sourceRequestToken += 1;
      state.sourceNodeId = 2;
      const beforeRenders = renders.slice();
      const beforeStatuses = statuses.slice();
      await advance();
      await pending;
      assert.deepEqual(renders, beforeRenders);
      assert.deepEqual(statuses, beforeStatuses);
    });
  }
}
