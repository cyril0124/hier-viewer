import assert from "node:assert/strict";
import { validateCoverageSource } from "../rust-hier-viewer/src/html/frontend/coverage-source.js";
import { test } from "vitest";
import { formatCoverageExport, type CoverageExportEntry } from "../rust-hier-viewer/src/html/frontend/coverage-export.js";
import type { CoverageMetricDetail, CoverageSelection } from "../rust-hier-viewer/src/html/frontend/coverage-types.js";
import type { HierarchyNode } from "../rust-hier-viewer/src/html/frontend/types.js";

const context = {
  node: { id: 0, path: "dut.q0", module: "Queue", definitionFilePath: "rtl/queue.sv" } as HierarchyNode,
  view: { firstLineNumber: 1, bookmarkKey: null, focusStartLine: 1, focusEndLine: 1, lines: Array.from({ length: 20 }, (_, index) => `wire signal_${index + 1};`) },
  selection: {
    display: { name: "Report", summary: { release: "test", scopes: [{ path: "tb.dut.q0", metrics: { line: { covered: 4, total: 8, excluded: 1 } } }] }, mapping: { scopeByNode: new Int32Array([0]) } },
  } as unknown as CoverageSelection,
};

test("relocated source requires the same filename and matching measured and context lines", () => {
  const data = {
    instancePath: 'dut.q0', filePath: '/old/queue.sv', reportPath: 'mod0.html#Line',
    totals: { covered: 0, total: 1, excluded: 0 },
    lines: [{ line: 8, covered: 0, total: 1, sourceText: context.view.lines[7] }],
    sourceLines: [{ line: 7, sourceText: context.view.lines[6] }, { line: 8, sourceText: context.view.lines[7] }],
  };
  assert.equal(validateCoverageSource(data, '/new/queue.sv', context.view), true);
  assert.equal(validateCoverageSource(data, '/old/queue.sv', context.view), false);
  assert.throws(() => validateCoverageSource(data, '/new/other.sv', context.view), /Source file does not match/);
  const changedContext = { ...data, sourceLines: [{ line: 7, sourceText: 'changed enclosing condition' }, ...data.sourceLines.slice(1)] };
  assert.throws(() => validateCoverageSource(changedContext, '/new/queue.sv', context.view), /line 7/);
  assert.throws(() => validateCoverageSource({ ...data, sourceLines: [], lines: [] }, '/new/queue.sv', context.view), /no source text/);
  const sourceOutsideView = { ...data, sourceLines: [{ line: 1000, sourceText: 'wire other;' }] };
  assert.throws(() => validateCoverageSource(sourceOutsideView, '/new/queue.sv', context.view), /line 1000/);
});

test("coverage exports only selected rows with headers, literal expressions and merged source context", () => {
  const detail: CoverageMetricDetail = { metric: "condition", instancePath: "tb.dut.q0", filePath: "rtl/queue.sv", blocks: [
    { kind: "code", text: "LINE 8" },
    { kind: "code", text: "```\nEXPRESSION a | b\n<script>quoted</script>" },
    { kind: "table", title: "Missing combinations", rows: [
      { header: true, status: "neutral", cells: ["A", "B", "Status"] },
      { header: false, status: "uncovered", cells: ["0", "1", "Not Covered"] },
      { header: false, status: "covered", cells: ["unselected", "1", "Covered"] },
    ] },
  ] };
  const entries: CoverageExportEntry[] = [
    { kind: "detail", data: detail, block: 2, row: 1 },
    { kind: "line", row: { line: 10, covered: 0, total: 2, excluded: true, sourceText: context.view.lines[9] }, reportPath: "mod0.html#Line" },
  ];
  const output = formatCoverageExport(context, entries);
  assert.match(output, /"hierarchyInstance": "dut.q0"/);
  assert.match(output, /"coverageInstance": "tb.dut.q0"/);
  assert.match(output, /A\tB\tStatus/);
  assert.match(output, /"covered": 0,\n\s+"total": 2,\n\s+"excluded": true/);
  assert.match(output, /````text\n```\nEXPRESSION a \| b\n<script>quoted<\/script>\n````/);
  assert.ok(!output.includes("unselected"));
  assert.equal(output.split("8: wire signal_8;").length, 2, "Overlapping source ranges are merged");
  assert.match(output, /5: wire signal_5;/);
  assert.match(output, /13: wire signal_13;/);
  assert.ok(!output.includes("14: wire signal_14;"));
  assert.equal(formatCoverageExport(context, [...entries].reverse()), output, "Selection click order does not change output ordering");
  const foreign = formatCoverageExport(context, [{ kind: "detail", data: { ...detail, filePath: "rtl/foreign.sv" }, block: 2, row: 1 }]);
  assert.ok(!foreign.includes("wire signal_"), "A foreign report source must not be attributed to the selected RTL");
  const verified = formatCoverageExport({ ...context, verifiedReportSource: 'rtl/foreign.sv' }, [{ kind: 'detail', data: { ...detail, filePath: 'rtl/foreign.sv' }, block: 2, row: 1 }]);
  assert.match(verified, /8: wire signal_8;/);
  assert.match(verified, /"reportSourceFile": "rtl\/foreign.sv"/);
});
