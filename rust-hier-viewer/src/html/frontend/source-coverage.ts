import { createCoverageDetails } from "./coverage-details.js";
import type { CoverageLine, CoverageSelection } from "./coverage-types.js";
import type { HierarchyNode, ViewerState } from "./types.js";
import type { SourceView } from "./main-types.js";

interface SourceCoverageDependencies {
  state: ViewerState;
  getSelection(): CoverageSelection | null;
  getNode(id: number): HierarchyNode;
  getView(): SourceView | null;
  repaint(): void;
  jumpToLine(line: number): void;
  sourceCode: HTMLElement;
}

export function coverageLineState(row: CoverageLine): string {
  return row.excluded ? "excluded" : row.covered === 0 ? "uncovered" : row.covered === row.total ? "covered" : "partial";
}

export function createSourceCoverage(deps: SourceCoverageDependencies) {
  const metricDetails = createCoverageDetails(deps);
  const bar = document.getElementById("source-coverage-bar");
  const status = document.getElementById("source-coverage-status");
  const detail = document.getElementById("source-coverage-line-detail");
  const toggle = document.getElementById("source-coverage-toggle") as HTMLInputElement | null;
  const previous = document.getElementById("source-coverage-prev") as HTMLButtonElement | null;
  const next = document.getElementById("source-coverage-next") as HTMLButtonElement | null;
  const plain = document.getElementById("source-coverage-plain");
  const lineSelect = document.getElementById("source-coverage-line-select") as HTMLSelectElement | null;
  const pagePrevious = document.getElementById("source-coverage-page-prev") as HTMLButtonElement | null;
  const pageNext = document.getElementById("source-coverage-page-next") as HTMLButtonElement | null;
  const pageLabel = document.getElementById("source-coverage-page");
  const PAGE_SIZE = 200;
  let selection: CoverageSelection | null = null;
  let view: SourceView | null = null;
  let nodeId: number | null = null;
  let controller: AbortController | null = null;
  let generation = 0;
  let rows: CoverageLine[] = [];
  let byLine: Map<number, CoverageLine> | null = null;
  let missing: number[] = [];
  let selectedLine = 0;
  let page = 0;

  function enabled() { return !!byLine && (toggle?.checked ?? true); }
  function updateVisibility() {
    deps.sourceCode.classList.toggle("coverage-active", enabled());
    if (plain) plain.hidden = !enabled() || view?.renderMode !== "plain";
    if (previous) previous.disabled = !enabled() || !missing.length;
    if (next) next.disabled = !enabled() || !missing.length;
  }
  function renderPage() {
    if (!lineSelect || !plain || plain.hidden) return;
    const begin = page * PAGE_SIZE;
    lineSelect.replaceChildren(...rows.slice(begin, begin + PAGE_SIZE).map(row => new Option(
      `${row.line}: ${row.covered}/${row.total} ${coverageLineState(row)}`, String(row.line), false, row.line === selectedLine,
    )));
    if (pageLabel) pageLabel.textContent = `${rows.length ? begin + 1 : 0}–${Math.min(begin + PAGE_SIZE, rows.length)} / ${rows.length}`;
    if (pagePrevious) pagePrevious.disabled = page === 0;
    if (pageNext) pageNext.disabled = begin + PAGE_SIZE >= rows.length;
  }
  function showLine(line: number, scroll = true) {
    const row = byLine?.get(line);
    if (!row) return;
    selectedLine = line;
    if (detail) detail.textContent = `Line ${line}: ${row.covered}/${row.total} points, ${coverageLineState(row)}`;
    if (view?.renderMode === "plain") {
      const index = rows.findIndex(item => item.line === line);
      page = Math.floor(Math.max(0, index) / PAGE_SIZE);
      renderPage();
      if (lineSelect) lineSelect.value = String(line);
    }
    if (scroll) deps.jumpToLine(line);
  }
  function navigate(direction: -1 | 1) {
    if (!missing.length) return;
    let low = 0;
    let high = missing.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (missing[middle] <= selectedLine) low = middle + 1;
      else high = middle;
    }
    const index = direction > 0
      ? low % missing.length
      : (low - (missing[low - 1] === selectedLine ? 2 : 1) + missing.length) % missing.length;
    showLine(missing[index]);
  }
  function reset() {
    controller?.abort();
    controller = null;
    generation++;
    rows = [];
    byLine = null;
    missing = [];
    selectedLine = 0;
    page = 0;
    if (detail) detail.textContent = "";
    if (lineSelect) lineSelect.replaceChildren();
    updateVisibility();
  }
  function sync() {
    metricDetails.sync();
    const currentSelection = deps.getSelection();
    const currentView = deps.getView();
    const currentId = deps.state.sourceNodeId;
    if (selection === currentSelection && view === currentView && nodeId === currentId) return;
    reset();
    selection = currentSelection;
    view = currentView;
    nodeId = currentId;
    if (bar) bar.hidden = !selection || !view || currentId === null;
    if (!selection || !view || currentId === null) return;
    if (view.targetKind !== "definition") {
      if (status) status.textContent = "Line coverage is attached to the module definition.";
      return;
    }
    const scopeId = selection.display.mapping.scopeByNode[currentId];
    if (scopeId < 0) { if (status) status.textContent = "Instance is not mapped to coverage."; return; }
    const node = deps.getNode(currentId);
    const instancePath = selection.display.summary.scopes[scopeId].path;
    const expectedSelection = selection;
    const expectedView = view;
    const token = generation;
    const sourceToken = deps.state.sourceRequestToken;
    const abort = new AbortController();
    controller = abort;
    if (status) status.textContent = "Loading line coverage...";
    void expectedSelection.report.getLineCoverage(instancePath, node.module, abort.signal).then(data => {
      abort.signal.throwIfAborted();
      if (token !== generation || sourceToken !== deps.state.sourceRequestToken || deps.getSelection() !== expectedSelection || deps.getView() !== expectedView) return;
      if (!data) {
        if (status) status.textContent = "Line coverage details are unavailable.";
        return;
      }
      if (data.instancePath !== instancePath) throw new Error("Line coverage belongs to a different instance.");
      if (data.filePath.replace(/\\/g, "/") !== node.definitionFilePath?.replace(/\\/g, "/")) throw new Error("Source path does not match the coverage report.");
      for (const row of data.lines) {
        const index = row.line - expectedView.firstLineNumber;
        if (index < 0 || index >= (expectedView.lines?.length ?? 0) || expectedView.lines![index].trim() !== row.sourceText.trim()) {
          throw new Error(`Source text does not match the report at line ${row.line}; coverage overlay disabled.`);
        }
      }
      rows = [...data.lines].sort((left, right) => left.line - right.line);
      byLine = new Map(rows.map(row => [row.line, row]));
      missing = rows.filter(row => !row.excluded && row.covered < row.total).map(row => row.line);
      if (status) status.textContent = `${data.totals.covered}/${data.totals.total} points; ${missing.length} uncovered or partial lines; report text matched`;
      updateVisibility();
      renderPage();
      deps.repaint();
    }).catch(error => {
      if (abort.signal.aborted || token !== generation || sourceToken !== deps.state.sourceRequestToken) return;
      byLine = null;
      if (status) status.textContent = error instanceof Error ? error.message : String(error);
      updateVisibility();
      deps.repaint();
    });
  }
  function cell(line: number): string {
    if (!enabled()) return "";
    const row = byLine?.get(line);
    if (!row) return '<span class="coverage-line-cell coverage-unmeasured" title="No reported coverage point">--</span>';
    const state = coverageLineState(row);
    return `<button type="button" class="coverage-line-cell coverage-${state}" data-coverage-line="${line}" title="Line ${line}: ${row.covered}/${row.total} coverage points, ${state}">${row.covered}/${row.total}</button>`;
  }
  toggle?.addEventListener("change", () => { updateVisibility(); renderPage(); deps.repaint(); });
  previous?.addEventListener("click", () => navigate(-1));
  next?.addEventListener("click", () => navigate(1));
  lineSelect?.addEventListener("change", () => showLine(Number(lineSelect.value)));
  pagePrevious?.addEventListener("click", () => { page = Math.max(0, page - 1); renderPage(); });
  pageNext?.addEventListener("click", () => { page = Math.min(Math.ceil(rows.length / PAGE_SIZE) - 1, page + 1); renderPage(); });
  deps.sourceCode.addEventListener("click", event => {
    const button = (event.target as Element).closest<HTMLButtonElement>("[data-coverage-line]");
    if (button) showLine(Number(button.dataset.coverageLine), false);
  });
  return {
    sync, cell,
    lineClass(line: number) { const row = enabled() ? byLine?.get(line) : null; return row ? `coverage-${coverageLineState(row)}` : ""; },
    close() { metricDetails.close(); reset(); selection = null; view = null; nodeId = null; if (bar) bar.hidden = true; },
  };
}
