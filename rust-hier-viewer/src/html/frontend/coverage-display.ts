import type { CoverageCounts, CoverageDisplay, CoverageMetric, CoverageSelection } from "./coverage-types.js";
import { escapeHtml } from "./ui.js";

export const COVERAGE_COLORS = ["#c44949", "#d89425", "#7b9833", "#23866a"] as const;
export function coverageCounts(display: CoverageDisplay | undefined, nodeId: number, metric: CoverageMetric): CoverageCounts | undefined {
  if (!display) return undefined;
  const id = display.mapping.scopeByNode[nodeId];
  return id >= 0 ? display.summary.scopes[id]?.metrics[metric] : undefined;
}
export function coverageColor(display: CoverageDisplay | undefined, nodeId: number): string | null {
  if (!display || display.metric === "off") return null;
  const counts = coverageCounts(display, nodeId, display.metric);
  if (!counts || counts.total === 0) return "#899198";
  const ratio = counts.covered / counts.total;
  return COVERAGE_COLORS[ratio < 0.5 ? 0 : ratio < 0.8 ? 1 : ratio < 0.95 ? 2 : 3];
}
export function formatCoverage(counts: CoverageCounts | undefined): string {
  if (!counts) return "No data";
  return `${counts.total ? `${(counts.covered / counts.total * 100).toFixed(2)}%` : "N/A"} (${counts.covered}/${counts.total})`;
}
export function coverageDetailsHtml(display: CoverageDisplay | undefined, nodeId: number): string {
  if (!display) return "";
  const scopeId = display.mapping.scopeByNode[nodeId];
  if (scopeId < 0) return '<div class="coverage-detail-title">Coverage: unmatched instance</div>';
  const scope = display.summary.scopes[scopeId];
  const rows = (["line", "condition", "branch", "toggle", "assert"] as const).map(metric => {
    const counts = scope.metrics[metric];
    if (metric === "assert" && !counts) return "";
    const excluded = counts?.excluded ? `; excluded ${counts.excluded}` : "";
    return `<div class="coverage-detail-row"><span>${metric === "toggle" ? "Toggle (VDB scope)" : metric === "line" ? "Line" : metric === "condition" ? "Condition" : metric === "assert" ? "Assert (success/match)" : "Branch"}</span><span>${formatCoverage(counts)}${excluded}</span></div>`;
  });
  const link = display.reportUrl ? `<a href="${escapeHtml(display.reportUrl)}" target="_blank" rel="noopener noreferrer">Open URG Report</a>` : "";
  return `<div class="coverage-detail-title">Subtree coverage</div>${rows.join("")}<div class="coverage-detail-path">${escapeHtml(scope.path)}</div>${link}`;
}
export function disposeCoverage(selection: CoverageSelection | null) {
  selection?.report.clear();
  selection?.source.dispose?.();
}
