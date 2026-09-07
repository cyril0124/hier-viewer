import type { CoverageMetric, CoverageMetricDetail, CoverageSelection, CoverageDetailBlock } from "./coverage-types.js";
import type { HierarchyNode, ViewerState } from "./types.js";
import type { SourceView } from "./main-types.js";

interface Dependencies {
  state: ViewerState;
  getSelection(): CoverageSelection | null;
  getNode(id: number): HierarchyNode;
  getView(): SourceView | null;
  jumpToLine(line: number): void;
}

const LABELS = { condition: "Condition", branch: "Branch", toggle: "Toggle", assert: "Assert" } as const;
const PAGE_SIZE = 100;

export function createCoverageDetails(deps: Dependencies) {
  const panel = document.getElementById("source-panel");
  const container = document.getElementById("coverage-detail-view");
  const content = document.getElementById("coverage-detail-content");
  const title = document.getElementById("coverage-detail-title");
  const subtitle = document.getElementById("coverage-detail-subtitle");
  const status = document.getElementById("coverage-detail-status");
  const missingOnly = document.getElementById("coverage-detail-missing") as HTMLInputElement | null;
  const retry = document.getElementById("coverage-detail-retry") as HTMLButtonElement | null;
  const tabs = [...document.querySelectorAll<HTMLButtonElement>("[data-coverage-metric]")];
  let metric: CoverageMetric = "line";
  let selection: CoverageSelection | null = null;
  let nodeId: number | null = null;
  let view: SourceView | null = null;
  let request: AbortController | null = null;
  let generation = 0;
  let data: CoverageMetricDetail | null = null;

  function visible() {
    const scopeId = nodeId === null ? -1 : selection?.display.mapping.scopeByNode[nodeId] ?? -1;
    const hasAssertions = scopeId >= 0 && !!selection?.display.summary.scopes[scopeId].metrics.assert;
    const assertTab = tabs.find(tab => tab.dataset.coverageMetric === "assert");
    if (assertTab) assertTab.hidden = !hasAssertions;
    if (metric === "assert" && selection && view && nodeId !== null && !hasAssertions) metric = "line";
    const missingLabel = document.getElementById("coverage-detail-filter-label");
    if (missingLabel) missingLabel.textContent = metric === "assert" ? "Failures / no success" : "Uncovered only";
    const active = metric !== "line" && !!selection && !!view;
    panel?.classList.toggle("coverage-detail-mode", active);
    if (container) container.hidden = !active;
    for (const tab of tabs) {
      const selected = tab.dataset.coverageMetric === metric;
      tab.setAttribute("aria-selected", String(selected));
      tab.classList.toggle("active", selected);
      tab.tabIndex = selected ? 0 : -1;
    }
  }
  function jump(line: number) {
    metric = "line";
    request?.abort();
    visible();
    requestAnimationFrame(() => deps.jumpToLine(line));
  }
  function table(block: Extract<CoverageDetailBlock, { kind: "table" }>, summary: boolean): HTMLElement {
    const section = document.createElement("div");
    section.className = summary ? "coverage-summary-table" : "coverage-result-table";
    if (block.title) {
      const heading = document.createElement("h3");
      heading.className = "coverage-table-title";
      heading.textContent = block.title;
      section.appendChild(heading);
    }
    const headers = block.rows.filter(row => row.header);
    const allRows = block.rows.filter(row => !row.header);
    const filtered = !summary && missingOnly?.checked ? allRows.filter(row => row.status !== "covered") : allRows;
    const viewport = document.createElement("div");
    viewport.className = "coverage-table-scroll";
    const grid = document.createElement("table");
    const head = document.createElement("thead");
    const body = document.createElement("tbody");
    const makeRow = (row: typeof block.rows[number]) => {
      const tr = document.createElement("tr");
      tr.className = `coverage-result-${row.status}`;
      for (const text of row.cells) {
        const cell = document.createElement(row.header ? "th" : "td");
        cell.textContent = text;
        if (!row.header && /^(?:Not Covered|Covered|Yes|No|Failed|Incomplete|Succeeded|Matched|No success|No match)$/.test(text)) cell.className = `coverage-result-state ${/^(?:No|Not Covered|Failed|Incomplete|No success|No match)$/.test(text) ? "missing" : "hit"}`;
        tr.appendChild(cell);
      }
      return tr;
    };
    for (const row of headers) head.appendChild(makeRow(row));
    grid.append(head, body);
    viewport.appendChild(grid);
    section.appendChild(viewport);
    let page = 0;
    const controls = document.createElement("div");
    controls.className = "coverage-table-pagination";
    const count = document.createElement("span");
    const previous = document.createElement("button");
    const next = document.createElement("button");
    for (const [button, label, text] of [[previous, "Previous rows", "‹"], [next, "Next rows", "›"]] as const) {
      button.type = "button"; button.className = "icon-button"; button.title = label; button.setAttribute("aria-label", label); button.textContent = text;
    }
    const render = () => {
      const begin = page * PAGE_SIZE;
      body.replaceChildren(...filtered.slice(begin, begin + PAGE_SIZE).map(makeRow));
      count.textContent = `${filtered.length ? begin + 1 : 0}–${Math.min(begin + PAGE_SIZE, filtered.length)} / ${filtered.length}`;
      previous.disabled = page === 0;
      next.disabled = begin + PAGE_SIZE >= filtered.length;
    };
    previous.addEventListener("click", () => { page--; render(); });
    next.addEventListener("click", () => { page++; render(); });
    controls.append(count, previous, next);
    if (filtered.length > PAGE_SIZE) section.appendChild(controls);
    render();
    return section;
  }
  function render() {
    if (!content || !data) return;
    content.replaceChildren();
    const fragment = document.createDocumentFragment();
    let group: HTMLElement = document.createElement("section");
    group.className = "coverage-detail-section coverage-detail-summary";
    fragment.appendChild(group);
    let firstTable = true;
    for (const block of data.blocks) {
      if (block.kind === "code") {
        group = document.createElement("section");
        group.className = "coverage-detail-section";
        const line = /^\s*LINE\s+(\d+)/i.exec(block.text);
        const heading = document.createElement("div");
        heading.className = "coverage-expression-heading";
        if (line) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "coverage-line-jump";
          button.textContent = `Line ${line[1]}`;
          button.title = "View source line";
          button.addEventListener("click", () => jump(Number(line[1])));
          heading.appendChild(button);
        }
        const pre = document.createElement("pre");
        pre.className = "coverage-expression";
        pre.textContent = line ? block.text.replace(/^\s*LINE\s+\d+\s*\n/, "") : block.text;
        group.append(heading, pre);
        fragment.appendChild(group);
      } else {
        const summary = firstTable;
        firstTable = false;
        const hasMissing = block.rows.some(row => !row.header && row.status !== "covered");
        if (!summary && missingOnly?.checked && !hasMissing) continue;
        group.appendChild(table(block, summary));
      }
    }
    for (const section of fragment.querySelectorAll<HTMLElement>(".coverage-detail-section:not(.coverage-detail-summary)")) {
      if (missingOnly?.checked && !section.querySelector("table")) section.remove();
    }
    content.appendChild(fragment);
  }
  function load() {
    request?.abort();
    const token = ++generation;
    data = null;
    content?.replaceChildren();
    if (retry) retry.hidden = true;
    if (metric === "line" || !selection || !view || nodeId === null) return;
    const selectedMetric = metric;
    const selected = selection;
    const selectedView = view;
    const sourceToken = deps.state.sourceRequestToken;
    const id = nodeId;
    const node = deps.getNode(id);
    const scope = selected.display.mapping.scopeByNode[id];
    if (title) title.textContent = `${LABELS[selectedMetric]} Coverage`;
    if (subtitle) subtitle.textContent = scope >= 0 ? selected.display.summary.scopes[scope].path : node.path;
    if (scope < 0) { if (status) status.textContent = "Instance is not mapped to coverage."; return; }
    if (view.targetKind !== "definition") { if (status) status.textContent = "Open Module Source for this instance's coverage details."; return; }
    const instance = selected.display.summary.scopes[scope].path;
    const abort = new AbortController();
    request = abort;
    if (status) status.textContent = "Loading instance details...";
    const current = () => !abort.signal.aborted && generation === token && sourceToken === deps.state.sourceRequestToken
      && deps.getSelection() === selected && deps.getView() === selectedView;
    void selected.report.getMetricDetail(instance, node.module, selectedMetric, abort.signal).then(result => {
      if (!current()) return;
      if (!result) { if (status) status.textContent = "This report has no detail data for the selected metric and instance."; return; }
      if (result.instancePath !== instance || result.metric !== selectedMetric) throw new Error("Coverage detail instance does not match.");
      data = result;
      if (status) status.textContent = `Report source: ${result.filePath}`;
      render();
    }).catch(error => {
      if (!current()) return;
      if (status) status.textContent = error instanceof Error ? error.message : String(error);
      if (retry) retry.hidden = false;
    });
  }
  for (const tab of tabs) {
    tab.addEventListener("click", () => {
      metric = tab.dataset.coverageMetric as CoverageMetric;
      visible();
      load();
    });
    tab.addEventListener("keydown", event => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const available = tabs.filter(button => !button.hidden);
      const index = available.indexOf(tab);
      const next = available[(index + (event.key === "ArrowRight" ? 1 : -1) + available.length) % available.length];
      next.click(); next.focus();
    });
  }
  missingOnly?.addEventListener("change", render);
  retry?.addEventListener("click", load);
  return {
    sync() {
      const selected = deps.getSelection();
      const currentView = deps.getView();
      const id = deps.state.sourceNodeId;
      if (selected === selection && currentView === view && id === nodeId) return;
      selection = selected; view = currentView; nodeId = id;
      visible(); load();
    },
    close() { request?.abort(); generation++; data = null; selection = null; view = null; nodeId = null; content?.replaceChildren(); visible(); },
  };
}
