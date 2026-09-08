import { createCoverageTree } from "./coverage-tree.js";
import type { CoverageMetric } from "./coverage-types.js";
import type { HierarchyNode, ViewerState } from "./types.js";

interface Dependencies {
  state: ViewerState;
  nodes: HierarchyNode[];
  openSource(id: number): Promise<void>;
  closeSource(): void;
  hasSource(id: number): boolean;
  setSourceWorkspace(active: boolean): void;
  selectMetric(metric: CoverageMetric): void;
  resizeSource(): void;
  importReport(): void;
  removeReport(): void;
}

/** Dock the existing reader and controls. Their DOM identity and listeners survive
 * view changes; there is only one source request and one export selection owner.
 */
export function createCoverageWorkspace(deps: Dependencies) {
  const workspace = document.getElementById("coverage-workspace")!;
  const grid = document.getElementById("coverage-workspace-grid")!;
  const sourceHost = document.getElementById("coverage-source-host")!;
  const detailHost = document.getElementById("coverage-details-host")!;
  const sourcePanel = document.getElementById("source-panel")!;
  const sourceEmpty = document.getElementById("coverage-source-empty")!;
  const detailEmpty = document.getElementById("coverage-details-empty")!;
  const clearReport = document.getElementById("coverage-workspace-clear") as HTMLButtonElement;
  const reportLabel = document.getElementById("coverage-workspace-report")!;
  const instanceLabel = document.getElementById("coverage-workspace-instance")!;
  const lineList = document.getElementById("coverage-workspace-lines")!;
  const tabs = document.querySelector<HTMLElement>(".coverage-detail-tabs")!;
  const exportBar = document.querySelector<HTMLElement>(".coverage-export-toolbar")!;
  const detailView = document.getElementById("coverage-detail-view")!;
  const paneButtons = [...workspace.querySelectorAll<HTMLButtonElement>("[data-coverage-pane]")];
  const storageKey = `hier-viewer:coverage-layout:${location.pathname}`;
  const docked = [sourcePanel, tabs, detailView, exportBar].map(element => {
    const anchor = document.createComment("coverage dock position");
    element.before(anchor);
    return { element, anchor };
  });
  let active = false;
  let selectedId: number | null = null;
  let sourceAvailable = false;
  let leftWidth = 34;
  let rightWidth = 28;

  const tree = createCoverageTree({ nodes: deps.nodes, rootId: deps.state.homeRoot, onSelect: select });

  function showPane(pane: string) {
    workspace.dataset.pane = pane;
    for (const button of paneButtons) {
      button.setAttribute("aria-pressed", String(button.dataset.coveragePane === pane));
    }
    requestAnimationFrame(() => { tree.resize(); deps.resizeSource(); });
  }

  function select(id: number, metric?: CoverageMetric) {
    const changed = selectedId !== id || deps.state.sourceNodeId !== id;
    selectedId = id;
    sourceAvailable = deps.hasSource(id);
    instanceLabel.textContent = deps.nodes[id].name;
    instanceLabel.title = deps.nodes[id].path;
    sourceEmpty.hidden = sourceAvailable;
    detailEmpty.hidden = sourceAvailable && !!deps.state.coverage;
    if (!sourceAvailable) {
      deps.closeSource();
      sourceEmpty.querySelector("h2")!.textContent = "Source unavailable";
      sourceEmpty.querySelector("p")!.textContent = "This instance has no bundled module source.";
      detailEmpty.querySelector("h2")!.textContent = "Source unavailable";
      detailEmpty.querySelector("p")!.textContent = "Instance summary coverage remains available in the tree.";
    } else if (changed) {
      void deps.openSource(id);
      document.getElementById("source-title")!.title = deps.nodes[id].path;
      document.getElementById("source-subtitle")!.title = deps.nodes[id].definitionFilePath ?? "";
    }
    if (metric) deps.selectMetric(metric);
    tree.refresh(deps.state.coverage, selectedId);
    showPane(metric ? "details" : "source");
  }

  function resize() {
    grid.style.setProperty("--coverage-left", `${leftWidth}%`);
    grid.style.setProperty("--coverage-right", `${rightWidth}%`);
    tree.resize();
    deps.resizeSource();
  }

  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? "null");
    if (Number.isFinite(saved?.left) && Number.isFinite(saved?.right)) {
      leftWidth = Math.max(20, Math.min(44, saved.left));
      rightWidth = Math.max(20, Math.min(36, saved.right));
    }
  } catch { /* Storage is optional, including in private browsing. */ }

  function saveWidths() {
    try { localStorage.setItem(storageKey, JSON.stringify({ left: leftWidth, right: rightWidth })); }
    catch { /* The current layout remains usable without persistence. */ }
  }

  for (const [id, left] of [["coverage-split-left", true], ["coverage-split-right", false]] as const) {
    const splitter = document.getElementById(id)!;
    const adjust = (value: number) => {
      if (left) leftWidth = Math.max(20, Math.min(44, value));
      else rightWidth = Math.max(20, Math.min(36, value));
      splitter.setAttribute("aria-valuenow", String(Math.round(left ? leftWidth : rightWidth)));
      resize();
    };
    splitter.setAttribute("aria-valuemin", "20");
    splitter.setAttribute("aria-valuemax", left ? "44" : "36");
    splitter.setAttribute("aria-valuenow", String(left ? leftWidth : rightWidth));
    splitter.addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
      event.preventDefault();
      splitter.setPointerCapture(event.pointerId);
      grid.classList.add("resizing");
    });
    splitter.addEventListener("pointermove", event => {
      if (!splitter.hasPointerCapture(event.pointerId)) return;
      const rect = grid.getBoundingClientRect();
      const fraction = (event.clientX - rect.left) / rect.width * 100;
      adjust(left ? fraction : 100 - fraction);
    });
    splitter.addEventListener("lostpointercapture", () => { grid.classList.remove("resizing"); saveWidths(); });
    splitter.addEventListener("keydown", event => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const direction = event.key === "ArrowRight" ? 1 : -1;
      adjust(left ? leftWidth + direction * 2 : rightWidth - direction * 2);
      saveWidths();
    });
  }
  detailHost.addEventListener("click", event => {
    const link = (event.target as Element).closest<HTMLButtonElement>("[data-coverage-line], .coverage-line-jump");
    if (link && !link.disabled) showPane("source");
  });
  for (const button of paneButtons) button.addEventListener("click", () => showPane(button.dataset.coveragePane!));
  clearReport.addEventListener("click", deps.removeReport);
  document.getElementById("coverage-workspace-import")!.addEventListener("click", deps.importReport);
  const observer = new ResizeObserver(() => { if (active) { tree.resize(); deps.resizeSource(); } });
  observer.observe(grid);

  return {
    refresh() {
      if (!active) return;
      reportLabel.textContent = deps.state.coverage?.name ?? "No report loaded";
      clearReport.disabled = !deps.state.coverage;
      detailEmpty.hidden = sourceAvailable && !!deps.state.coverage;
      if (!deps.state.coverage) {
        detailEmpty.querySelector("h2")!.textContent = "No report loaded";
        detailEmpty.querySelector("p")!.textContent = "Import a coverage report to inspect this instance.";
      }
      reportLabel.title = reportLabel.textContent;
      tree.refresh(deps.state.coverage, selectedId);
    },
    setActive(next: boolean) {
      if (active === next) return;
      active = next;
      workspace.classList.toggle("active", next);
      document.querySelector(".app")?.classList.toggle("coverage-workspace-active", next);
      if (next) {
        sourceHost.append(sourcePanel);
        detailHost.insertBefore(tabs, lineList);
        detailHost.insertBefore(detailView, lineList);
        detailHost.append(exportBar);
        deps.setSourceWorkspace(true);
        reportLabel.textContent = deps.state.coverage?.name ?? "No report loaded";
        const initial = deps.state.sourceNodeId ?? selectedId;
        if (initial !== null) {
          select(initial);
          tree.reveal(initial);
        }
        tree.refresh(deps.state.coverage, selectedId);
        resize();
      } else {
        deps.closeSource();
        deps.setSourceWorkspace(false);
        for (const { element, anchor } of docked) anchor.after(element);
        lineList.hidden = true;
      }
    },
  };
}
