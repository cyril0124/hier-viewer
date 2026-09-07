'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../rust-hier-viewer/src/html/viewer_chart.js'), 'utf8');
const functions = ['filterActive', 'isBranchIncluded', 'collectLevelNodes', 'threeFitDistance', 'createThreeViewState'].map((name) => {
  // Extract the original declarations, preserving their shared IIFE indentation.
  const matches = [...source.matchAll(new RegExp(`^    function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^    \\}`, 'gm'))];
  assert.equal(matches.length, 1, `complete declaration for ${name}`);
  return matches[0][0];
}).join('\n');

test('3D fit frames the complete scene within both camera angles', () => {
  for (const [width, height] of [[1280, 900], [390, 844], [766, 340]]) {
    const context = vm.createContext({ chartVisual: { clientWidth: width, clientHeight: height } });
    vm.runInContext(functions, context);
    for (const extent of [10.5, 80]) {
      const view = context.createThreeViewState(extent, 10.5);
      const aspect = width / height;
      const halfFov = Math.min(19 * Math.PI / 180, Math.atan(Math.tan(19 * Math.PI / 180) * aspect));
      const angularRadius = Math.asin(Math.hypot(extent, extent, 10.5) / (2 * view.distance));
      assert.ok(angularRadius < halfFov, `${width}x${height}: scene fits`);
      assert.equal(view.targetY, 5.25);
      assert.ok(view.distance < view.maxDistance);
    }
  }
});

function node(id, parent, children = []) {
  return { id, parent, children };
}

function runtime(nodes, matches = []) {
  const state = {
    search: matches.length ? 'match' : '',
    matchIds: new Set(matches),
    matchSubtreeIds: new Set(matches),
  };
  for (const id of matches) {
    let parent = nodes[id].parent;
    while (parent !== null && parent !== undefined) {
      state.matchSubtreeIds.add(parent);
      parent = nodes[parent].parent;
    }
  }
  const context = vm.createContext({ state, api: { getNode: (id) => nodes[id] } });
  vm.runInContext(functions, context, { filename: 'viewer_chart.runtime.js' });
  return (root, level) => Array.from(context.collectLevelNodes(root, level));
}

function branches() {
  return [
    node(0, null, [4, 2]),
    node(1, 3),
    node(2, 0, [5]),
    node(3, 4, [1]),
    node(4, 0, [3]),
    node(5, 2),
  ];
}

test('ancestor-only filter keeps Leaf after drilling into Block', () => {
  const collect = runtime(branches(), [4]);
  assert.deepEqual(collect(3, 1), [1]);
  assert.deepEqual(collect(1, 1), [1]);
  assert.deepEqual(collect(3, 0), [3]);
});

test('a matched branch does not expose unrelated siblings', () => {
  const collect = runtime(branches(), [4]);
  assert.deepEqual(collect(0, 3), [1]);
  assert.deepEqual(collect(2, 3), []);
  assert.deepEqual(collect(4, 2), [1]);
});

test('descendant matches keep ancestor frontiers and exclude unrelated leaves', () => {
  const collect = runtime(branches(), [1]);
  assert.deepEqual(collect(0, 0), [0]);
  assert.deepEqual(collect(0, 1), [4]);
  assert.deepEqual(collect(0, 2), [3]);
  assert.deepEqual(collect(0, 3), [1]);
});

test('Max level traverses a 30,000-node chain without call stack overflow', () => {
  const length = 30000;
  const nodes = Array.from({ length }, (_, id) =>
    node(id, id ? id - 1 : null, id + 1 < length ? [id + 1] : []));
  const collect = runtime(nodes);
  assert.deepEqual(collect(0, length - 1), [length - 1]);
  assert.deepEqual(collect(0, 12000), [12000]);
  const filtered = runtime(nodes, [0]);
  assert.deepEqual(filtered(length - 2, 1), [length - 1]);
});

test('a 200,000-child tree preserves the complete left-to-right frontier', () => {
  const nodes = Array.from({ length: 200001 }, (_, id) => node(id, id ? 0 : null));
  nodes[0].children = Array.from({ length: 200000 }, (_, index) => index + 1);
  const collect = runtime(nodes);
  assert.deepEqual(collect(0, 1), nodes[0].children);
});

test('frontiers retain early leaves at deeper requested levels', () => {
  const nodes = [node(0, null, [1, 2]), node(1, 0), node(2, 0, [3]), node(3, 2)];
  const collect = runtime(nodes);
  assert.deepEqual(collect(0, 0), [0]);
  assert.deepEqual(collect(0, 1), [1, 2]);
  assert.deepEqual(collect(0, 2), [1, 3]);
  assert.deepEqual(collect(0, 20), [1, 3]);
});

test('depth-first traversal follows child order rather than numeric node IDs', () => {
  const collect = runtime(branches());
  assert.deepEqual(collect(0, 1), [4, 2]);
  assert.deepEqual(collect(0, 2), [3, 5]);
  assert.deepEqual(collect(0, 3), [1, 5]);
});
