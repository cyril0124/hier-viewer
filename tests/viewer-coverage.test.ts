import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { coverageColor, coverageDetailsHtml } from "../rust-hier-viewer/src/html/frontend/coverage-display.js";
import { CoverageReport } from "../rust-hier-viewer/src/html/frontend/coverage-report.js";
import { inferCoverageRoot, mapCoverage } from "../rust-hier-viewer/src/html/frontend/coverage.js";
import type {
  CoverageFileSource,
  CoverageHierarchy,
  CoverageScope,
  CoverageSummary,
} from "../rust-hier-viewer/src/html/frontend/coverage-types.js";

const fixtureDirectory = fileURLToPath(new URL("fixtures/coverage/", import.meta.url));
const fixtureFiles = readdirSync(fixtureDirectory).sort();

function fixtureText(path: string): string {
  return readFileSync(`${fixtureDirectory}/${path}`, "utf8");
}

function fixtureSource(onRead?: (path: string, signal?: AbortSignal) => void): CoverageFileSource {
  return {
    id: "synthetic",
    name: "Synthetic URG",
    files: fixtureFiles,
    async readText(path, signal) {
      onRead?.(path, signal);
      signal?.throwIfAborted();
      return fixtureText(path);
    },
  };
}

function summary(scopes: CoverageScope[], roots: number[]): CoverageSummary {
  return {
    release: "test",
    scopes,
    roots,
    byPath: new Map(scopes.map((scope, id) => [scope.path, id])),
  };
}

function scope(name: string, path: string, parent: number | null, children: number[] = []): CoverageScope {
  return { name, path, parent, children, metrics: {} };
}

function node(id: number, name: string, parent: number | null, children: number[] = []) {
  return { id, name, module: `M${id}`, parent, children };
}

test("infers the unique complete subtree regardless of root name or sibling order", () => {
  const nodes = [node(0, "Top", null, [1, 2]), node(1, "left", 0), node(2, "right", 0)];
  const coverage = summary([
    scope("tb", "tb", null, [1, 4]),
    scope("u_dut", "tb.u_dut", 0, [3, 2]),
    scope("left", "tb.u_dut.left", 1),
    scope("right", "tb.u_dut.right", 1),
    scope("other", "tb.other", 0, [5, 6]),
    scope("left", "tb.other.left", 4),
    scope("extra", "tb.other.extra", 4),
  ], [0]);
  assert.equal(inferCoverageRoot(coverage, nodes, 0), 1);
  const mapped = mapCoverage(coverage, 1, nodes, 0);
  assert.equal(mapped.matched, 3);
  assert.deepEqual(mapped.unmatchedScopes, []);
});

test("automatic roots reject ambiguous leaves and non-matching descendant names", () => {
  const coverage = summary([scope("a", "tb.a", null), scope("b", "tb.b", null)], [0, 1]);
  assert.throws(() => inferCoverageRoot(coverage, [node(0, "Top", null)], 0), /Multiple coverage roots match.*tb.a, tb.b.*--coverage-root/);
  const nodes = [node(0, "Top", null, [1]), node(1, "missing", 0)];
  assert.throws(() => inferCoverageRoot(coverage, nodes, 0), /No coverage root matches.*not exact matches.*tb.a, tb.b/);
});

test("automatic root search handles deep trees and reports bounded diagnostics for all matches", () => {
  const length = 10000;
  const nodes = Array.from({ length }, (_, id) => node(id, "stage", id ? id - 1 : null, id + 1 < length ? [id + 1] : []));
  const scopes = Array.from({ length: length + 1 }, (_, id) => scope(id === 1 ? "u_dut" : "stage", `scope-${id}`, id ? id - 1 : null, id < length ? [id + 1] : []));
  assert.equal(inferCoverageRoot(summary(scopes, [0]), nodes, 0), 1);

  const leaves = Array.from({ length: 5000 }, (_, id) => scope(`u${id}`, `tb.u${id}`, null));
  assert.throws(() => inferCoverageRoot(summary(leaves, leaves.map((_, id) => id)), [node(0, "Top", null)], 0), /Multiple coverage roots match \(5000\).*showing 20 of 5000/);
});

test("rebases selected roots and reports unmatched nodes and scopes", () => {
  const coverage = summary([
    scope("coverage-top", "coverage-top", null, [1]),
    scope("selected", "coverage-top.selected", 0, [2, 3]),
    scope("same", "coverage-top.selected.same", 1),
    scope("coverage-only", "coverage-top.selected.coverage-only", 1),
  ], [0]);
  const nodes: CoverageHierarchy = [
    node(0, "viewer-top", null, [1]),
    node(1, "target", 0, [2, 3]),
    node(2, "same", 1),
    node(3, "viewer-only", 1),
  ];
  const mapping = mapCoverage(coverage, 1, nodes, 1);
  assert.equal(mapping.matched, 2);
  assert.deepEqual([...mapping.scopeByNode], [-1, 1, 2, -1]);
  assert.deepEqual(mapping.unmatchedScopes, ["coverage-top.selected.coverage-only"]);
  assert.deepEqual(mapping.unmatchedNodeIds, [3]);
});

test("maps a 30,000-scope chain iteratively", () => {
  const length = 30_000;
  const scopes = Array.from({ length }, (_, id) =>
    scope(`n${id}`, `p${id}`, id === 0 ? null : id - 1, id + 1 < length ? [id + 1] : []));
  const nodes: CoverageHierarchy = Array.from({ length }, (_, id) =>
    node(id, id === 0 ? "different-root" : `n${id}`, id === 0 ? null : id - 1, id + 1 < length ? [id + 1] : []));
  const mapping = mapCoverage(summary(scopes, [0]), 0, nodes, 0);
  assert.equal(mapping.matched, length);
  assert.equal(mapping.scopeByNode[length - 1], length - 1);
});

test("maps a 100,000-child frontier by exact name", () => {
  const width = 100_000;
  const rootChildren = Array.from({ length: width }, (_, index) => index + 1);
  const scopes = [scope("coverage-root", "coverage-root", null, rootChildren)];
  const nodes: Array<ReturnType<typeof node>> = [node(0, "viewer-root", null, rootChildren)];
  for (let id = 1; id <= width; id += 1) {
    scopes.push(scope(`child_${id}`, `coverage-root.child_${id}`, 0));
    nodes.push(node(id, `child_${id}`, 0));
  }
  const mapping = mapCoverage(summary(scopes, [0]), 0, nodes, 0);
  assert.equal(mapping.matched, width + 1);
  assert.equal(mapping.unmatchedNodeIds.length, 0);
});

test("rejects ambiguous duplicate child names", () => {
  const coverage = summary([scope("root", "root", null)], [0]);
  const nodes: CoverageHierarchy = [node(0, "root", null, [1, 2]), node(1, "same", 0), node(2, "same", 0)];
  assert.throws(() => mapCoverage(coverage, 0, nodes, 0), /duplicate hierarchy child/);
});

test("condition scores drive heatmap colors and instance details independently", () => {
  const root = scope("root", "root", null);
  root.metrics = { line: { covered: 10, total: 10, excluded: 0 }, condition: { covered: 3, total: 4, excluded: 1 } };
  const data = summary([root], [0]);
  const mapping = mapCoverage(data, 0, [node(0, "root", null)], 0);
  const display = { summary: data, mapping, metric: "condition" as const, name: "report" };
  assert.equal(coverageColor(display, 0), "#d89425");
  assert.match(coverageDetailsHtml(display, 0), /Condition<\/span><span>75\.00% \(3\/4\); excluded 1/);
  delete root.metrics.condition;
  assert.equal(coverageColor(display, 0), "#899198");
  assert.match(coverageDetailsHtml(display, 0), /Condition<\/span><span>No data/);
});

describe("CoverageReport", () => {
  test("assertion details retain counters and distinguish failures from no success", async () => {
    const report = new CoverageReport(fixtureSource());
    const detail = await report.getMetricDetail("top.check", "AssertUnit", "assert");
    assert.equal(detail?.metric, "assert");
    const table = detail?.blocks[1];
    assert.equal(table?.kind, "table");
    if (table?.kind !== "table") throw new Error("missing assertion table");
    assert.equal(table.title, "Assertion Details");
    assert.deepEqual(table.rows.slice(1).map(row => [row.cells[0], row.cells.at(-1), row.status]), [
      ["pass", "Succeeded", "covered"], ["fail", "Failed", "failed"], ["no_success", "No success", "uncovered"],
    ]);
    assert.deepEqual(table.rows[2].cells.slice(1, 5), ["9", "2", "1", "0"]);
    const properties = detail.blocks[2];
    assert.equal(properties.kind, "table");
    if (properties.kind === "table") assert.deepEqual(properties.rows.slice(1).map(row => row.cells.at(-1)), ["Matched", "No match"]);
    assert.equal(await report.getMetricDetail("top.one", "Single", "assert"), null);
  });
  test("extracts each metric from the exact instance without requiring Line data", async () => {
    for (const [metric, label] of [["condition", "Cond"], ["branch", "Branch"], ["toggle", "Toggle"]] as const) {
      const source = fixtureSource();
      const originalRead = source.readText;
      source.readText = async (path, signal) => {
        let text = await originalRead(path, signal);
        if (path !== "mod2.html") return text;
        text = text.replace('<a href="#inst_tag_b_Line">50</a>', `<a href="#inst_tag_b_${label}">50</a>`);
        text = text.replace('<a name="inst_tag_b_Branch"></a>', '');
        return text.replace('</body>', `<a name="inst_tag_b_${label}"></a><b>${label} Coverage for Instance : <a>top.b</a></b><table><tr><th>Status</th></tr><tr><td>Not Covered</td></tr></table><pre>EXPRESSION a &amp; b</pre><table><tr><th>A</th><th>B</th><th>Status</th></tr><tr class="uRed"><td>0</td><td>1</td><td>Not Covered</td></tr></table><a name="inst_tag_other_Toggle"></a><pre>wrong instance</pre></body>`);
      };
      const report = new CoverageReport(source);
      const result = await report.getMetricDetail("top.b", "Multi", metric);
      assert.equal(result?.instancePath, "top.b");
      assert.equal(result?.metric, metric);
      assert.deepEqual(result?.blocks[1], { kind: "code", text: "EXPRESSION a & b" });
      assert.equal(result?.blocks.length, 3);
      assert.equal(await report.getMetricDetail("top.a", "Multi", metric), null);
      assert.ok(!JSON.stringify(result).includes("wrong instance"));
    }
  });
  test("indexes paginated module lists and reuses single-instance results", async () => {
    const reads: string[] = [];
    const report = new CoverageReport(fixtureSource((path) => reads.push(path)));
    const first = await report.getLineCoverage("top.one", "Single");
    const readCount = reads.length;
    const second = await report.getLineCoverage("top.one", "Single");
    assert.deepEqual(second, first);
    assert.equal(reads.length, readCount);
    assert.equal(first?.filePath, "rtl/single.sv");
    assert.equal(first?.reportPath, "mod1.html#Line");
    assert.deepEqual(first?.totals, { covered: 1, total: 2, excluded: 0 });
    assert.deepEqual(first?.lines.map((line) => [line.line, line.covered, line.total, line.sourceText]), [
      [10, 1, 1, "  if (a < b) begin"],
      [11, 0, 1, "    y <= a & b;"],
    ]);
    assert.equal("coverageParserExecuted" in globalThis, false);
  });

  test("returns different masks for distinct instances without module aggregates", async () => {
    const report = new CoverageReport(fixtureSource());
    const first = await report.getLineCoverage("top.a", "Multi");
    const second = await report.getLineCoverage("top.b", "Multi");
    assert.deepEqual(first?.lines.map((line) => line.covered), [1, 1]);
    assert.deepEqual(second?.lines.map((line) => line.covered), [1, 0]);
    assert.equal(await report.getLineCoverage("top.missing", "Multi"), null);
  });

  test("follows an instance Line link into a split module page", async () => {
    const report = new CoverageReport(fixtureSource());
    const data = await report.getLineCoverage("top.paged", "Paged");
    assert.equal(data?.reportPath, "mod3_0.html#inst_tag_p_Line");
    assert.deepEqual(data?.lines.map((line) => line.line), [30]);
  });

  test("aggregates repeated physical-line coverage points", async () => {
    const report = new CoverageReport(fixtureSource());
    const data = await report.getLineCoverage("top.g", "Aggregate");
    assert.deepEqual(data?.lines, [{ line: 50, covered: 1, total: 2, sourceText: "  both_points();" }]);
  });

  test("rejects ambiguous source attribution and incomplete detail totals", async () => {
    const report = new CoverageReport(fixtureSource());
    await assert.rejects(report.getLineCoverage("top.x", "AmbiguousFile"), /ambiguous Source File/);
    await assert.rejects(report.getLineCoverage("top.i", "Incomplete"), /does not match TOTAL/);
  });

  test("an aborted detail read does not poison a later request", async () => {
    let abortFirstDetail = true;
    const controller = new AbortController();
    const report = new CoverageReport(fixtureSource((path) => {
      if (path === "mod3_0.html" && abortFirstDetail) {
        abortFirstDetail = false;
        controller.abort();
      }
    }));
    await assert.rejects(report.getLineCoverage("top.paged", "Paged", controller.signal), /abort/i);
    const recovered = await report.getLineCoverage("top.paged", "Paged", new AbortController().signal);
    assert.equal(recovered?.totals.covered, 1);
  });

  test("clear releases indexes and parsed-result caches", async () => {
    let reads = 0;
    const report = new CoverageReport(fixtureSource(() => { reads += 1; }));
    await report.getLineCoverage("top.one", "Single");
    const beforeClear = reads;
    report.clear();
    await report.getLineCoverage("top.one", "Single");
    assert.ok(reads > beforeClear);
  });

  test("returns null for an XML-only source", async () => {
    const report = new CoverageReport({
      id: "xml",
      name: "XML only",
      files: ["session.xml"],
      async readText() { return fixtureText("session.xml"); },
    });
    assert.equal(await report.getLineCoverage("chip", "Chip"), null);
  });

  for (const href of [
    "../mod1.html",
    "..%2Fmod1.html",
    "/mod1.html",
    "https://example.test/mod1.html",
    "mod1.html?view=full",
    "missing/mod1.html",
  ]) {
    test(`rejects unsafe or missing module link ${href}`, async () => {
      const files = ["modlist.html", ...(href === "missing/mod1.html" ? [] : ["mod1.html"])];
      const report = new CoverageReport({
        id: href,
        name: href,
        files,
        async readText(path) {
          if (path === "modlist.html") return `<a href="${href}">Unsafe</a>`;
          return fixtureText("mod1.html");
        },
      });
      await assert.rejects(report.getLineCoverage("top.one", "Unsafe"), /unsafe|missing/);
    });
  }

  test("rejects unrecognized exclusion syntax instead of treating it as zero", async () => {
    const files = ["modlist.html", "mod7.html"];
    const report = new CoverageReport({
      id: "excluded",
      name: "Excluded",
      files,
      async readText(path) {
        if (path === "modlist.html") return '<a href="mod7.html">Excluded</a>';
        return fixtureText("mod6.html")
          .replaceAll("mod6", "mod7")
          .replace("1/1              both_points();", "EXCLUDED           both_points();");
      },
    });
    await assert.rejects(report.getLineCoverage("top.g", "Excluded"), /unsupported Line coverage row/);
  });
});
