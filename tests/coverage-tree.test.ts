import assert from "node:assert/strict";
import { test } from "vitest";
import {
  COVERAGE_TREE_ROW_HEIGHT,
  CoverageTreeModel,
  coverageTreeMetric,
  coverageTreeMetrics,
  coverageTreeWindow,
} from "../rust-hier-viewer/src/html/frontend/coverage-tree.js";
import type { CoverageDisplay } from "../rust-hier-viewer/src/html/frontend/coverage-types.js";

function node(id: number, name: string, children: number[] = [], module = "Unit", path = name) {
  return { id, name, module, path, children };
}

function tree() {
  // IDs and input order intentionally differ from preorder.
  return new CoverageTreeModel([
    node(40, "core", [70], "Cpu", "top.core"),
    node(10, "top", [40, 20]),
    node(70, "decode", [80], "Decoder", "top.core.decode"),
    node(20, "io", [30], "Peripheral", "top.io"),
    node(30, "uart", [], "SerialPort", "top.io.uart"),
    node(80, "target", [], "Leaf", "top.core.decode.target"),
  ], 10);
}

function ids(model: CoverageTreeModel) {
  return model.rows.map(row => row.node.id);
}

test("defaults to the expanded root and preserves descendant expansion across collapse", () => {
  const model = tree();
  assert.deepEqual(ids(model), [10, 40, 20]);
  assert.deepEqual(model.rows.map(row => row.depth), [0, 1, 1]);
  model.setExpanded(40, true);
  model.setExpanded(70, true);
  assert.deepEqual(ids(model), [10, 40, 70, 80, 20]);
  model.setExpanded(40, false);
  assert.deepEqual(ids(model), [10, 40, 20]);
  model.setExpanded(40, true);
  assert.deepEqual(ids(model), [10, 40, 70, 80, 20]);
  model.setExpanded(10, false);
  assert.deepEqual(ids(model), [10]);
});

test("search matches module, path and name case-insensitively and retains only ancestor paths", () => {
  const model = tree();
  model.setSearch("  sERIALpORT  ");
  assert.deepEqual(ids(model), [10, 20, 30]);
  assert.deepEqual(model.rows.map(row => row.ancestorMatch), [true, true, false]);
  assert.equal(model.matchCount, 1);
  model.setSearch("TOP.CORE.DECODE");
  assert.deepEqual(ids(model), [10, 40, 70, 80]);
  assert.equal(model.matchCount, 2);
  model.setSearch("target");
  assert.deepEqual(ids(model), [10, 40, 70, 80]);
  model.setExpanded(40, false);
  assert.deepEqual(ids(model), [10, 40]);
  model.setExpanded(40, true);
  assert.deepEqual(ids(model), [10, 40, 70, 80]);
  model.setSearch("missing");
  assert.deepEqual(ids(model), []);
  assert.equal(model.matchCount, 0);
  model.setSearch("");
  assert.deepEqual(ids(model), [10, 40, 20]);
});

test("reveal opens ancestors, clears an obstructing search, and leaves selection-only lookups cached", () => {
  const model = tree();
  model.setSearch("serialport");
  assert.equal(model.reveal(80), true);
  assert.equal(model.query, "");
  assert.deepEqual(ids(model), [10, 40, 70, 80, 20]);
  const rows = model.rows;
  assert.equal(model.visibleIndexById.get(80), 3);
  assert.equal(model.parentId(80), 70);
  assert.equal(model.parentId(10), undefined);
  assert.equal(model.reveal(80), true);
  assert.equal(model.setSearch(""), false);
  assert.equal(model.reveal(999), false);
  assert.equal(model.rows, rows);
});

test("search and reveal handle a 30,000-level chain without recursion or ancestor walks per match", () => {
  const length = 30_000;
  const nodes = Array.from({ length }, (_, id) => node(id, `n${id}`, id + 1 < length ? [id + 1] : []));
  const model = new CoverageTreeModel(nodes, 0);
  assert.deepEqual(ids(model), [0, 1]);
  model.setSearch("n29999");
  assert.equal(model.rows.length, length);
  assert.equal(model.rows.at(-1)?.depth, length - 1);
  assert.equal(model.matchCount, 1);
  model.setSearch("");
  model.reveal(length - 1);
  assert.equal(model.rows.length, length);
}, 10_000);

test("a wide tree keeps window bounds independent of total instances, including fractional scroll", () => {
  assert.equal(COVERAGE_TREE_ROW_HEIGHT, 36);
  assert.deepEqual(coverageTreeWindow(100_000, 0, 360), { start: 0, end: 18 });
  assert.deepEqual(coverageTreeWindow(100_000, 3600, 360), { start: 92, end: 118 });
  assert.deepEqual(coverageTreeWindow(100_000, 3601, 360), { start: 92, end: 119 });
  assert.deepEqual(coverageTreeWindow(100_000, 100_000 * 36, 360), { start: 99_982, end: 100_000 });
  assert.deepEqual(coverageTreeWindow(0, 500, 360), { start: 0, end: 0 });
  assert.deepEqual(coverageTreeWindow(3, -20, 360), { start: 0, end: 3 });
  assert.deepEqual(coverageTreeWindow(3, 999, 0), { start: 0, end: 3 });
  for (let scroll = 0; scroll < 3_600_000; scroll += 7193) {
    const window = coverageTreeWindow(100_000, scroll, 523);
    assert.ok(window.start >= 0 && window.end <= 100_000);
    assert.ok(window.end - window.start <= Math.ceil(523 / 36) + 17);
  }
});

function display(): CoverageDisplay {
  return {
    name: "Summary only",
    metric: "line",
    summary: {
      release: "test", roots: [0], byPath: new Map(),
      scopes: [
        { name: "root", path: "root", parent: null, children: [1], metrics: { line: { covered: 9, total: 10, excluded: 0 } } },
        { name: "child", path: "root.child", parent: 0, children: [], metrics: {
          line: { covered: 1, total: 4, excluded: 2 },
          toggle: { covered: 0, total: 0, excluded: 3 },
          branch: { covered: 0, total: 8, excluded: 0 },
        } },
      ],
    },
    mapping: {
      sourceRoot: 0, targetRoot: 0, scopeByNode: new Int32Array([0, 1, -1]),
      matched: 2, unmatchedScopes: [], unmatchedNodeIds: [2],
    },
  };
}

test("metric cells use exact mapped counts, distinguish missing, N/A and 0%, and preserve exclusions", () => {
  const coverage = display();
  assert.equal(coverageTreeMetric(coverage, 0, "line").text, "90.0%");
  assert.equal(coverageTreeMetric(coverage, 1, "line").text, "25.0%");
  assert.equal(coverageTreeMetric(coverage, 1, "line").title, "Line: 25.00% (1/4); excluded 2");
  assert.equal(coverageTreeMetric(coverage, 1, "toggle").text, "N/A");
  assert.equal(coverageTreeMetric(coverage, 1, "toggle").ratio, null);
  assert.match(coverageTreeMetric(coverage, 1, "toggle").title, /N\/A \(0\/0\); excluded 3/);
  assert.equal(coverageTreeMetric(coverage, 1, "branch").text, "0.0%");
  assert.equal(coverageTreeMetric(coverage, 1, "branch").ratio, 0);
  assert.equal(coverageTreeMetric(coverage, 1, "condition").text, "No data");
  assert.equal(coverageTreeMetric(coverage, 2, "line").text, "No data");
  assert.equal(coverageTreeMetric(undefined, 0, "line").text, "No data");
});

test("columns remain Line Toggle Condition Branch and add Assert whenever summary data includes it", () => {
  const coverage = display();
  assert.deepEqual(coverageTreeMetrics(undefined), ["line", "toggle", "condition", "branch"]);
  assert.deepEqual(coverageTreeMetrics(coverage), ["line", "toggle", "condition", "branch"]);
  coverage.summary.scopes[1].metrics.assert = { covered: 0, total: 0, excluded: 0 };
  assert.deepEqual(coverageTreeMetrics(coverage), ["line", "toggle", "condition", "branch", "assert"]);
  assert.equal(coverageTreeMetric(coverage, 0, "assert").text, "No data");
  assert.equal(coverageTreeMetric(coverage, 1, "assert").text, "N/A");
});
