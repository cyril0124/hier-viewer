import { COVERAGE_COLORS, coverageBucket, coverageCounts, formatCoverage } from "./coverage-display.js";
import type { CoverageDisplay, CoverageMetric } from "./coverage-types.js";
import type { HierarchyNode } from "./types.js";

export const COVERAGE_TREE_ROW_HEIGHT = 36;
const OVERSCAN_ROWS = 8;
const BASE_METRICS: readonly CoverageMetric[] = ["line", "toggle", "condition", "branch"];
const METRIC_LABELS: Record<CoverageMetric, string> = {
  line: "Line", toggle: "Toggle", condition: "Condition", branch: "Branch", assert: "Assert",
};

type TreeNode = Pick<HierarchyNode, "id" | "name" | "module" | "path" | "children">;
interface TreeEntry {
  node: TreeNode;
  depth: number;
  parentIndex: number;
  subtreeEnd: number;
  searchText: string;
}
export interface CoverageTreeRow {
  node: TreeNode;
  depth: number;
  expanded: boolean;
  ancestorMatch: boolean;
}

/** Cached preorder tree. Only expansion and search rebuild the visible rows. */
export class CoverageTreeModel {
  readonly entries: TreeEntry[] = [];
  readonly entryById = new Map<number, number>();
  readonly expandedIds: Set<number>;
  rows: CoverageTreeRow[] = [];
  readonly visibleIndexById = new Map<number, number>();
  matchCount = 0;
  query = "";
  private readonly searchCollapsedIds = new Set<number>();

  constructor(nodes: readonly TreeNode[], rootId: number) {
    this.expandedIds = new Set([rootId]);
    const byId = new Map(nodes.map(node => [node.id, node]));
    const pending = [{ id: rootId, depth: 0, parentIndex: -1 }];
    while (pending.length) {
      const item = pending.pop()!;
      const node = byId.get(item.id);
      if (!node || this.entryById.has(node.id)) continue;
      const index = this.entries.length;
      this.entryById.set(node.id, index);
      this.entries.push({
        node, depth: item.depth, parentIndex: item.parentIndex, subtreeEnd: index + 1,
        searchText: `${node.name}\n${node.module}\n${node.path}`.toLowerCase(),
      });
      for (let child = node.children.length - 1; child >= 0; child -= 1) {
        pending.push({ id: node.children[child], depth: item.depth + 1, parentIndex: index });
      }
    }
    // Subtree boundaries let flattening skip collapsed descendants in one step.
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const entry = this.entries[index];
      if (entry.parentIndex >= 0) {
        const parent = this.entries[entry.parentIndex];
        parent.subtreeEnd = Math.max(parent.subtreeEnd, entry.subtreeEnd);
      }
    }
    this.rebuild();
  }

  setSearch(search: string): boolean {
    const query = search.trim().toLowerCase();
    if (query === this.query) return false;
    this.query = query;
    this.searchCollapsedIds.clear();
    this.rebuild();
    return true;
  }

  setExpanded(nodeId: number, expanded: boolean): void {
    const index = this.entryById.get(nodeId);
    if (index === undefined || !this.entries[index].node.children.length) return;
    if (this.query) {
      if (expanded) this.searchCollapsedIds.delete(nodeId);
      else this.searchCollapsedIds.add(nodeId);
    } else {
      if (expanded) this.expandedIds.add(nodeId);
      else this.expandedIds.delete(nodeId);
    }
    this.rebuild();
  }

  parentId(nodeId: number): number | undefined {
    const index = this.entryById.get(nodeId);
    if (index === undefined) return undefined;
    return this.entries[this.entries[index].parentIndex]?.node.id;
  }

  /** Reveal clears a search that hides the target, then opens its ancestor path. */
  reveal(nodeId: number): boolean {
    const targetIndex = this.entryById.get(nodeId);
    if (targetIndex === undefined) return false;
    if (this.visibleIndexById.has(nodeId)) return true;
    this.query = "";
    this.searchCollapsedIds.clear();
    let index: number = this.entries[targetIndex].parentIndex;
    while (index >= 0) {
      const entry = this.entries[index];
      this.expandedIds.add(entry.node.id);
      index = entry.parentIndex;
    }
    this.rebuild();
    return true;
  }

  private rebuild(): void {
    const included = new Uint8Array(this.entries.length);
    const matches = new Uint8Array(this.entries.length);
    this.matchCount = 0;
    if (this.query) {
      for (let index = 0; index < this.entries.length; index += 1) {
        if (!this.entries[index].searchText.includes(this.query)) continue;
        matches[index] = 1;
        included[index] = 1;
        this.matchCount += 1;
      }
      // Every descendant precedes its parent in this reverse pass: O(n), even for chains.
      for (let index = this.entries.length - 1; index >= 0; index -= 1) {
        const parent = this.entries[index].parentIndex;
        if (included[index] && parent >= 0) included[parent] = 1;
      }
    }
    this.rows = [];
    this.visibleIndexById.clear();
    for (let index = 0; index < this.entries.length;) {
      const entry = this.entries[index];
      if (this.query && !included[index]) {
        index = entry.subtreeEnd;
        continue;
      }
      const expanded = entry.node.children.length > 0 && (this.query
        ? !this.searchCollapsedIds.has(entry.node.id)
        : this.expandedIds.has(entry.node.id));
      this.visibleIndexById.set(entry.node.id, this.rows.length);
      this.rows.push({ node: entry.node, depth: entry.depth, expanded, ancestorMatch: !!this.query && !matches[index] });
      index = expanded ? index + 1 : entry.subtreeEnd;
    }
  }
}

/** End is exclusive; at most ceil(viewport / 36) + 17 rows are mounted. */
export function coverageTreeWindow(total: number, scrollTop: number, viewportHeight: number) {
  const height = Math.max(0, viewportHeight);
  const top = Math.max(0, Math.min(scrollTop, total * COVERAGE_TREE_ROW_HEIGHT - height));
  return {
    start: Math.max(0, Math.floor(top / COVERAGE_TREE_ROW_HEIGHT) - OVERSCAN_ROWS),
    end: Math.min(total, Math.ceil((top + height) / COVERAGE_TREE_ROW_HEIGHT) + OVERSCAN_ROWS),
  };
}

export function coverageTreeMetrics(display: CoverageDisplay | undefined): readonly CoverageMetric[] {
  if (display?.summary.scopes.some(scope => scope.metrics.assert !== undefined)) return [...BASE_METRICS, "assert"];
  return BASE_METRICS;
}

/** Uses the mapped instance's summary verbatim, including missing and zero-total data. */
export function coverageTreeMetric(display: CoverageDisplay | undefined, nodeId: number, metric: CoverageMetric) {
  const counts = coverageCounts(display, nodeId, metric);
  let text = "No data";
  let ratio: number | null = null;
  if (counts) {
    text = "N/A";
    if (counts.total > 0) {
      ratio = counts.covered / counts.total;
      text = `${(ratio * 100).toFixed(1)}%`;
    }
  }
  const bucket = coverageBucket(counts);
  return {
    text, ratio,
    title: `${METRIC_LABELS[metric]}: ${formatCoverage(counts)}${counts?.excluded ? `; excluded ${counts.excluded}` : ""}`,
    color: bucket === 4 ? "#899198" : COVERAGE_COLORS[bucket],
  };
}

interface CoverageTreeOptions {
  nodes: readonly HierarchyNode[];
  rootId: number;
  onSelect: (nodeId: number, metric?: CoverageMetric) => void;
}

/** Mount once after the five coverage-tree DOM elements exist. No report reads occur here. */
export function createCoverageTree({ nodes, rootId, onSelect }: CoverageTreeOptions) {
  function element<T extends HTMLElement>(id: string): T {
    const found = document.getElementById(id);
    if (!found) throw new Error(`Missing coverage tree element: ${id}`);
    return found as T;
  }
  const viewport = element<HTMLDivElement>("coverage-tree-scroll");
  const content = element<HTMLDivElement>("coverage-tree-rows");
  const header = element<HTMLDivElement>("coverage-tree-header");
  const search = element<HTMLInputElement>("coverage-tree-search");
  const count = element<HTMLElement>("coverage-tree-count");
  const model = new CoverageTreeModel(nodes, rootId);
  let display: CoverageDisplay | undefined;
  let selectedId: number | null = null;
  let focusedId = rootId;
  let metrics = coverageTreeMetrics(display);
  let frame: number | null = null;
  let renderedStart = -1;
  let renderedEnd = -1;
  let revision = 0;
  let renderedRevision = -1;

  viewport.tabIndex = 0;
  viewport.setAttribute("role", "tree");
  viewport.setAttribute("aria-label", "Coverage instances");
  content.style.position = "relative";

  function viewportHeight(): number {
    const headerHeight = viewport.contains(header) ? header.offsetHeight : 0;
    return Math.max(0, viewport.clientHeight - headerHeight);
  }

  function renderHeader(): void {
    header.replaceChildren();
    const name = document.createElement("span");
    name.textContent = "Instance";
    header.append(name);
    for (const metric of metrics) {
      const cell = document.createElement("span");
      cell.dataset.treeMetric = metric;
      cell.textContent = METRIC_LABELS[metric];
      header.append(cell);
    }
  }

  function updateSelectedRows(): void {
    for (const row of content.querySelectorAll<HTMLElement>("[data-coverage-node]")) {
      const isSelected = Number(row.dataset.coverageNode) === selectedId;
      row.classList.toggle("selected", isSelected);
      row.setAttribute("aria-selected", String(isSelected));
    }
  }

  function render(force = false): void {
    const window = coverageTreeWindow(model.rows.length, viewport.scrollTop, viewportHeight());
    if (!force && renderedStart === window.start && renderedEnd === window.end && renderedRevision === revision) return;
    renderedStart = window.start;
    renderedEnd = window.end;
    renderedRevision = revision;
    const fragment = document.createDocumentFragment();
    for (let index = window.start; index < window.end; index += 1) {
      const item = model.rows[index];
      const row = document.createElement("div");
      row.className = "coverage-tree-row";
      row.classList.toggle("ancestor-match", item.ancestorMatch);
      row.dataset.coverageNode = String(item.node.id);
      row.id = `coverage-tree-node-${item.node.id}`;
      row.setAttribute("role", "treeitem");
      row.setAttribute("aria-level", String(item.depth + 1));
      if (item.node.children.length) row.setAttribute("aria-expanded", String(item.expanded));
      row.style.cssText = `position:absolute;top:${index * COVERAGE_TREE_ROW_HEIGHT}px;height:36px;left:0;right:0`;
      row.style.boxSizing = "border-box";
      row.style.setProperty("--tree-depth", String(item.depth));

      const name = document.createElement("div");
      name.className = "coverage-tree-name";
      name.title = `${item.node.path}\nInstance: ${item.node.name}\nModule: ${item.node.module}`;
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "coverage-tree-toggle";
      toggle.dataset.treeToggle = String(item.node.id);
      toggle.tabIndex = -1;
      toggle.disabled = !item.node.children.length;
      toggle.textContent = item.node.children.length ? (item.expanded ? "▾" : "▸") : "";
      toggle.setAttribute("aria-label", `${item.expanded ? "Collapse" : "Expand"} ${item.node.name}`);
      const label = document.createElement("span");
      label.className = "coverage-tree-label";
      label.textContent = item.node.name;
      name.append(toggle, label);
      row.append(name);

      for (const metric of metrics) {
        const value = coverageTreeMetric(display, item.node.id, metric);
        const button = document.createElement("button");
        button.type = "button";
        button.className = "coverage-tree-metric";
        button.dataset.treeMetric = metric;
        button.tabIndex = -1;
        button.title = value.title;
        button.setAttribute("aria-label", `${item.node.name}, ${value.title}`);
        const meter = document.createElement("span");
        meter.className = "coverage-tree-meter";
        meter.setAttribute("aria-hidden", "true");
        const fill = document.createElement("span");
        fill.style.width = `${Math.max(0, Math.min(1, value.ratio ?? 0)) * 100}%`;
        fill.style.backgroundColor = value.color;
        meter.append(fill);
        const text = document.createElement("span");
        text.className = "coverage-tree-value";
        text.textContent = value.text;
        button.append(text, meter);
        row.append(button);
      }
      fragment.append(row);
    }
    // Retain keyboard focus on the stable viewport when virtualized buttons disappear.
    if (content.contains(document.activeElement)) viewport.focus({ preventScroll: true });
    content.replaceChildren(fragment);
    updateSelectedRows();
    updateActiveDescendant();
  }

  function updateActiveDescendant(): void {
    for (const row of content.querySelectorAll<HTMLElement>("[data-coverage-node]")) {
      row.classList.toggle("focused", Number(row.dataset.coverageNode) === focusedId);
    }
    const index = model.visibleIndexById.get(focusedId);
    if (index !== undefined && index >= renderedStart && index < renderedEnd) {
      viewport.setAttribute("aria-activedescendant", `coverage-tree-node-${focusedId}`);
    } else viewport.removeAttribute("aria-activedescendant");
  }

  function changed(): void {
    revision += 1;
    content.style.height = `${model.rows.length * COVERAGE_TREE_ROW_HEIGHT}px`;
    count.textContent = model.query
      ? `${model.matchCount} matches · ${model.rows.length} shown`
      : `${model.rows.length} / ${model.entries.length} instances`;
    renderHeader();
    const maxScroll = Math.max(0, model.rows.length * COVERAGE_TREE_ROW_HEIGHT - viewportHeight());
    viewport.scrollTop = Math.min(viewport.scrollTop, maxScroll);
    render();
  }

  function scrollToNode(nodeId: number): void {
    const index = model.visibleIndexById.get(nodeId);
    if (index === undefined) return;
    const top = index * COVERAGE_TREE_ROW_HEIGHT;
    if (top < viewport.scrollTop) viewport.scrollTop = top;
    else if (top + COVERAGE_TREE_ROW_HEIGHT > viewport.scrollTop + viewportHeight()) {
      viewport.scrollTop = Math.max(0, top + COVERAGE_TREE_ROW_HEIGHT - viewportHeight());
    }
    render();
    updateActiveDescendant();
  }

  function select(nodeId: number, metric?: CoverageMetric): void {
    selectedId = nodeId;
    focusedId = nodeId;
    updateSelectedRows();
    updateActiveDescendant();
    onSelect(nodeId, metric);
  }

  viewport.addEventListener("scroll", () => {
    if (frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      render();
    });
  }, { passive: true });

  search.addEventListener("input", () => {
    if (!model.setSearch(search.value)) return;
    viewport.scrollTop = 0;
    if (!model.visibleIndexById.has(focusedId)) focusedId = model.rows[0]?.node.id ?? rootId;
    changed();
  });

  content.addEventListener("click", event => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const row = target.closest<HTMLElement>("[data-coverage-node]");
    if (!row) return;
    const nodeId = Number(row.dataset.coverageNode);
    focusedId = nodeId;
    viewport.focus({ preventScroll: true });
    if (target.closest("[data-tree-toggle]")) {
      const index = model.visibleIndexById.get(nodeId)!;
      model.setExpanded(nodeId, !model.rows[index].expanded);
      changed();
      return;
    }
    const metric = target.closest<HTMLElement>("[data-tree-metric]")?.dataset.treeMetric as CoverageMetric | undefined;
    select(nodeId, metric);
  });

  viewport.addEventListener("keydown", event => {
    const index = model.visibleIndexById.get(focusedId) ?? 0;
    const row = model.rows[index];
    if (!row) return;
    let nextIndex = index;
    switch (event.key) {
      case "ArrowDown": nextIndex = Math.min(model.rows.length - 1, index + 1); break;
      case "ArrowUp": nextIndex = Math.max(0, index - 1); break;
      case "ArrowRight":
        if (!row.expanded && row.node.children.length) {
          model.setExpanded(row.node.id, true);
          changed();
        } else if (model.rows[index + 1]?.depth > row.depth) nextIndex += 1;
        break;
      case "ArrowLeft":
        if (row.expanded) {
          model.setExpanded(row.node.id, false);
          changed();
        } else {
          const parent = model.parentId(row.node.id);
          nextIndex = parent === undefined ? index : model.visibleIndexById.get(parent) ?? index;
        }
        break;
      case "Enter": select(row.node.id); break;
      default: return;
    }
    event.preventDefault();
    focusedId = model.rows[nextIndex].node.id;
    scrollToNode(focusedId);
  });

  model.setSearch(search.value);
  changed();
  return {
    refresh(nextDisplay: CoverageDisplay | undefined, nextSelectedId: number | null): void {
      const displayChanged = display !== nextDisplay;
      display = nextDisplay;
      selectedId = nextSelectedId;
      if (selectedId !== null) focusedId = selectedId;
      if (displayChanged) {
        metrics = coverageTreeMetrics(display);
        changed();
      } else {
        updateSelectedRows();
        updateActiveDescendant();
      }
    },
    reveal(nodeId: number): void {
      const rows = model.rows;
      if (!model.reveal(nodeId)) return;
      focusedId = nodeId;
      if (!model.query) search.value = "";
      if (rows !== model.rows) changed();
      scrollToNode(nodeId);
    },
    resize(): void {
      renderHeader();
      render(true);
    },
  };
}
