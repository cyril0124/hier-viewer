import type { CoverageCounts, CoverageDisplay, CoverageMetric, CoverageSelection } from "./coverage-types.js";
import { escapeHtml } from "./ui.js";

export const COVERAGE_COLORS = ["#c44949", "#d89425", "#7b9833", "#23866a"] as const;
const COVERAGE_RANGES = ["0–49%", "50–79%", "80–94%", "95–100%", "No data"] as const;

export function coverageBucket(counts: CoverageCounts | undefined): number {
  if (!counts || counts.total === 0) return 4;
  const ratio = counts.covered / counts.total;
  if (ratio < 0.5) return 0;
  if (ratio < 0.8) return 1;
  if (ratio < 0.95) return 2;
  return 3;
}

export function coverageFilterActive(display: CoverageDisplay | undefined): boolean {
  return !!display && display.metric !== "off" && !!display.filterMask;
}

export function coverageMatchesFilter(display: CoverageDisplay | undefined, nodeId: number): boolean {
  if (!display || !coverageFilterActive(display) || display.metric === "off") return true;
  const bucket = coverageBucket(coverageCounts(display, nodeId, display.metric));
  return !!(display.filterMask! & (1 << bucket));
}

export function coverageFilterControls(display: CoverageDisplay | undefined): string {
  const mask = display?.filterMask ?? 0;
  const buttons = COVERAGE_RANGES.map((label, bucket) => {
    const pressed = !!(mask & (1 << bucket));
    const color = bucket === 4 ? "#899198" : COVERAGE_COLORS[bucket];
    return `<button type="button" class="coverage-range-button" data-coverage-bucket="${bucket}" aria-pressed="${pressed}" title="Toggle ${label} coverage filter"><i style="background:${color}" aria-hidden="true"></i>${label}</button>`;
  });
  return buttons.join("") + `<button type="button" class="coverage-range-button" data-coverage-filter-clear title="Clear coverage range filter"${mask ? "" : " disabled"}>Show all</button>`;
}
export function coverageCounts(display: CoverageDisplay | undefined, nodeId: number, metric: CoverageMetric): CoverageCounts | undefined {
  if (!display) return undefined;
  const id = display.mapping.scopeByNode[nodeId];
  return id >= 0 ? display.summary.scopes[id]?.metrics[metric] : undefined;
}
export function coverageColor(display: CoverageDisplay | undefined, nodeId: number): string | null {
  if (!display || display.metric === "off") return null;
  const bucket = coverageBucket(coverageCounts(display, nodeId, display.metric));
  return bucket === 4 ? "#899198" : COVERAGE_COLORS[bucket];
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
