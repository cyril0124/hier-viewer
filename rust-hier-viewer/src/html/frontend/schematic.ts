import { loadSchematicGraph, requestSchematicScope } from "./schematic-data.js";
import { OrthogonalRouter, GRID } from "./schematic-routing.js";
import { compactLabel, displayNetName } from "./schematic-model.js";
import { visibleWires, type VisibleWire } from "./schematic-wires.js";
import type { LayoutResponse, Point, SceneEdge, SceneNode, SchematicGraph, SchematicScene } from "./schematic-types.js";

export interface SchematicOptions {
  container: HTMLElement;
  available: boolean;
  onDemand?: boolean;
  directory: string;
  scopePath: (nodeId: number) => string;
  navigate: (instancePath: string) => void;
  openSource: (instancePath: string) => void;
  hasSource: (instancePath: string) => boolean;
  instanceWeight?: (instancePath: string) => number;
}
interface Camera { x: number; y: number; zoom: number }
interface SavedScope {
  detail?: boolean;
  camera?: Camera;
  expanded: string[];
  positions: Record<string, Point>;
}
interface ScopeView {
  graph: SchematicGraph;
  scene: SchematicScene;
  partial: boolean;
  detail: boolean;
  camera: Camera;
  expanded: Set<string>;
  positions: Record<string, Point>;
}
interface Gesture {
  pointerId: number;
  start: Point;
  origin: Point;
  kind: "pan" | "node" | "edge";
  id: string;
  segment: number;
  moved: boolean;
  additive: boolean;
}

const SVG_NS = "http://www.w3.org/2000/svg";
const CAMERA_LIMIT = 32;
function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag);
  result.className = className;
  result.textContent = text;
  return result;
}
function svgElement<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const result = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) result.setAttribute(name, String(value));
  return result;
}
function pathData(points: Point[]): string {
  return points.map((point, index) => `${index ? "L" : "M"}${point.x},${point.y}`).join(" ");
}
function numberLabel(value: number): string { return value.toLocaleString("en-US"); }
function bitWidthLabel(value: number): string { return value === 0 ? "unknown width" : `${value} bits`; }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function validCamera(value: unknown): value is Camera {
  if (!value || typeof value !== "object") return false;
  const camera = value as Camera;
  return Number.isFinite(camera.x) && Number.isFinite(camera.y) && Number.isFinite(camera.zoom) && camera.zoom >= 0.005 && camera.zoom <= CAMERA_LIMIT;
}

/** Each controller owns its worker, gesture state and scope cache. Hidden views cancel pending work. */
export function createSchematic(options: SchematicOptions) {
  const host = options.container;
  const toolbar = element("div", "schematic-toolbar");
  const scopeLabel = element("span", "schematic-scope");
  const stats = element("span", "schematic-stats");
  const gridLabel = element("label", "schematic-option");
  const gridToggle = element("input");
  gridToggle.type = "checkbox";
  gridToggle.id = "schematic-show-grid";
  gridLabel.append(gridToggle, "Show grid");
  const snapLabel = element("label", "schematic-option");
  const snapToggle = element("input");
  snapToggle.type = "checkbox";
  snapToggle.id = "schematic-snap-grid";
  snapLabel.append(snapToggle, "Snap to grid");
  const fitButton = element("button", "", "Fit");
  fitButton.type = "button";
  fitButton.setAttribute("aria-label", "Fit schematic");
  const resetButton = element("button", "", "Reset layout");
  resetButton.type = "button";
  resetButton.setAttribute("aria-label", "Reset schematic layout");
  const detailLabel = element('label', 'schematic-option');
  const detailToggle = element('input');
  detailToggle.type = 'checkbox';
  detailToggle.id = 'schematic-rtl-detail';
  detailLabel.append(detailToggle, 'RTL detail');
  detailLabel.hidden = true;
  toolbar.append(scopeLabel, stats, detailLabel, gridLabel, snapLabel, fitButton, resetButton);

  const viewport = element("div", "schematic-viewport");
  const svg = svgElement("svg", { role: "application", "aria-label": "RTL schematic canvas", tabindex: 0 });
  const defs = svgElement("defs");
  const pattern = svgElement("pattern", { id: "schematic-grid-pattern", width: GRID, height: GRID, patternUnits: "userSpaceOnUse" });
  pattern.append(svgElement("path", { d: `M ${GRID} 0 L 0 0 0 ${GRID}`, class: "schematic-grid-line" }));
  defs.append(pattern);
  const grid = svgElement("rect", { width: "100%", height: "100%", fill: "url(#schematic-grid-pattern)", class: "schematic-grid" });
  grid.style.display = "none";
  const world = svgElement("g", { class: "schematic-world" });
  const edgesLayer = svgElement("g", { class: "schematic-edges" });
  const nodesLayer = svgElement("g", { class: "schematic-nodes" });
  // Highlight above all normal wires so crossings cannot paint over the glow.
  // Keeping two paths here avoids filtering or repainting the entire scene.
  function wireHighlight(className: string) {
    const group = svgElement("g", { class: `schematic-wire-highlight ${className}`, "pointer-events": "none", visibility: "hidden" });
    group.append(svgElement("path", { class: "schematic-highlight-halo" }), svgElement("path", { class: "schematic-highlight-line" }));
    return group;
  }
  const selectionHighlight = wireHighlight("schematic-wire-selection");
  const hoverHighlight = wireHighlight("schematic-wire-hover");
  world.append(edgesLayer, selectionHighlight, hoverHighlight, nodesLayer);
  svg.append(defs, grid, world);
  const notice = element("div", "schematic-notice");
  notice.setAttribute("role", "status");
  notice.setAttribute("aria-live", "polite");
  const phaseLabel = element("strong");
  const phaseDetail = element("span");
  const progress = element("progress");
  progress.max = 1;
  const retryButton = element("button", "", "Retry");
  retryButton.type = "button";
  retryButton.hidden = true;
  retryButton.onclick = () => {
    if (active && currentId >= 0 && !loading) void loadScope(currentId);
  };
  notice.append(phaseLabel, phaseDetail, progress, retryButton);
  const legend = element("div", "schematic-legend", "RTL dependencies · double-click a module to enter · drag wires to edit bends");
  viewport.append(svg, notice, legend);
  host.replaceChildren(toolbar, viewport);

  const card = element("div", "hover-card schematic-hover-card hidden");
  card.id = "schematic-hover-card";
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-label", "Schematic details");
  const cardHeader = element("div", "hover-topbar");
  const pin = element("button", "schematic-card-pin", "Pin");
  const close = element("button", "hover-dismiss", "×");
  pin.type = close.type = "button";
  close.setAttribute("aria-label", "Close schematic details");
  cardHeader.append(pin, close);
  const cardBody = element("div", "schematic-card-body");
  card.append(cardHeader, cardBody);
  viewport.append(card);

  let active = false;
  let currentId = -1;
  let view: ScopeView | null = null;
  let router: OrthogonalRouter | null = null;
  let abort: AbortController | null = null;
  let worker: Worker | null = null;
  let requestId = 0;
  let loading = false;
  let gesture: Gesture | null = null;
  let moveFrame = 0;
  let pendingMove: Point | null = null;
  let selected: Element | null = null;
  const selectedEdgeIds = new Set<string>();
  let hoveredEdgeId: string | null = null;
  let shownCardKey: string | null = null;
  let lastClickedNodeId: string | null = null;
  let pinned = false;
  let cardTimer = 0;
  let cardShowTimer = 0;
  let suppressHover = false;
  let saveTimer = 0;
  let layoutStarted = 0;
  const cache = new Map<number, ScopeView>();
  const nodeElements = new Map<string, SVGGElement>();
  const edgeElements = new Map<string, SVGGElement>();
  const wireByEdge = new Map<string, VisibleWire>();
  const wiresByNet = new Map<string, Set<VisibleWire>>();
  const nodeById = new Map<string, SceneNode>();
  const edgeById = new Map<string, SceneEdge>();
  let netById = new Map<string, SchematicGraph["nets"][number]>();
  const storageKey = `hier-viewer:schematic:v2:${location.pathname}`;
  let saved: Record<string, SavedScope> = {};
  const metrics = { loadMs: 0, layoutMs: 0, renderMs: 0, dragFrames: 0, dragMs: 0, maxDragMs: 0, layouts: 0, groupUpdates: 0, groupUpdateMs: 0, maxGroupUpdateMs: 0 };

  try {
    const current = localStorage.getItem(storageKey);
    const raw = JSON.parse(current || localStorage.getItem(`hier-viewer:schematic:v1:${location.pathname}`) || 'null');
    if (raw?.version === 1) {
      gridToggle.checked = raw.showGrid === true;
      snapToggle.checked = raw.snap === true;
      // Preserve old arrangements under their key; their coordinates belong to
      // different module dimensions and must not override the compact layout.
      if (current && raw.scopes && typeof raw.scopes === "object") saved = raw.scopes;
    }
  } catch { /* Unavailable storage does not prevent viewing a static bundle. */ }
  grid.style.display = gridToggle.checked ? "" : "none";

  function persist() {
    clearTimeout(saveTimer);
    if (view) saved[view.graph.scopePath] = { detail: view.detail, camera: { ...view.camera }, expanded: [...view.expanded], positions: view.positions };
    const paths = Object.keys(saved);
    for (const path of paths.slice(0, Math.max(0, paths.length - 12))) delete saved[path];
    try { localStorage.setItem(storageKey, JSON.stringify({ version: 1, showGrid: gridToggle.checked, snap: snapToggle.checked, scopes: saved })); }
    catch { /* Storage can be blocked or full; the in-memory view remains usable. */ }
  }
  function scheduleSave() { clearTimeout(saveTimer); saveTimer = window.setTimeout(persist, 250); }
  function setNotice(title: string, detail = "", fraction?: number, failure = false) {
    notice.hidden = false;
    notice.classList.toggle("error", failure);
    phaseLabel.textContent = title;
    phaseDetail.textContent = detail;
    progress.hidden = failure || fraction === 1;
    retryButton.hidden = !failure || !options.onDemand;
    if (fraction === undefined) progress.removeAttribute("value");
    else progress.value = fraction;
  }
  function updateStats() {
    if (!view) return;
    stats.textContent = `${view.partial ? "Partial RTL · " : ""}${numberLabel(view.graph.nodes.length)} nodes · ${numberLabel(view.graph.nets.length)} nets · ${view.scene.groups.length} buses · ${view.camera.zoom.toFixed(2)}×`;
  }
  function transform() {
    if (!view) return;
    const { x, y, zoom } = view.camera;
    const value = `translate(${x} ${y}) scale(${zoom})`;
    svg.classList.toggle('schematic-overview', zoom < 0.6);
    svg.style.setProperty('--schematic-label-size', `${13 / zoom}px`);
    world.setAttribute("transform", value);
    pattern.setAttribute("patternTransform", value);
    grid.style.display = gridToggle.checked ? "" : "none";
    updateStats();
  }
  function fit() {
    if (!view || !view.scene.nodes.length) return;
    const bounds = view.scene.nodes.reduce((box, node) => ({
      x: Math.min(box.x, node.x), y: Math.min(box.y, node.y),
      right: Math.max(box.right, node.x + node.width), bottom: Math.max(box.bottom, node.y + node.height),
    }), { x: Infinity, y: Infinity, right: -Infinity, bottom: -Infinity });
    for (const edge of view.scene.edges) {
      for (const point of edge.points) {
        bounds.x = Math.min(bounds.x, point.x);
        bounds.y = Math.min(bounds.y, point.y);
        bounds.right = Math.max(bounds.right, point.x);
        bounds.bottom = Math.max(bounds.bottom, point.y);
      }
    }
    const availableWidth = Math.max(100, viewport.clientWidth - 100);
    const availableHeight = Math.max(100, viewport.clientHeight - 100);
    const zoom = Math.max(0.005, Math.min(1.2, availableWidth / (bounds.right - bounds.x), availableHeight / (bounds.bottom - bounds.y)));
    view.camera = { zoom, x: viewport.clientWidth / 2 - (bounds.x + bounds.right) * zoom / 2, y: viewport.clientHeight / 2 - (bounds.y + bounds.bottom) * zoom / 2 };
    transform();
    scheduleSave();
  }
  function zoomByFactor(factor: number, anchor?: Point) {
    if (!view) return;
    const point = anchor || { x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 };
    const camera = view.camera;
    const zoom = Math.max(0.005, Math.min(CAMERA_LIMIT, camera.zoom * factor));
    const scale = zoom / camera.zoom;
    camera.x = point.x - (point.x - camera.x) * scale;
    camera.y = point.y - (point.y - camera.y) * scale;
    camera.zoom = zoom;
    transform();
    scheduleSave();
  }
  function localPoint(client: Point): Point {
    const bounds = svg.getBoundingClientRect();
    return { x: client.x - bounds.left, y: client.y - bounds.top };
  }
  function worldPoint(client: Point): Point {
    const point = localPoint(client);
    const camera = view!.camera;
    return { x: (point.x - camera.x) / camera.zoom, y: (point.y - camera.y) / camera.zoom };
  }
  function relatedWires(edgeIds: Iterable<string>): VisibleWire[] {
    const result = new Set<VisibleWire>();
    for (const edgeId of edgeIds) {
      const wire = wireByEdge.get(edgeId);
      if (!wire) continue;
      for (const netId of wire.netIds) {
        for (const related of wiresByNet.get(netId) ?? []) result.add(related);
      }
    }
    return [...result];
  }
  function drawHighlight(group: SVGGElement, wires: readonly VisibleWire[], primaryEdgeId?: string) {
    group.replaceChildren();
    for (const wire of wires) {
      const d = pathData(wire.edge.points);
      group.append(
        svgElement('path', { d, class: 'schematic-highlight-halo' }),
        svgElement('path', { d, class: 'schematic-highlight-line' }),
      );
    }
    group.setAttribute('visibility', wires.length ? 'visible' : 'hidden');
    if (wires.length) {
      const ids = wires.flatMap(wire => wire.edgeIds);
      group.dataset.highlightEdge = primaryEdgeId ?? ids[0];
      group.dataset.highlightEdges = JSON.stringify([...new Set(ids)]);
    } else {
      delete group.dataset.highlightEdge;
      delete group.dataset.highlightEdges;
    }
  }
  function updateHighlight(group: SVGGElement, edgeId: string | null) {
    drawHighlight(group, edgeId ? relatedWires([edgeId]) : [] , edgeId || undefined);
  }
  function hoverEdge(edgeId: string | null) {
    if (edgeId === hoveredEdgeId) return;
    if (hoveredEdgeId) edgeElements.get(hoveredEdgeId)?.classList.remove("hovered");
    hoveredEdgeId = edgeId;
    if (edgeId) edgeElements.get(edgeId)?.classList.add("hovered");
    updateHighlight(hoverHighlight, edgeId);
  }
  function updateSelectionHighlights() {
    const wires = new Set<VisibleWire>();
    for (const edgeId of selectedEdgeIds) {
      for (const wire of relatedWires([edgeId])) wires.add(wire);
    }
    drawHighlight(selectionHighlight, [...wires]);
    for (const [edgeId, group] of edgeElements) {
      if (!selectedEdgeIds.has(edgeId)) group.classList.remove('selected');
    }
    for (const edgeId of selectedEdgeIds) edgeElements.get(edgeId)?.classList.add('selected');
  }
  function selectEdges(edgeId: string, additive = false) {
    const edgeIds = wireByEdge.get(edgeId)?.edgeIds ?? [edgeId];
    if (!additive) selectedEdgeIds.clear();
    const allSelected = edgeIds.every(id => selectedEdgeIds.has(id));
    for (const id of edgeIds) {
      if (additive && allSelected) selectedEdgeIds.delete(id);
      else selectedEdgeIds.add(id);
    }
    selected?.classList.remove('selected');
    selected = null;
    updateSelectionHighlights();
  }
  function clearEdgeSelection() {
    if (!selectedEdgeIds.size) return;
    selectedEdgeIds.clear();
    updateSelectionHighlights();
  }
  function select(target: Element | null) {
    clearEdgeSelection();
    selected?.classList.remove("selected");
    selected = target;
    selected?.classList.add("selected");
  }
  function hideCard(force = false) {
    clearTimeout(cardTimer);
    clearTimeout(cardShowTimer);
    if (pinned && !force) return;
    card.classList.add("hidden");
    shownCardKey = null;
    if (force) { pinned = false; card.classList.remove("locked"); pin.textContent = "Pin"; }
  }
  function deferHideCard() {
    clearTimeout(cardShowTimer);
    clearTimeout(cardTimer);
    cardTimer = window.setTimeout(() => hideCard(), 220);
  }
  function scheduleCard(node: SceneNode) {
    clearTimeout(cardShowTimer);
    cardShowTimer = window.setTimeout(() => {
      if (!gesture && !loading && !suppressHover) showCard(node);
    }, 140);
  }
  function pinCard() { pinned = true; pin.textContent = "Pinned"; card.classList.add("locked"); }
  function anchorCard() {
    card.style.left = "auto";
    card.style.right = "12px";
    card.style.top = "12px";
    card.classList.remove("hidden");
  }
  function appendNetDetails(container: HTMLElement, netIds: readonly string[], includeEndpoints = false) {
    for (const id of netIds) {
      const net = netById.get(id);
      if (!net) continue;
      const row = element("div", "schematic-signal-detail");
      row.append(element("code", "", displayNetName(net, nodeById)), element("span", "", `${bitWidthLabel(net.width)} · ${net.endpoints.length} endpoints · ${net.status}`));
      if (includeEndpoints) {
        const endpoints = net.endpoints.map(endpoint => {
          const node = nodeById.get(endpoint.nodeId);
          const port = node?.ports.find(candidate => candidate.id === endpoint.portId);
          return `${endpoint.role}: ${node?.instancePath || endpoint.nodeId}.${port?.label || endpoint.portId}`;
        });
        row.append(element("span", "", endpoints.join(" · ")));
      }
      container.append(row);
    }
  }
  function showSelectedWireCard() {
    if (!selectedEdgeIds.size) { hideCard(true); return; }
    clearTimeout(cardTimer);
    clearTimeout(cardShowTimer);
    const netIds = [...new Set([...selectedEdgeIds].flatMap(edgeId =>
      wireByEdge.get(edgeId)?.netIds ?? edgeById.get(edgeId)?.netIds ?? []))];
    const list = element("div", "schematic-signal-list");
    appendNetDetails(list, netIds, true);
    cardBody.replaceChildren(
      element("div", "hover-title", `${netIds.length} signals selected`),
      element("div", "hover-path", `${selectedEdgeIds.size} wire${selectedEdgeIds.size === 1 ? "" : "s"} · Ctrl-click to add or remove`),
      list,
    );
    shownCardKey = `selection:${[...selectedEdgeIds].sort().join(",")}`;
    anchorCard();
    pinCard();
  }

  function showWireCard(edge: SceneEdge) {
    if (pinned || shownCardKey === `edge:${edge.id}`) return;
    clearTimeout(cardTimer);
    const list = element("div", "schematic-signal-list");
    const netIds = wireByEdge.get(edge.id)?.netIds ?? edge.netIds;
    appendNetDetails(list, netIds);
    const title = netIds.length > 1 ? `${netIds.length} signals` : edge.label;
    cardBody.replaceChildren(element("div", "hover-title", title), element("div", "hover-path", `${netIds.length > 1 ? 'Bus' : 'Signal'} · ${edge.status}`), list);
    shownCardKey = `edge:${edge.id}`;
    anchorCard();
  }
  function showCard(node: SceneNode, lock = false) {
    if (pinned && !lock) return;
    clearTimeout(cardTimer);
    if (shownCardKey === `node:${node.id}`) { if (lock) pinCard(); return; }
    shownCardKey = `node:${node.id}`;
    const title = element("div", "hover-title", node.label);
    const detail = element("div", "hover-path", node.instancePath || node.detail);
    cardBody.replaceChildren(title, detail);
    if (node.groupId && view) {
      const group = view.scene.groups.find(item => item.id === node.groupId);
      const list = element("div", "schematic-signal-list");
      appendNetDetails(list, group?.netIds || []);
      cardBody.append(list);
    } else {
    const weightedBits = node.visualWeight === undefined ? '' : ` · weighted signal bits ${numberLabel(node.visualWeight)}`;
    cardBody.append(element("div", "schematic-card-note", `${node.kind} · ${node.ports.length} ports${weightedBits}`));
      if (node.detail && node.detail !== node.instancePath) cardBody.append(element("pre", "schematic-expression", node.detail));
      const portList = element("div", "schematic-signal-list");
      for (const port of node.ports) portList.append(element("div", "schematic-port-detail", `${port.direction} ${port.label} [${bitWidthLabel(port.width)}]`));
      cardBody.append(portList);
      if (node.id.includes(':logic:')) {
        const inspectLogic = element('button', '', 'Show RTL detail');
        inspectLogic.type = 'button';
        inspectLogic.onclick = () => {
          hideCard(true);
          detailToggle.checked = true;
          changeDetail();
        };
        cardBody.append(inspectLogic);
      }
      if (node.instancePath) {
        const path = node.instancePath;
        const actions = element("div", "hover-actions");
        const enter = element("button", "", "Enter hierarchy");
        enter.type = "button";
        enter.onclick = () => { hideCard(true); options.navigate(path); };
        actions.append(enter);
        if (options.hasSource(path)) {
          const source = element("button", "", "Open source");
          source.type = "button";
          source.onclick = () => options.openSource(path);
          actions.append(source);
        }
        cardBody.append(actions);
      }
    }
    anchorCard();
    if (lock) pinCard();
  }
  function createNode(node: SceneNode): SVGGElement {
    const roleClass = node.kind === 'boundary' ? (node.label === 'Inputs' ? ' schematic-input' : ' schematic-output') : '';
    const group = svgElement("g", { class: `schematic-node schematic-${node.kind}${roleClass}`, "data-node-id": node.id, "data-node-type": node.kind === 'boundary' ? node.label.toLowerCase() : node.kind, transform: `translate(${node.x} ${node.y})`, role: "button", tabindex: 0, "aria-label": `${node.kind}: ${node.label}` });
    const radius = node.kind === 'group' ? 9 : node.kind === 'expr' ? 12 : node.kind === 'constant' ? 1 : node.kind === 'boundary' ? 10 : 5;
    const body = svgElement("rect", { width: node.width, height: node.height, rx: radius, class: "schematic-node-body" });
    group.append(body);
    if (node.kind === 'boundary') {
      const input = node.label === 'Inputs';
      group.append(svgElement('rect', {
        x: input ? 0 : node.width - 5, y: 1, width: 5, height: node.height - 2,
        rx: 2.5, class: 'schematic-boundary-accent',
      }));
      const arrowX = node.width - 24;
      group.append(svgElement('path', {
        d: `M${arrowX},${node.height / 2 - 9} L${arrowX + 9},${node.height / 2} L${arrowX},${node.height / 2 + 9}`,
        class: 'schematic-boundary-arrow',
      }));
    }
    if (node.kind === 'module') {
      group.append(svgElement('rect', { x: 1, y: 1, width: node.width - 2, height: 47, rx: 5, class: 'schematic-node-header' }));
    }
    if (node.kind === 'group') {
      group.append(svgElement('path', { d: `M10,28 H${node.width - 10} M10,32 H${node.width - 10} M10,36 H${node.width - 10}`, class: 'schematic-bus-mark' }));
    }
    const kindBadge = node.kind === 'boundary' ? node.label.toUpperCase()
      : node.kind === 'module' ? 'MODULE'
      : node.kind === 'expr' ? 'OPERATOR'
      : node.kind === 'constant' ? 'CONST'
      : node.kind === 'unresolved' ? 'ERROR'
      : node.kind === 'group' ? 'BUS'
      : 'NET';
    const badge = svgElement('text', { x: 9, y: 15, class: 'schematic-kind-badge' });
    badge.textContent = kindBadge;
    group.append(badge);
    if (node.kind === "module" || node.kind === "boundary") {
      group.append(svgElement("path", { d: `M0,48 H${node.width}`, class: "schematic-node-divider" }));
    }
    const title = svgElement("title");
    title.textContent = node.detail || node.label;
    if (node.visualWeight !== undefined) title.textContent += ` · Weighted Signal bits: ${numberLabel(node.visualWeight)}`;
    group.append(title);
    if (node.kind === "junction") {
      group.setAttribute("aria-label", `net: ${node.label}`);
    }
    const heading = svgElement("text", { x: node.width / 2, y: node.kind === "group" ? 29 : 29, "text-anchor": "middle", class: "schematic-node-title" });
    const definition = node.groupId && view?.scene.groups.find(item => item.id === node.groupId);
    heading.textContent = node.kind === "group"
      ? `${node.expanded ? '−' : '+'} ${compactLabel(node.label)} · ${definition ? definition.netIds.length : ''}`
      : node.label;
    group.append(heading);
    if (node.subtitle) {
      const subtitle = svgElement("text", { x: node.width / 2, y: 41, "text-anchor": "middle", class: "schematic-node-subtitle" });
      subtitle.textContent = node.subtitle;
      group.append(subtitle);
    }
    if (node.groupId) {
      group.dataset.groupId = node.groupId;
      group.setAttribute("aria-expanded", String(!!node.expanded));
    }
    const overview = svgElement('text', {
      x: node.width / 2, y: node.height / 2 + 4, 'dominant-baseline': 'central', 'text-anchor': 'middle',
      class: 'schematic-overview-title',
    });
    overview.textContent = node.kind === 'group'
      ? `${node.expanded ? '−' : '+'} ${definition ? definition.netIds.length : ''}`
      : compactLabel(node.label, 20);
    overview.style.fontSize = `min(var(--schematic-label-size), ${Math.min(32, node.width / Math.max(1, overview.textContent.length * 0.65))}px)`;
    group.append(overview);
    for (const row of node.rows || []) {
      const text = svgElement("text", { x: node.width / 2, y: row.y + 4, "text-anchor": "middle", class: "schematic-signal-row", "data-net-id": row.netId });
      text.textContent = row.label;
      group.append(text);
    }
    const drawnPorts = new Set<string>();
    for (const port of node.ports) {
      if (port.hidden) continue;
      const location = `${port.x}:${port.y}`;
      if (drawnPorts.has(location)) continue;
      drawnPorts.add(location);
      const size = port.bundleCount ? 7 : 5;
      group.append(svgElement("rect", { x: port.x - size / 2, y: port.y - size / 2, width: size, height: size, rx: 1, class: "schematic-port", "data-port-id": port.id }));
      if (node.kind === "group" || node.kind === "junction") continue;
      const west = port.side === "WEST";
      const text = svgElement("text", { x: west ? 10 : node.width - 10, y: port.y + 4, "text-anchor": west ? "start" : "end", class: "schematic-port-label" });
      text.textContent = port.displayLabel ?? (port.width > 1 ? `${port.label} [${port.width}]` : port.label);
      group.append(text);
    }
    return group;
  }
  function updateEdges(ids: Iterable<string>) {
    for (const id of ids) {
      const edge = edgeById.get(id);
      const group = edgeElements.get(id);
      if (!edge || !group) continue;
      const d = pathData(edge.points);
      for (const path of group.querySelectorAll("path")) path.setAttribute("d", d);
      if (hoveredEdgeId === id) updateHighlight(hoverHighlight, id);
      if (selectedEdgeIds.has(id)) updateSelectionHighlights();
    }
  }
  function renderWires() {
    if (!view) return;
    const previousElements = new Map(edgeElements);
    edgeElements.clear();
    wireByEdge.clear();
    wiresByNet.clear();
    const fragment = document.createDocumentFragment();
    for (const wire of visibleWires(view.scene)) {
      const { edge, edgeIds, netIds } = wire;
      const bus = netIds.length > 1;
      const previous = previousElements.get(edge.id);
      const group = previous?.dataset.edgeId === edge.id ? previous : svgElement('g');
      group.setAttribute('class', `schematic-wire ${edge.status}${bus ? ' schematic-bus' : ''}`);
      group.dataset.edgeId = edge.id;
      group.dataset.edgeIds = JSON.stringify(edgeIds);
      group.dataset.netIds = JSON.stringify(netIds);
      group.setAttribute('aria-label', bus ? `${netIds.length} signals` : edge.label);
      const d = pathData(edge.points);
      if (!group.childElementCount) {
        for (const className of ['schematic-wire-casing', 'schematic-wire-line', 'schematic-wire-hit']) {
          group.append(svgElement('path', { class: className }));
        }
        group.append(svgElement('title'));
      }
      for (const path of group.querySelectorAll('path')) path.setAttribute('d', d);
      const title = group.querySelector('title')!;
      title.textContent = `${bus ? `${netIds.length} signals` : edge.label} · ${edge.status}`;
      for (const edgeId of edgeIds) {
        edgeElements.set(edgeId, group);
        wireByEdge.set(edgeId, wire);
        for (const netId of netIds) {
          let wires = wiresByNet.get(netId);
          if (!wires) { wires = new Set(); wiresByNet.set(netId, wires); }
          wires.add(wire);
        }
      }
      fragment.append(group);
    }
    edgesLayer.replaceChildren(fragment);
  }
  function renderScene() {
    if (!view) return;
    const started = performance.now();
    stats.classList.toggle("schematic-partial", view.partial);
    legend.textContent = view.partial
      ? "Partial RTL export: resolve compilation errors before treating these connections as complete."
      : view.scene.summary
        ? `${numberLabel(view.scene.summary.nodes)} local logic nodes summarized · enable RTL detail to inspect · double-click a module to enter`
        : "Double-click a module to enter · click a bus to inspect signals · zoom to read pins";
    detailLabel.hidden = !view.detail && !view.scene.summary;
    detailToggle.checked = view.detail;
    select(null);
    hoverEdge(null);
    lastClickedNodeId = null;
    hideCard(true);
    nodeById.clear(); edgeById.clear(); nodeElements.clear(); edgeElements.clear();
    netById = new Map(view.graph.nets.map(net => [net.id, net]));
    for (const edge of view.scene.edges) edgeById.set(edge.id, edge);
    renderWires();
    const nodeFragment = document.createDocumentFragment();
    for (const node of view.scene.nodes) {
      nodeById.set(node.id, node);
      const group = createNode(node);
      nodeElements.set(node.id, group);
      nodeFragment.append(group);
    }
    nodesLayer.replaceChildren(nodeFragment);
    metrics.renderMs = performance.now() - started;
    transform();
  }
  function cacheView() {
    if (!view || currentId < 0) return;
    cache.delete(currentId);
    cache.set(currentId, view);
    while (cache.size > 4) cache.delete(cache.keys().next().value!);
  }
  function cancelPending() {
    ++requestId;
    abort?.abort(); abort = null;
    worker?.terminate(); worker = null;
    loading = false;
    host.removeAttribute("aria-busy");
  }
  function requestLayout(graph: SchematicGraph, expanded: Set<string>) {
    const weightedGraph: SchematicGraph = options.instanceWeight
      ? {
        ...graph,
        nodes: graph.nodes.map(node => node.instancePath
          ? { ...node, visualWeight: options.instanceWeight!(node.instancePath) }
          : node),
      }
      : graph;
    // Do not reopen a card over the next group immediately after expansion.
    suppressHover = true;
    if (loading) { worker?.terminate(); worker = null; }
    const id = ++requestId;
    loading = true;
    host.setAttribute("aria-busy", "true");
    setNotice("Laying out schematic…", "Placing modules and routing ports.");
    layoutStarted = performance.now();
    metrics.layouts++;
    worker ??= new Worker("./viewer-schematic-worker.js");
    const detail = detailToggle.checked;
    worker.onmessage = (event: MessageEvent<LayoutResponse>) => {
      const response = event.data;
      if (!active || response.id !== requestId) return;
      if ("stage" in response) { setNotice(response.stage, "Layout runs in a background worker."); return; }
      if ("error" in response) { fail(response.error); return; }
      const stored = saved[graph.scopePath];
      view = {
        graph, scene: response.scene, expanded,
        partial: graph.nodes.some(node => node.id === `${graph.scopePath}:elaboration-errors`),
        detail,
        camera: validCamera(stored?.camera) && stored?.detail === detail ? stored.camera : { x: 0, y: 0, zoom: 1 },
        positions: stored?.detail === detail && stored?.positions && typeof stored.positions === "object" ? stored.positions : {},
      };
      router = new OrthogonalRouter(view.scene);
      for (const [nodeId, position] of Object.entries(view.positions)) {
        if (position && Number.isFinite(position.x) && Number.isFinite(position.y)) router.moveNode(nodeId, position.x, position.y);
      }
      metrics.layoutMs = performance.now() - layoutStarted;
      loading = false;
      host.removeAttribute("aria-busy");
      // Group edits reuse retained geometry; release the initial layout worker.
      worker?.terminate(); worker = null;
      renderScene();
      world.style.visibility = "";
      if (!validCamera(stored?.camera) || stored?.detail !== detail) fit();
      if (!view.scene.nodes.length) setNotice("No connections in this scope", "The RTL export contains a valid empty schematic.", 1);
      else notice.hidden = true;
      cacheView();
      persist();
    };
    worker.onerror = event => { if (id === requestId && active) fail(event.message || "Unable to load the local schematic layout worker."); };
    worker.postMessage({ id, graph: weightedGraph, expanded: [...expanded], detail });
  }
  function fail(error: unknown) {
    cancelPending();
    setNotice("Schematic unavailable", message(error), undefined, true);
  }
  async function loadScope(nodeId: number) {
    cancelPending();
    const id = requestId;
    const controller = new AbortController();
    abort = controller;
    hideCard(true);
    hoverEdge(null);
    select(null);
    endGesture();
    loading = true;
    host.setAttribute("aria-busy", "true");
    view = null; router = null;
    world.style.visibility = "hidden";
    stats.textContent = "";
    scopeLabel.textContent = options.scopePath(nodeId);
    const started = performance.now();
    try {
      let url = `./${options.directory}/${nodeId}.json`;
      if (options.onDemand) {
        url = await requestSchematicScope(nodeId, controller.signal, (title, detail) => {
          if (id === requestId && active) setNotice(title, detail);
        });
        if (id !== requestId || !active || controller.signal.aborted) return;
      }
      const graph = await loadSchematicGraph(url, controller.signal, (received, total) => {
        if (id !== requestId) return;
        const detail = total > 0 ? `${numberLabel(received)} / ${numberLabel(total)} bytes` : `${numberLabel(received)} bytes received`;
        setNotice("Loading connections…", detail, total > 0 ? received / total : undefined);
      });
      if (id !== requestId || !active) return;
      metrics.loadMs = performance.now() - started;
      const stored = saved[graph.scopePath];
      detailToggle.checked = stored?.detail === true;
      const expanded = new Set<string>();
      requestLayout(graph, expanded);
    } catch (error) { if (id === requestId && !controller.signal.aborted) fail(error); }
  }
  function setActive(next: boolean, nodeId: number) {
    const changed = next !== active;
    active = next;
    host.classList.toggle("active", next);
    if (!next) {
      if (changed) { persist(); cacheView(); cancelPending(); hideCard(true); hoverEdge(null); endGesture(); }
      return;
    }
    if (!options.available && !options.onDemand) {
      setNotice("Schematic data is missing", "Regenerate this bundle from RTL with the current hier-viewer. Existing hierarchy, charts and coverage remain available.", undefined, true);
      return;
    }
    if (nodeId === currentId && (view || loading)) return;
    persist(); cacheView(); cancelPending();
    currentId = nodeId;
    const cached = cache.get(nodeId);
    if (cached) {
      view = cached;
      router = new OrthogonalRouter(view.scene);
      scopeLabel.textContent = view.graph.scopePath;
      renderScene();
      notice.hidden = view.scene.nodes.length > 0;
      if (!notice.hidden) setNotice("No connections in this scope", "The RTL export contains a valid empty schematic.", 1);
      world.style.visibility = "";
      return;
    }
    void loadScope(nodeId);
  }
  function nearestSegment(edge: SceneEdge, point: Point): number {
    let best = -1;
    let distance = Infinity;
    for (let index = 0; index + 1 < edge.points.length; index++) {
      const a = edge.points[index], b = edge.points[index + 1];
      const dx = point.x - Math.max(Math.min(a.x, b.x), Math.min(point.x, Math.max(a.x, b.x)));
      const dy = point.y - Math.max(Math.min(a.y, b.y), Math.min(point.y, Math.max(a.y, b.y)));
      if (dx * dx + dy * dy < distance) { distance = dx * dx + dy * dy; best = index; }
    }
    return best;
  }
  function flushMove() {
    moveFrame = 0;
    const point = pendingMove;
    pendingMove = null;
    if (!gesture || !view || !router || !point) return;
    const dx = point.x - gesture.start.x, dy = point.y - gesture.start.y;
    if (!gesture.moved && dx * dx + dy * dy < 16) return;
    gesture.moved = true;
    hideCard();
    const started = performance.now();
    if (gesture.kind === "pan") {
      view.camera.x = gesture.origin.x + dx;
      view.camera.y = gesture.origin.y + dy;
      transform();
    } else if (gesture.kind === "node") {
      const snap = (value: number) => snapToggle.checked ? Math.round(value / GRID) * GRID : value;
      const x = snap(gesture.origin.x + dx / view.camera.zoom);
      const y = snap(gesture.origin.y + dy / view.camera.zoom);
      const changed = router.moveNode(gesture.id, x, y);
      for (const id of changed.nodeIds) {
        const node = nodeById.get(id)!;
        nodeElements.get(id)?.setAttribute("transform", `translate(${node.x} ${node.y})`);
        view.positions[id] = { x: node.x, y: node.y };
      }
      updateEdges(changed.edgeIds);
    } else {
      const edge = edgeById.get(gesture.id)!;
      const a = edge.points[gesture.segment], b = edge.points[gesture.segment + 1];
      if (a && b) {
        const world = worldPoint(point);
        let coordinate = a.x === b.x ? world.x : world.y;
        if (snapToggle.checked) coordinate = Math.round(coordinate / GRID) * GRID;
        const pointCount = edge.points.length;
        const changed: string[] = [];
        for (const id of wireByEdge.get(gesture.id)?.edgeIds ?? [gesture.id]) {
          changed.push(...router.moveSegment(id, gesture.segment, coordinate));
        }
        updateEdges(changed);
        // A straight wire becomes a dogleg on its first edit. Continue dragging
        // the new interior segment rather than its now-fixed port escape.
        if (changed.length && edge.points.length !== pointCount) gesture.segment = nearestSegment(edge, world);
      }
    }
    metrics.dragFrames++;
    const elapsed = performance.now() - started;
    metrics.dragMs += elapsed;
    metrics.maxDragMs = Math.max(metrics.maxDragMs, elapsed);
  }
  function endGesture() {
    if (moveFrame) cancelAnimationFrame(moveFrame);
    moveFrame = 0;
    pendingMove = null;
    if (gesture && svg.hasPointerCapture(gesture.pointerId)) svg.releasePointerCapture(gesture.pointerId);
    gesture = null;
    svg.classList.remove("dragging");
  }
  svg.addEventListener("pointerdown", event => {
    if (event.button !== 0 || !view || loading) return;
    hideCard();
    hoverEdge(null);
    svg.focus({ preventScroll: true });
    const target = event.target as Element;
    const nodeElement = target.closest<SVGGElement>("[data-node-id]");
    const edgeElement = target.closest<SVGGElement>("[data-edge-id]");
    const point = { x: event.clientX, y: event.clientY };
    const node = nodeElement ? nodeById.get(nodeElement.dataset.nodeId!) : null;
    const edge = edgeElement ? edgeById.get(edgeElement.dataset.edgeId!) : null;
    gesture = {
      pointerId: event.pointerId, start: point,
      origin: node ? { x: node.x, y: node.y } : { x: view.camera.x, y: view.camera.y },
      kind: node ? "node" : edge ? "edge" : "pan", id: node?.id || edge?.id || "",
      segment: edge ? nearestSegment(edge, worldPoint(point)) : -1, moved: false,
      additive: event.ctrlKey || event.metaKey,
    };
    svg.setPointerCapture(event.pointerId);
    svg.classList.add("dragging");
    event.preventDefault();
  });
  svg.addEventListener("pointermove", event => {
    if (!gesture) {
      if (suppressHover && !loading) {
        suppressHover = false;
        const target = (event.target as Element).closest<SVGGElement>("[data-node-id]");
        const node = target && nodeById.get(target.dataset.nodeId!);
        if (node) scheduleCard(node);
      }
      return;
    }
    pendingMove = { x: event.clientX, y: event.clientY };
    if (!moveFrame) moveFrame = requestAnimationFrame(flushMove);
  });
  svg.addEventListener("pointerup", () => {
    if (!gesture) return;
    if (moveFrame) cancelAnimationFrame(moveFrame);
    flushMove();
    const finished = gesture;
    endGesture();
    lastClickedNodeId = null;
    if (finished.moved) { persist(); return; }
    if (finished.kind === "node") {
      const node = nodeById.get(finished.id)!;
      lastClickedNodeId = node.id;
      select(nodeElements.get(node.id)!);
      showCard(node, true);
    } else if (finished.kind === "edge") {
      selectEdges(finished.id, finished.additive);
      showSelectedWireCard();
    }
    else { select(null); hideCard(true); }
  });
  svg.addEventListener("pointercancel", endGesture);
  svg.addEventListener("lostpointercapture", () => { if (gesture) endGesture(); });
  svg.addEventListener("wheel", event => {
    event.preventDefault();
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1);
    zoomByFactor(Math.exp(-Math.max(-500, Math.min(500, delta)) * 0.0015), localPoint({ x: event.clientX, y: event.clientY }));
  }, { passive: false });
  svg.addEventListener("dblclick", event => {
    const target = (event.target as Element).closest<SVGGElement>("[data-node-id]");
    // Pointer capture retargets the native click/dblclick to the SVG. Retain
    // the last unmoved node hit so double-click navigation still uses its port owner.
    const id = target?.dataset.nodeId || lastClickedNodeId;
    const node = id ? nodeById.get(id) : null;
    if (node?.instancePath) { hideCard(true); options.navigate(node.instancePath); }
  });
  svg.addEventListener("pointerover", event => {
    if (gesture || loading) return;
    const element = event.target as Element;
    const wire = element.closest<SVGGElement>("[data-edge-id]");
    hoverEdge(wire?.dataset.edgeId || null);
    if (suppressHover) return;
    if (wire && !wire.contains(event.relatedTarget as Node | null)) {
      const edge = edgeById.get(wire.dataset.edgeId!);
      clearTimeout(cardShowTimer);
      cardShowTimer = window.setTimeout(() => { if (edge && !gesture && !loading) showWireCard(edge); }, 140);
    }
    const target = element.closest<SVGGElement>("[data-node-id]");
    if (target && !target.contains(event.relatedTarget as Node | null)) {
      const node = nodeById.get(target.dataset.nodeId!);
      if (node) scheduleCard(node);
    }
  });
  svg.addEventListener("pointerout", event => {
    const target = (event.target as Element).closest("[data-node-id], [data-edge-id]");
    if (target && !target.contains(event.relatedTarget as Node | null)) {
      clearTimeout(cardShowTimer);
      if (target.hasAttribute("data-edge-id")) hoverEdge(null);
    }
  });
  svg.addEventListener("pointerleave", () => hoverEdge(null));
  // Cards stay available while crossing blank canvas to the fixed corner.
  viewport.addEventListener("pointerleave", deferHideCard);
  viewport.addEventListener("pointerenter", () => clearTimeout(cardTimer));
  svg.addEventListener("contextmenu", event => event.preventDefault());
  svg.addEventListener("keydown", event => {
    if (event.key === "Escape") { hideCard(true); select(null); }
    if (event.key === "Home") { event.preventDefault(); fit(); }
    if (event.key === "Enter" || event.key === " ") {
      const target = (event.target as Element).closest<SVGGElement>("[data-node-id]");
      const node = target && nodeById.get(target.dataset.nodeId!);
      if (node) {
        event.preventDefault();
        if (node.groupId) showCard(node, true);
        else if (node.instancePath) options.navigate(node.instancePath);
      }
    }
  });
  card.addEventListener("pointerenter", () => { clearTimeout(cardTimer); clearTimeout(cardShowTimer); });
  card.addEventListener("pointerdown", event => event.stopPropagation());
  card.addEventListener("click", event => { event.stopPropagation(); if (!(event.target as Element).closest("button")) pinCard(); });
  card.addEventListener("wheel", event => event.stopPropagation());
  pin.onclick = pinCard;
  close.onclick = () => hideCard(true);
  let cardDrag: { id: number; start: Point; left: number; top: number } | null = null;
  cardHeader.addEventListener("pointerdown", event => {
    if ((event.target as Element).closest("button") || event.button !== 0) return;
    pinCard();
    cardDrag = { id: event.pointerId, start: { x: event.clientX, y: event.clientY }, left: card.offsetLeft, top: card.offsetTop };
    card.style.left = `${cardDrag.left}px`;
    card.style.right = "auto";
    cardHeader.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  cardHeader.addEventListener("pointermove", event => {
    if (!cardDrag) return;
    card.style.left = `${Math.max(0, Math.min(viewport.clientWidth - card.offsetWidth, cardDrag.left + event.clientX - cardDrag.start.x))}px`;
    card.style.top = `${Math.max(0, Math.min(viewport.clientHeight - 40, cardDrag.top + event.clientY - cardDrag.start.y))}px`;
  });
  cardHeader.addEventListener("pointerup", () => { cardDrag = null; });
  cardHeader.addEventListener("pointercancel", () => { cardDrag = null; });
  function changeDetail() {
    if (!view) return;
    persist();
    cache.delete(currentId);
    requestLayout(view.graph, new Set());
  }
  function resetLayout() {
    if (!view || loading || currentId < 0) return;
    delete saved[view.graph.scopePath];
    cache.delete(currentId);
    detailToggle.checked = false;
    view.expanded.clear();
    view.positions = {};
    hideCard(true);
    select(null);
    hoverEdge(null);
    requestLayout(view.graph, new Set());
  }
  function refreshWeights() {
    if (!view || loading) return;
    cache.delete(currentId);
    requestLayout(view.graph, new Set(view.expanded));
  }
  resetButton.onclick = resetLayout;
  detailToggle.onchange = changeDetail;
  gridToggle.onchange = () => { grid.style.display = gridToggle.checked ? "" : "none"; persist(); };
  snapToggle.onchange = persist;
  fitButton.onclick = fit;
  resetButton.onclick = resetLayout;
  const resize = new ResizeObserver(() => { if (active && view) transform(); });
  resize.observe(viewport);

  return {
    setActive, fit, zoomByFactor, refreshWeights,
    // Read-only geometry and counters support reproducible browser acceptance checks.
    inspect: () => ({ scene: view?.scene, camera: view?.camera, scopePath: view?.graph.scopePath, expanded: [...(view?.expanded || [])], loading, metrics: { ...metrics } }),
    dispose() { persist(); cancelPending(); endGesture(); clearTimeout(cardTimer); clearTimeout(cardShowTimer); resize.disconnect(); host.replaceChildren(); },
  };
}
