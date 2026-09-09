import type { Box, Point, SceneEdge, SceneNode, ScenePort, SchematicScene } from './schematic-types.js';

export const GRID = 12;
export const CLEARANCE = 12;
const CELL_SIZE = 192;
const BEND_COST = 24;
const CROSSING_COST = 36;
const EPSILON = 0.001;

export function inflateBox(box: Box, padding = CLEARANCE): Box {
  return { x: box.x - padding, y: box.y - padding, width: box.width + padding * 2, height: box.height + padding * 2 };
}

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.width - EPSILON && a.x + a.width > b.x + EPSILON
    && a.y < b.y + b.height - EPSILON && a.y + a.height > b.y + EPSILON;
}

function segmentBox(a: Point, b: Point): Box {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}

export function segmentIntersectsBox(a: Point, b: Point, box: Box): boolean {
  if (a.x === b.x) {
    return a.x > box.x + EPSILON && a.x < box.x + box.width - EPSILON
      && Math.max(a.y, b.y) > box.y + EPSILON && Math.min(a.y, b.y) < box.y + box.height - EPSILON;
  }
  if (a.y === b.y) {
    return a.y > box.y + EPSILON && a.y < box.y + box.height - EPSILON
      && Math.max(a.x, b.x) > box.x + EPSILON && Math.min(a.x, b.x) < box.x + box.width - EPSILON;
  }
  return true;
}

export function isOrthogonal(points: readonly Point[]): boolean {
  return points.length >= 2 && points.every(point => Number.isFinite(point.x) && Number.isFinite(point.y))
    && points.slice(1).every((point, index) => point.x === points[index].x || point.y === points[index].y);
}

function samePoint(a: Point, b: Point): boolean { return a.x === b.x && a.y === b.y; }

function simplify(points: readonly Point[]): Point[] {
  const result: Point[] = [];
  for (const point of points) {
    if (result.length && samePoint(result[result.length - 1], point)) continue;
    while (result.length >= 2) {
      const a = result[result.length - 2];
      const b = result[result.length - 1];
      const straightX = a.x === b.x && b.x === point.x && (b.y - a.y) * (point.y - b.y) >= 0;
      const straightY = a.y === b.y && b.y === point.y && (b.x - a.x) * (point.x - b.x) >= 0;
      if (!straightX && !straightY) break;
      result.pop();
    }
    result.push({ ...point });
  }
  return result;
}

/** Retained spatial hashes bound drag work to nearby boxes and intersected segments. */
class SpatialIndex {
  private cells = new Map<string, Set<string>>();
  private entries = new Map<string, { box: Box; cells: string[] }>();

  private keys(box: Box): string[] {
    const keys: string[] = [];
    for (let x = Math.floor(box.x / CELL_SIZE); x <= Math.floor((box.x + box.width) / CELL_SIZE); x++) {
      for (let y = Math.floor(box.y / CELL_SIZE); y <= Math.floor((box.y + box.height) / CELL_SIZE); y++) keys.push(`${x},${y}`);
    }
    return keys;
  }

  remove(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    for (const key of entry.cells) {
      const cell = this.cells.get(key)!;
      cell.delete(id);
      if (cell.size === 0) this.cells.delete(key);
    }
    this.entries.delete(id);
  }

  set(id: string, box: Box): void {
    this.remove(id);
    const keys = this.keys(box);
    this.entries.set(id, { box, cells: keys });
    for (const key of keys) {
      let cell = this.cells.get(key);
      if (!cell) { cell = new Set(); this.cells.set(key, cell); }
      cell.add(id);
    }
  }

  query(box: Box): Set<string> {
    const result = new Set<string>();
    for (const key of this.keys(box)) {
      for (const id of this.cells.get(key) ?? []) {
        const candidate = this.entries.get(id)!.box;
        if (candidate.x <= box.x + box.width && candidate.x + candidate.width >= box.x
          && candidate.y <= box.y + box.height && candidate.y + candidate.height >= box.y) result.add(id);
      }
    }
    return result;
  }
}

interface QueueItem { state: number; cost: number; priority: number }
class MinHeap {
  private items: QueueItem[] = [];
  get size(): number { return this.items.length; }
  push(item: QueueItem): void {
    let index = this.items.length;
    this.items.push(item);
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.items[parent].priority <= item.priority) break;
      this.items[index] = this.items[parent];
      index = parent;
    }
    this.items[index] = item;
  }
  pop(): QueueItem {
    const first = this.items[0];
    const last = this.items.pop()!;
    if (this.items.length === 0) return first;
    let index = 0;
    while (index * 2 + 1 < this.items.length) {
      let child = index * 2 + 1;
      if (child + 1 < this.items.length && this.items[child + 1].priority < this.items[child].priority) child++;
      if (this.items[child].priority >= last.priority) break;
      this.items[index] = this.items[child];
      index = child;
    }
    this.items[index] = last;
    return first;
  }
}

interface Anchor { point: Point; escape: Point; side: 'WEST' | 'EAST' }

const MAX_HEURISTIC_EDGES = 320;

export interface ResizeResult {
  nodeIds: string[];
  edgeIds: string[];
  previousBoxes: Map<string, Box>;
}

export class OrthogonalRouter {
  private nodes = new Map<string, SceneNode>();
  private edges = new Map<string, SceneEdge>();
  private ports = new Map<string, Map<string, ScenePort>>();
  private adjacency = new Map<string, Set<string>>();
  private nodeIndex = new SpatialIndex();
  private segmentIndex = new SpatialIndex();
  private segments = new Map<string, { edgeId: string; a: Point; b: Point }>();
  private edgeSegments = new Map<string, string[]>();

  constructor(readonly scene: SchematicScene) {
    for (const node of scene.nodes) {
      this.nodes.set(node.id, node);
      this.ports.set(node.id, new Map(node.ports.map(port => [port.id, port])));
      this.nodeIndex.set(node.id, inflateBox(node));
      this.adjacency.set(node.id, new Set());
    }
    for (const edge of scene.edges) {
      this.edges.set(edge.id, edge);
      this.adjacency.get(edge.source.nodeId)?.add(edge.id);
      this.adjacency.get(edge.target.nodeId)?.add(edge.id);
      if (edge.points.length) this.indexEdge(edge);
    }
  }

  private anchor(endpoint: SceneEdge['source']): Anchor {
    const node = this.nodes.get(endpoint.nodeId);
    const port = this.ports.get(endpoint.nodeId)?.get(endpoint.portId);
    if (!node || !port) throw new Error(`Missing endpoint ${endpoint.nodeId}/${endpoint.portId}`);
    const point = { x: node.x + port.x, y: node.y + port.y };
    return { point, side: port.side, escape: { x: point.x + (port.side === 'WEST' ? -CLEARANCE : CLEARANCE), y: point.y } };
  }

  private clearSegment(a: Point, b: Point, ignored?: string): boolean {
    if (a.x !== b.x && a.y !== b.y) return false;
    for (const id of this.nodeIndex.query(segmentBox(a, b))) {
      if (id !== ignored && segmentIntersectsBox(a, b, inflateBox(this.nodes.get(id)!))) return false;
    }
    return true;
  }

  /** Empty results mean exact anchors, orthogonal segments, and required box clearance. */
  validateEdge(edge: SceneEdge, points: readonly Point[] = edge.points): string[] {
    const errors: string[] = [];
    if (!isOrthogonal(points)) return ['Non-orthogonal or empty route'];
    const source = this.anchor(edge.source);
    const target = this.anchor(edge.target);
    if (!samePoint(points[0], source.point) || !samePoint(points[points.length - 1], target.point)) errors.push('Endpoint detached');
    const startsOutward = points[1].y === source.point.y
      && (points[1].x - source.point.x) * (source.side === 'WEST' ? -1 : 1) >= CLEARANCE;
    const beforeEnd = points[points.length - 2];
    const endsOutward = beforeEnd.y === target.point.y
      && (beforeEnd.x - target.point.x) * (target.side === 'WEST' ? -1 : 1) >= CLEARANCE;
    if (!startsOutward || !endsOutward) errors.push('Port escape is too short or on the wrong side');
    for (let index = 1; index < points.length; index++) {
      const a = points[index - 1];
      const b = points[index];
      for (const id of this.nodeIndex.query(segmentBox(a, b))) {
        if (index === 1 && id === edge.source.nodeId && startsOutward) continue;
        if (index === points.length - 1 && id === edge.target.nodeId && endsOutward) continue;
        if (segmentIntersectsBox(a, b, inflateBox(this.nodes.get(id)!))) errors.push(`Clearance violation: ${id}`);
      }
    }
    return errors;
  }

  private unindexEdge(edgeId: string): void {
    for (const key of this.edgeSegments.get(edgeId) ?? []) {
      this.segmentIndex.remove(key);
      this.segments.delete(key);
    }
    this.edgeSegments.delete(edgeId);
  }

  private indexEdge(edge: SceneEdge): void {
    this.unindexEdge(edge.id);
    const keys: string[] = [];
    for (let index = 1; index < edge.points.length; index++) {
      const key = JSON.stringify([edge.id, index]);
      const a = edge.points[index - 1];
      const b = edge.points[index];
      this.segmentIndex.set(key, segmentBox(a, b));
      this.segments.set(key, { edgeId: edge.id, a, b });
      keys.push(key);
    }
    this.edgeSegments.set(edge.id, keys);
  }

  private crossingCost(a: Point, b: Point, edgeId: string): number {
    let cost = 0;
    for (const key of this.segmentIndex.query(segmentBox(a, b))) {
      const segment = this.segments.get(key)!;
      if (segment.edgeId === edgeId) continue;
      if (samePoint(a, segment.a) || samePoint(a, segment.b) || samePoint(b, segment.a) || samePoint(b, segment.b)) continue;
      const horizontal = a.y === b.y;
      const otherHorizontal = segment.a.y === segment.b.y;
      if (horizontal !== otherHorizontal) cost += CROSSING_COST;
      else if ((horizontal && a.y === segment.a.y) || (!horizontal && a.x === segment.a.x)) cost += CROSSING_COST * 2;
    }
    return cost;
  }

  private pathCost(points: readonly Point[], edgeId: string, includeCrossings = true): number {
    let cost = Math.max(0, points.length - 2) * BEND_COST;
    for (let index = 1; index < points.length; index++) {
      cost += Math.abs(points[index].x - points[index - 1].x) + Math.abs(points[index].y - points[index - 1].y);
      if (includeCrossings) cost += this.crossingCost(points[index - 1], points[index], edgeId);
    }
    return cost;
  }

  /** Search a coordinate-compressed rectilinear grid, creating states only when visited. */
  private search(start: Point, end: Point, edgeId: string, includeCrossings = true): Point[] {
    if (samePoint(start, end)) return [start];
    const localMargins = [96, 384, 1536];
    for (let attempt = 0; attempt <= localMargins.length; attempt++) {
      const globalSearch = attempt === localMargins.length;
      let region = segmentBox(start, end);
      if (globalSearch) {
        // A finite wall can exceed every local window. Include the complete obstacle
        // extent so the final search always has coordinates in the exterior channels.
        let right = region.x + region.width;
        let bottom = region.y + region.height;
        for (const node of this.nodes.values()) {
          region.x = Math.min(region.x, node.x);
          region.y = Math.min(region.y, node.y);
          right = Math.max(right, node.x + node.width);
          bottom = Math.max(bottom, node.y + node.height);
        }
        region.width = right - region.x;
        region.height = bottom - region.y;
        region = inflateBox(region, CLEARANCE * 2);
      } else {
        region = inflateBox(region, localMargins[attempt]);
      }
      const xs = new Set([start.x, end.x, (start.x + end.x) / 2, region.x, region.x + region.width]);
      const ys = new Set([start.y, end.y, (start.y + end.y) / 2, region.y, region.y + region.height]);
      // Avoid visiting empty spatial-hash cells across a sparse global bounding box.
      const obstacleIds = globalSearch ? this.nodes.keys() : this.nodeIndex.query(region);
      for (const id of obstacleIds) {
        const box = inflateBox(this.nodes.get(id)!);
        for (const x of [box.x, box.x + box.width]) if (x >= region.x && x <= region.x + region.width) xs.add(x);
        for (const y of [box.y, box.y + box.height]) if (y >= region.y && y <= region.y + region.height) ys.add(y);
      }
      const xValues = [...xs].sort((a, b) => a - b);
      const yValues = [...ys].sort((a, b) => a - b);
      const columns = xValues.length;
      const startCell = yValues.indexOf(start.y) * columns + xValues.indexOf(start.x);
      const endCell = yValues.indexOf(end.y) * columns + xValues.indexOf(end.x);
      const queue = new MinHeap();
      const costs = new Map<number, number>([[startCell * 3, 0]]);
      const previous = new Map<number, number>();
      const clearCache = new Map<string, boolean>();
      queue.push({ state: startCell * 3, cost: 0, priority: 0 });
      let visits = 0;
      // Bound speculative local attempts, but let the finite final graph exhaust its
      // reachable states before declaring that a clearance-safe path does not exist.
      while (queue.size && (globalSearch || visits++ < 60000)) {
        const current = queue.pop();
        if (current.cost !== costs.get(current.state)) continue;
        const cell = Math.floor(current.state / 3);
        const direction = current.state % 3;
        const x = cell % columns;
        const y = Math.floor(cell / columns);
        if (cell === endCell) {
          const points: Point[] = [];
          let state: number | undefined = current.state;
          while (state !== undefined) {
            const index = Math.floor(state / 3);
            points.push({ x: xValues[index % columns], y: yValues[Math.floor(index / columns)] });
            state = previous.get(state);
          }
          return simplify(points.reverse());
        }
        const a = { x: xValues[x], y: yValues[y] };
        const neighbors: [number, number, number][] = [[x - 1, y, 1], [x + 1, y, 1], [x, y - 1, 2], [x, y + 1, 2]];
        for (const [nx, ny, nextDirection] of neighbors) {
          if (nx < 0 || nx >= columns || ny < 0 || ny >= yValues.length) continue;
          const nextCell = ny * columns + nx;
          const b = { x: xValues[nx], y: yValues[ny] };
          const key = cell < nextCell ? `${cell}:${nextCell}` : `${nextCell}:${cell}`;
          let clear = clearCache.get(key);
          if (clear === undefined) { clear = this.clearSegment(a, b); clearCache.set(key, clear); }
          if (!clear) continue;
          const bend = direction !== 0 && direction !== nextDirection ? BEND_COST : 0;
          const crossing = includeCrossings ? this.crossingCost(a, b, edgeId) : 0;
          const cost = current.cost + Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + bend + crossing;
          const nextState = nextCell * 3 + nextDirection;
          if (cost >= (costs.get(nextState) ?? Infinity)) continue;
          costs.set(nextState, cost);
          previous.set(nextState, current.state);
          queue.push({ state: nextState, cost, priority: cost + Math.abs(b.x - end.x) + Math.abs(b.y - end.y) });
        }
      }
    }
    throw new Error(`No clearance-safe orthogonal route for ${edgeId}`);
  }

  // Interactive edits retain valid channels first and minimize length and bends.
  // Rescoring crossings against the entire retained wire index at every A* step
  // dominates dense-graph drag time; crossing costs are used on initial routing.
  private route(edge: SceneEdge, interactive = false): Point[] {
    const source = this.anchor(edge.source);
    const target = this.anchor(edge.target);
    // Preserve the existing channels when an endpoint moves a small distance.
    if (edge.points.length >= 4) {
      const repaired = edge.points.map(point => ({ ...point }));
      repaired[0] = source.point;
      repaired[1].y = source.point.y;
      repaired[repaired.length - 1] = target.point;
      repaired[repaired.length - 2].y = target.point.y;
      if (this.validateEdge(edge, repaired).length === 0) return simplify(repaired);
    }
    const a = source.escape;
    const b = target.escape;
    const candidates: Point[][] = [];
    for (const x of [a.x, b.x, (a.x + b.x) / 2]) candidates.push([source.point, a, { x, y: a.y }, { x, y: b.y }, b, target.point]);
    for (const y of [a.y, b.y, Math.min(a.y, b.y) - 48, Math.max(a.y, b.y) + 48]) candidates.push([source.point, a, { x: a.x, y }, { x: b.x, y }, b, target.point]);
    let best: Point[] | undefined;
    let bestCost = Infinity;
    for (const candidate of candidates) {
      const points = simplify(candidate);
      if (this.validateEdge(edge, points).length) continue;
      const cost = this.pathCost(points, edge.id, !interactive);
      if (cost < bestCost) { best = points; bestCost = cost; }
    }
    if (best) return best;
    const points = simplify([source.point, ...this.search(a, b, edge.id, !interactive), target.point]);
    const errors = this.validateEdge(edge, points);
    if (errors.length) throw new Error(`${edge.id}: ${errors.join('; ')}`);
    return points;
  }

  /** Route dependencies that point back toward an earlier layer through an outer lane. */
  rerouteFeedbackEdges(): string[] {
    const minY = Math.min(...[...this.nodes.values()].map(node => node.y));
    const maxY = Math.max(...[...this.nodes.values()].map(node => node.y + node.height));
    const lanes = [minY - CLEARANCE * 5, maxY + CLEARANCE * 5];
    const changed: string[] = [];
    for (const edge of this.edges.values()) {
      const sourceNode = this.nodes.get(edge.source.nodeId);
      const targetNode = this.nodes.get(edge.target.nodeId);
      if (!sourceNode || !targetNode || sourceNode.x <= targetNode.x + targetNode.width / 2) continue;
      const source = this.anchor(edge.source);
      const target = this.anchor(edge.target);
      for (const lane of lanes) {
        const candidate = simplify([
          source.point, source.escape,
          { x: source.escape.x, y: lane },
          { x: target.escape.x, y: lane },
          target.escape, target.point,
        ]);
        if (this.validateEdge(edge, candidate).length !== 0) continue;
        edge.points = candidate;
        this.indexEdge(edge);
        changed.push(edge.id);
        break;
      }
    }
    this.updateBounds();
    return changed;
  }

  private isFeedback(edge: SceneEdge): boolean {
    const source = this.nodes.get(edge.source.nodeId);
    const target = this.nodes.get(edge.target.nodeId);
    return !!source && !!target && source.x > target.x + target.width / 2;
  }

  private routingOrder(): SceneEdge[] {
    return [...this.edges.values()].sort((a, b) => {
      const feedbackOrder = Number(this.isFeedback(a)) - Number(this.isFeedback(b));
      if (feedbackOrder !== 0) return feedbackOrder;
      const aSource = this.nodes.get(a.source.nodeId)!;
      const aTarget = this.nodes.get(a.target.nodeId)!;
      const bSource = this.nodes.get(b.source.nodeId)!;
      const bTarget = this.nodes.get(b.target.nodeId)!;
      const aDistance = Math.abs(aSource.x - aTarget.x) + Math.abs(aSource.y - aTarget.y);
      const bDistance = Math.abs(bSource.x - bTarget.x) + Math.abs(bSource.y - bTarget.y);
      return bDistance - aDistance || a.id.localeCompare(b.id);
    });
  }

  /**
   * Route all initial edges. Full channel optimization is bounded to small
   * scenes because crossing costs inspect previously routed segments. Dense
   * scenes retain ELK's valid routes and only pay for required repairs.
   */
  routeAll(optimize = false): void {
    if (!optimize || this.edges.size > MAX_HEURISTIC_EDGES) {
      for (const edge of this.scene.edges) {
        if (this.validateEdge(edge).length === 0) continue;
        edge.points = this.route(edge);
        this.indexEdge(edge);
      }
      this.updateBounds();
      return;
    }

    for (const edge of this.edges.values()) {
      edge.points = [];
      this.unindexEdge(edge.id);
    }
    for (const edge of this.routingOrder()) {
      edge.points = this.route(edge);
      this.indexEdge(edge);
    }

    // One improvement pass removes avoidable crossings introduced by the
    // backbone order without allowing routes to oscillate indefinitely.
    for (const edge of this.routingOrder()) {
      const original = edge.points;
      const originalCost = this.pathCost(original, edge.id);
      this.unindexEdge(edge.id);
      edge.points = [];
      try {
        const candidate = this.route(edge);
        const candidateCost = this.pathCost(candidate, edge.id);
        if (candidateCost < originalCost) edge.points = candidate;
        else edge.points = original;
      } catch {
        edge.points = original;
      }
      this.indexEdge(edge);
    }
    this.updateBounds();
  }

  private updateBounds(): void {
    let right = 0;
    let bottom = 0;
    for (const node of this.scene.nodes) { right = Math.max(right, node.x + node.width); bottom = Math.max(bottom, node.y + node.height); }
    for (const edge of this.scene.edges) for (const point of edge.points) { right = Math.max(right, point.x); bottom = Math.max(bottom, point.y); }
    this.scene.width = right + 32;
    this.scene.height = bottom + 32;
  }

  /** Mutates only moved nodes and dirty routes. Rejected collisions leave the scene untouched. */
  moveNode(id: string, x: number, y: number): { nodeIds: string[]; edgeIds: string[] } {
    const node = this.nodes.get(id);
    const unchanged = { nodeIds: [], edgeIds: [] };
    if (!node || !Number.isFinite(x) || !Number.isFinite(y) || (node.x === x && node.y === y)) return unchanged;
    const nextBox = { ...node, x, y };
    for (const other of this.nodeIndex.query(inflateBox(nextBox))) {
      if (other !== id && overlaps(inflateBox(nextBox), inflateBox(this.nodes.get(other)!))) return unchanged;
    }
    const dirty = new Set(this.adjacency.get(id));
    for (const key of this.segmentIndex.query(inflateBox(nextBox))) dirty.add(this.segments.get(key)!.edgeId);
    const oldPosition = { x: node.x, y: node.y };
    const oldPaths = new Map<string, Point[]>();
    node.x = x;
    node.y = y;
    this.nodeIndex.set(id, inflateBox(node));
    try {
      for (const edgeId of dirty) {
        const edge = this.edges.get(edgeId)!;
        if (this.validateEdge(edge).length === 0) continue;
        oldPaths.set(edgeId, edge.points);
        edge.points = this.route(edge, true);
        this.indexEdge(edge);
      }
    } catch {
      // A congested drag is rejected atomically instead of publishing invalid geometry.
      Object.assign(node, oldPosition);
      this.nodeIndex.set(id, inflateBox(node));
      for (const [edgeId, points] of oldPaths) {
        const edge = this.edges.get(edgeId)!;
        edge.points = points;
        this.indexEdge(edge);
      }
      return unchanged;
    }
    return { nodeIds: [id], edgeIds: [...oldPaths.keys()] };
  }

  /**
   * Resize at a fixed top-left anchor. Collisions push neighbors monotonically
   * along the growing axis; routing sees the complete proposed geometry at once.
   * Any routing failure restores geometry, port lookup, and both spatial indexes.
   */
  resizeNode(
    id: string,
    geometry: Pick<SceneNode, 'width' | 'height' | 'ports'> & Partial<Pick<SceneNode, 'x' | 'y'>>,
  ): ResizeResult {
    const node = this.nodes.get(id);
    if (!node) throw new Error(`Cannot resize missing node ${id}`);
    if (![node.x, node.y, geometry.width, geometry.height].every(Number.isFinite)
      || geometry.width <= 0 || geometry.height <= 0) {
      throw new Error(`Invalid resize geometry for ${id}`);
    }
    const oldPorts = this.ports.get(id)!;
    const nextPorts = new Map(geometry.ports.map(port => [port.id, port]));
    if (nextPorts.size !== oldPorts.size || nextPorts.size !== geometry.ports.length
      || geometry.ports.some(port => {
        const original = oldPorts.get(port.id);
        return !original || port.side !== original.side || port.width !== original.width
          || port.direction !== original.direction || !Number.isFinite(port.x) || !Number.isFinite(port.y)
          || port.x !== (port.side === 'WEST' ? 0 : geometry.width)
          || port.y < 0 || port.y > geometry.height;
      })) {
      throw new Error(`Invalid resize ports for ${id}`);
    }

    // Overlay only changed boxes on the retained index. No scene mutation occurs
    // during placement, and unchanged nodes never need to be copied or reindexed.
    const planned = new Map<string, Box>([[id, {
      x: geometry.x ?? node.x, y: geometry.y ?? node.y,
      width: geometry.width, height: geometry.height,
    }]]);
    const plannedIndex = new SpatialIndex();
    plannedIndex.set(id, inflateBox(planned.get(id)!));
    const pending = [id];
    const queued = new Set(pending);
    for (let cursor = 0; cursor < pending.length; cursor++) {
      const movingId = pending[cursor];
      queued.delete(movingId);
      const box = planned.get(movingId)!;
      const padded = inflateBox(box);
      const neighbors = this.nodeIndex.query(padded);
      for (const neighborId of plannedIndex.query(padded)) neighbors.add(neighborId);
      for (const neighborId of neighbors) {
        if (neighborId === movingId) continue;
        const neighbor = planned.get(neighborId) ?? this.nodes.get(neighborId)!;
        if (!overlaps(padded, inflateBox(neighbor))) continue;
        if (neighborId === id) throw new Error(`Cannot preserve resize anchor for ${id}`);
        const next = { x: neighbor.x, y: neighbor.y, width: neighbor.width, height: neighbor.height };
        const rightX = box.x + box.width + CLEARANCE * 2;
        const downY = box.y + box.height + CLEARANCE * 2;
        const rightDistance = Math.max(0, rightX - neighbor.x);
        const downDistance = Math.max(0, downY - neighbor.y);
        const oldMoving = this.nodes.get(movingId)!;
        const wasRightNeighbor = neighbor.x >= oldMoving.x + oldMoving.width;
        const wasBelowNeighbor = neighbor.y >= oldMoving.y + oldMoving.height;
        const neighborCenterX = neighbor.x + neighbor.width / 2;
        const neighborCenterY = neighbor.y + neighbor.height / 2;
        const preferRight = wasRightNeighbor || (!wasBelowNeighbor && neighborCenterX >= box.x + box.width / 2);
        const preferDown = wasBelowNeighbor || (!wasRightNeighbor && neighborCenterY >= box.y + box.height / 2);
        if (preferRight && !preferDown) next.x = rightX;
        else if (preferDown && !preferRight) next.y = downY;
        else if (rightDistance <= downDistance) next.x = rightX;
        else next.y = downY;
        if (!Number.isFinite(next.x) || !Number.isFinite(next.y)) throw new Error(`Resize overflow for ${id}`);
        planned.set(neighborId, next);
        plannedIndex.set(neighborId, inflateBox(next));
        if (!queued.has(neighborId)) {
          pending.push(neighborId);
          queued.add(neighborId);
        }
      }
    }

    const dirty = new Set<string>();
    const previousBoxes = new Map<string, Box>();
    const previousPaths = new Map<string, Point[]>();
    const previousPorts = node.ports;
    for (const [nodeId, box] of planned) {
      const changed = this.nodes.get(nodeId)!;
      previousBoxes.set(nodeId, { x: changed.x, y: changed.y, width: changed.width, height: changed.height });
      for (const edgeId of this.adjacency.get(nodeId)!) dirty.add(edgeId);
      const padded = inflateBox(box);
      for (const key of this.segmentIndex.query(padded)) {
        const segment = this.segments.get(key)!;
        if (segmentIntersectsBox(segment.a, segment.b, padded)) dirty.add(segment.edgeId);
      }
    }

    try {
      for (const [nodeId, box] of planned) {
        Object.assign(this.nodes.get(nodeId)!, box);
        this.nodeIndex.set(nodeId, inflateBox(box));
      }
      node.ports = geometry.ports;
      this.ports.set(id, nextPorts);
      const routedTerminals = new Map<string, Point[]>();
      for (const edgeId of dirty) {
        const edge = this.edges.get(edgeId)!;
        const source = this.anchor(edge.source).point;
        const target = this.anchor(edge.target).point;
        const key = JSON.stringify([edge.source.nodeId, source, edge.target.nodeId, target, edge.status]);
        let points = routedTerminals.get(key);
        if (!points) {
          points = this.validateEdge(edge).length === 0 ? edge.points : this.route(edge, true);
          const errors = this.validateEdge(edge, points);
          if (errors.length) throw new Error(`${edgeId}: ${errors.join('; ')}`);
          routedTerminals.set(key, points);
        }
        // Collapsed interface pins now share endpoints. Restore a common bus
        // channel even when their individual expanded paths were still valid.
        if (edge.points === points) continue;
        previousPaths.set(edgeId, edge.points);
        edge.points = points;
        this.indexEdge(edge);
      }
    } catch (error) {
      for (const [nodeId, box] of previousBoxes) {
        Object.assign(this.nodes.get(nodeId)!, box);
        this.nodeIndex.set(nodeId, inflateBox(box));
      }
      node.ports = previousPorts;
      this.ports.set(id, oldPorts);
      for (const [edgeId, points] of previousPaths) {
        const edge = this.edges.get(edgeId)!;
        edge.points = points;
        this.indexEdge(edge);
      }
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Cannot resize ${id}: ${reason}`, { cause: error });
    }

    // Like dragging, collapsing keeps the existing viewport extent. Grow it only
    // from changed geometry instead of rescanning every path in the graph.
    for (const box of planned.values()) {
      this.scene.width = Math.max(this.scene.width, box.x + box.width + 32);
      this.scene.height = Math.max(this.scene.height, box.y + box.height + 32);
    }
    for (const edgeId of previousPaths.keys()) {
      for (const point of this.edges.get(edgeId)!.points) {
        this.scene.width = Math.max(this.scene.width, point.x + 32);
        this.scene.height = Math.max(this.scene.height, point.y + 32);
      }
    }
    return { nodeIds: [...planned.keys()], edgeIds: [...previousPaths.keys()], previousBoxes };
  }

  /** Drag a wire synchronously. A long straight wire gains an interior dogleg. */
  moveSegment(edgeId: string, segmentIndex: number, coordinate: number): string[] {
    const edge = this.edges.get(edgeId);
    if (!edge || !Number.isFinite(coordinate)) return [];
    if (edge.points.length === 2 && segmentIndex === 0) {
      const [start, end] = edge.points;
      if (start.y !== end.y || start.y === coordinate || Math.abs(end.x - start.x) < CLEARANCE * 4) return [];
      const source = this.anchor(edge.source);
      const target = this.anchor(edge.target);
      const a = { x: source.escape.x, y: coordinate };
      const b = { x: target.escape.x, y: coordinate };
      if (!this.clearSegment(a, b)) return [];
      let points = simplify([start, source.escape, a, b, target.escape, end]);
      if (this.validateEdge(edge, points).length) {
        try {
          points = simplify([start, ...this.search(source.escape, a, edgeId, false), ...this.search(b, target.escape, edgeId, false), end]);
        } catch { return []; }
        if (this.validateEdge(edge, points).length) return [];
      }
      edge.points = points;
      this.indexEdge(edge);
      return [edgeId];
    }
    if (segmentIndex < 1 || segmentIndex >= edge.points.length - 2) return [];
    const points = edge.points.map(point => ({ ...point }));
    const a = points[segmentIndex];
    const b = points[segmentIndex + 1];
    const vertical = a.x === b.x;
    if ((vertical ? a.x : a.y) === coordinate) return [];
    if (vertical) { a.x = coordinate; b.x = coordinate; }
    else { a.y = coordinate; b.y = coordinate; }
    let repaired = simplify(points);
    if (this.validateEdge(edge, repaired).length) {
      if (!this.clearSegment(a, b)) return [];
      const source = this.anchor(edge.source);
      const target = this.anchor(edge.target);
      try {
        repaired = simplify([
          source.point, ...this.search(source.escape, a, edge.id, false),
          ...this.search(b, target.escape, edge.id, false), target.point,
        ]);
      } catch { return []; }
      if (this.validateEdge(edge, repaired).length) return [];
    }
    edge.points = repaired;
    this.indexEdge(edge);
    return [edgeId];
  }
}

export function validateRoutes(scene: SchematicScene): string[] {
  const router = new OrthogonalRouter(scene);
  return scene.edges.flatMap(edge => router.validateEdge(edge).map(error => `${edge.id}: ${error}`));
}
