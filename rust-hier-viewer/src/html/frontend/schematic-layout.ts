import ELK from 'elkjs/lib/elk.bundled.js';
import type {
  ElkEdgeSection,
  ElkExtendedEdge,
  ElkNode,
  ElkPoint,
  ElkPort,
} from 'elkjs/lib/elk-api.js';
import { CLEARANCE, OrthogonalRouter, inflateBox } from './schematic-routing.js';
import type { Point, SceneNode, ScenePort, SchematicScene } from './schematic-types.js';

export type ElkLayout = (graph: ElkNode) => Promise<ElkNode>;

interface VisualPort {
  id: string;
  rawPort: ScenePort;
}

interface EdgeBundle {
  id: string;
  sourcePortId: string;
  targetPortId: string;
  rawEdgeIndices: number[];
}

interface ExpectedPortGeometry {
  id: string;
  x: number;
  y: number;
}

interface ExpectedNodeGeometry {
  sceneNodeId: string;
  width: number;
  height: number;
  ports: ExpectedPortGeometry[];
}

interface ElkInput {
  graph: ElkNode;
  nodeGeometryByElkId: Map<string, ExpectedNodeGeometry>;
  edgeBundles: EdgeBundle[];
}

const NODE_SPACING = 48;
const EDGE_NODE_SPACING = 12;
const GEOMETRY_EPSILON = 0.001;

let defaultEngine: InstanceType<typeof ELK> | undefined;

function runDefaultLayout(graph: ElkNode): Promise<ElkNode> {
  if (!defaultEngine) {
    // The bundled engine detects a dedicated worker by the absence of document.
    // We already own that worker's message protocol, so instantiate its in-process
    // worker adapter instead of letting ELK replace globalThis.onmessage.
    const context = globalThis as { document?: unknown };
    const needsAdapter = typeof self !== 'undefined' && context.document === undefined;
    if (needsAdapter) context.document = {};
    try {
      defaultEngine = new ELK({ algorithms: ['layered'] });
    } finally {
      if (needsAdapter) delete context.document;
    }
  }
  return defaultEngine.layout(graph) as Promise<ElkNode>;
}

function endpointKey(nodeId: string, portId: string): string {
  return JSON.stringify([nodeId, portId]);
}

function visualPortKey(port: ScenePort): string {
  return JSON.stringify([port.side, port.x, port.y]);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function closeEnough(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) <= GEOMETRY_EPSILON;
}

function validateScene(scene: SchematicScene): void {
  const portsByEndpoint = new Map<string, ScenePort>();
  const nodeIds = new Set<string>();

  for (const node of scene.nodes) {
    if (nodeIds.has(node.id)) throw new Error(`Duplicate schematic node ${node.id}`);
    nodeIds.add(node.id);

    if (!isFiniteNumber(node.width) || !isFiniteNumber(node.height)
      || node.width <= 0 || node.height <= 0) {
      throw new Error(`Invalid schematic dimensions for ${node.id}`);
    }

    const portIds = new Set<string>();
    for (const port of node.ports) {
      if (portIds.has(port.id)) throw new Error(`Duplicate schematic port ${node.id}/${port.id}`);
      portIds.add(port.id);

      if (!isFiniteNumber(port.x) || !isFiniteNumber(port.y)
        || port.x !== (port.side === 'WEST' ? 0 : node.width)
        || port.y < 0 || port.y > node.height) {
        throw new Error(`Invalid schematic port geometry for ${node.id}/${port.id}`);
      }
      portsByEndpoint.set(endpointKey(node.id, port.id), port);
    }
  }

  const edgeIds = new Set<string>();
  for (const edge of scene.edges) {
    if (edgeIds.has(edge.id)) throw new Error(`Duplicate schematic edge ${edge.id}`);
    edgeIds.add(edge.id);

    for (const endpoint of [edge.source, edge.target]) {
      if (!nodeIds.has(endpoint.nodeId)) {
        throw new Error(`Missing schematic node ${endpoint.nodeId} for ${edge.id}`);
      }
      if (!portsByEndpoint.has(endpointKey(endpoint.nodeId, endpoint.portId))) {
        throw new Error(`Missing schematic port ${endpoint.nodeId}/${endpoint.portId} for ${edge.id}`);
      }
    }
  }
}

function buildElkInput(scene: SchematicScene): ElkInput {
  validateScene(scene);
  const connectedEndpoints = new Set<string>();
  for (const edge of scene.edges) {
    connectedEndpoints.add(endpointKey(edge.source.nodeId, edge.source.portId));
    connectedEndpoints.add(endpointKey(edge.target.nodeId, edge.target.portId));
  }

  const nodeGeometryByElkId = new Map<string, ExpectedNodeGeometry>();
  const visualPortByEndpoint = new Map<string, VisualPort>();
  const children: ElkNode[] = [];

  for (const [nodeIndex, node] of scene.nodes.entries()) {
    const elkNodeId = `n${nodeIndex}`;

    const visualPorts = new Map<string, VisualPort>();
    for (const port of node.ports) {
      const rawEndpointKey = endpointKey(node.id, port.id);
      if (!connectedEndpoints.has(rawEndpointKey)) continue;

      const coordinateKey = visualPortKey(port);
      let visualPort = visualPorts.get(coordinateKey);
      if (!visualPort) {
        visualPort = {
          id: `p${nodeIndex}_${visualPorts.size}`,
          rawPort: port,
        };
        visualPorts.set(coordinateKey, visualPort);
      } else {
        // Keep the first physical port as the visual representative.
      }
      visualPortByEndpoint.set(rawEndpointKey, visualPort);
    }

    const ports: ElkPort[] = [...visualPorts.values()].map(({ id, rawPort }) => ({
      id,
      x: rawPort.x,
      y: rawPort.y,
      width: 0,
      height: 0,
      layoutOptions: {
        'elk.port.side': rawPort.side,
      },
    }));

    children.push({
      id: elkNodeId,
      width: node.width,
      height: node.height,
      ports,
      layoutOptions: {
        'elk.portConstraints': 'FIXED_POS',
        ...(node.kind === 'boundary' ? {
          'elk.layered.layering.layerConstraint': node.ports.every(port => port.direction === 'input') ? 'FIRST' : 'LAST',
        } : {}),
      },
    });
    nodeGeometryByElkId.set(elkNodeId, {
      sceneNodeId: node.id,
      width: node.width,
      height: node.height,
      ports: ports.map(port => ({ id: port.id, x: port.x!, y: port.y! })),
    });
  }

  const edgeBundleByKey = new Map<string, EdgeBundle>();
  for (const [edgeIndex, edge] of scene.edges.entries()) {
    const source = visualPortByEndpoint.get(endpointKey(edge.source.nodeId, edge.source.portId));
    const target = visualPortByEndpoint.get(endpointKey(edge.target.nodeId, edge.target.portId));
    if (!source || !target) throw new Error(`Missing visual port for ${edge.id}`);

    const bundleKey = JSON.stringify([source.id, target.id, edge.status]);
    let bundle = edgeBundleByKey.get(bundleKey);
    if (!bundle) {
      bundle = {
        id: `e${edgeBundleByKey.size}`,
        sourcePortId: source.id,
        targetPortId: target.id,
        rawEdgeIndices: [],
      };
      edgeBundleByKey.set(bundleKey, bundle);
    }
    bundle.rawEdgeIndices.push(edgeIndex);
  }

  const edgeBundles = [...edgeBundleByKey.values()];
  const edges: ElkExtendedEdge[] = edgeBundles.map(bundle => ({
    id: bundle.id,
    sources: [bundle.sourcePortId],
    targets: [bundle.targetPortId],
  }));

  return {
    graph: {
      id: 'root',
      children,
      edges,
      layoutOptions: {
        'elk.algorithm': 'layered',
        'elk.direction': 'RIGHT',
        'elk.edgeRouting': 'ORTHOGONAL',
        'elk.randomSeed': '1',
        'elk.padding': `[top=${CLEARANCE},left=${CLEARANCE},bottom=${CLEARANCE},right=${CLEARANCE}]`,
        'elk.spacing.nodeNode': String(NODE_SPACING),
        'elk.spacing.componentComponent': String(NODE_SPACING),
        'elk.spacing.edgeNode': String(EDGE_NODE_SPACING),
        'elk.layered.spacing.nodeNodeBetweenLayers': String(NODE_SPACING),
        'elk.layered.spacing.edgeNodeBetweenLayers': String(EDGE_NODE_SPACING),
        'elk.layered.spacing.edgeEdgeBetweenLayers': '24',
        'elk.layered.spacing.edgeEdge': '18',
        'elk.spacing.edgeEdge': '18',
        'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
        'elk.layered.considerModelOrder.portModelOrder': 'true',
      },
    },
    nodeGeometryByElkId,
    edgeBundles,
  };
}

function indexUnique<T extends { id?: string }>(items: readonly T[] | undefined, kind: string): Map<string, T> {
  const result = new Map<string, T>();
  for (const item of items ?? []) {
    if (!item.id) throw new Error(`ELK returned a ${kind} without an ID`);
    if (result.has(item.id)) throw new Error(`ELK returned duplicate ${kind} ${item.id}`);
    result.set(item.id, item);
  }
  return result;
}

function validatePortGeometry(expectedNode: ExpectedNodeGeometry, outputNode: ElkNode): void {
  const expectedPorts = new Map(expectedNode.ports.map(port => [port.id, port]));
  const outputPorts = indexUnique(outputNode.ports, 'port');
  if (outputPorts.size !== expectedPorts.size) {
    throw new Error(`ELK returned incomplete ports for ${expectedNode.sceneNodeId}`);
  }

  for (const [portId, expectedPort] of expectedPorts) {
    const outputPort = outputPorts.get(portId);
    if (!outputPort
      || !isFiniteNumber(outputPort.x) || !isFiniteNumber(outputPort.y)
      || !isFiniteNumber(outputPort.width) || !isFiniteNumber(outputPort.height)
      || !closeEnough(outputPort.x, expectedPort.x)
      || !closeEnough(outputPort.y, expectedPort.y)
      || !closeEnough(outputPort.width, 0)
      || !closeEnough(outputPort.height, 0)) {
      throw new Error(`ELK changed fixed port geometry for ${portId}`);
    }
  }
}

function applyNodeGeometry(input: ElkInput, output: ElkNode, workingScene: SchematicScene): void {
  if (!isFiniteNumber(output.width) || !isFiniteNumber(output.height)
    || output.width <= 0 || output.height <= 0) {
    throw new Error('ELK returned invalid graph bounds');
  }

  const outputNodes = indexUnique(output.children, 'node');
  if (outputNodes.size !== input.nodeGeometryByElkId.size) {
    throw new Error('ELK returned an incomplete node set');
  }

  const sceneNodeById = new Map(workingScene.nodes.map(node => [node.id, node]));
  for (const [elkNodeId, expectedNode] of input.nodeGeometryByElkId) {
    const outputNode = outputNodes.get(elkNodeId);
    const sceneNode = sceneNodeById.get(expectedNode.sceneNodeId);
    if (!outputNode || !sceneNode
      || !isFiniteNumber(outputNode.x) || !isFiniteNumber(outputNode.y)
      || !isFiniteNumber(outputNode.width) || !isFiniteNumber(outputNode.height)
      || !closeEnough(outputNode.width, expectedNode.width)
      || !closeEnough(outputNode.height, expectedNode.height)) {
      throw new Error(`ELK returned invalid geometry for ${expectedNode.sceneNodeId}`);
    }

    validatePortGeometry(expectedNode, outputNode);
    sceneNode.x = outputNode.x;
    sceneNode.y = outputNode.y;

    if (sceneNode.x < -GEOMETRY_EPSILON || sceneNode.y < -GEOMETRY_EPSILON
      || sceneNode.x + sceneNode.width > output.width + GEOMETRY_EPSILON
      || sceneNode.y + sceneNode.height > output.height + GEOMETRY_EPSILON) {
      throw new Error(`ELK placed ${sceneNode.id} outside graph bounds`);
    }
  }
}

function validateNodeSpacing(nodes: readonly SceneNode[]): void {
  const boxes = nodes
    .map(node => ({ id: node.id, box: inflateBox(node) }))
    .sort((a, b) => a.box.x - b.box.x || a.box.y - b.box.y || a.id.localeCompare(b.id));

  for (let leftIndex = 0; leftIndex < boxes.length; leftIndex++) {
    const left = boxes[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < boxes.length; rightIndex++) {
      const right = boxes[rightIndex];
      if (right.box.x >= left.box.x + left.box.width - GEOMETRY_EPSILON) break;
      const verticallySeparate = left.box.y + left.box.height <= right.box.y + GEOMETRY_EPSILON
        || right.box.y + right.box.height <= left.box.y + GEOMETRY_EPSILON;
      if (!verticallySeparate) {
        throw new Error(`ELK nodes overlap required clearance: ${left.id} and ${right.id}`);
      }
    }
  }
}

function finitePoint(point: ElkPoint | undefined, edgeId: string): Point {
  if (!point || !isFiniteNumber(point.x) || !isFiniteNumber(point.y)) {
    throw new Error(`ELK returned invalid route geometry for ${edgeId}`);
  }
  return { x: point.x, y: point.y };
}

function samePoint(a: ElkPoint, b: ElkPoint): boolean {
  return closeEnough(a.x, b.x) && closeEnough(a.y, b.y);
}

function nextSection(
  section: ElkEdgeSection,
  remaining: ReadonlyMap<string, ElkEdgeSection>,
  edgeId: string,
): ElkEdgeSection | undefined {
  const outgoingIds = section.outgoingSections ?? [];
  if (outgoingIds.length > 1) throw new Error(`ELK returned a branched route for ${edgeId}`);
  if (outgoingIds.length === 1) {
    const next = remaining.get(outgoingIds[0]);
    if (!next) throw new Error(`ELK returned a broken section chain for ${edgeId}`);
    return next;
  }

  const candidates = [...remaining.values()].filter(candidate => samePoint(section.endPoint, candidate.startPoint));
  if (candidates.length > 1) throw new Error(`ELK returned an ambiguous section chain for ${edgeId}`);
  return candidates[0];
}

function sectionPoints(edge: ElkExtendedEdge, sourcePortId: string): Point[] {
  const sections = indexUnique(edge.sections, 'edge section');
  if (sections.size === 0) throw new Error(`ELK returned no route for ${edge.id}`);

  const sectionValues = [...sections.values()];
  const sourceStarts = sectionValues.filter(section => section.incomingShape === sourcePortId);
  const starts = sourceStarts.length > 0
    ? sourceStarts
    : sectionValues.filter(section => (section.incomingSections?.length ?? 0) === 0);
  if (starts.length !== 1) throw new Error(`ELK returned an invalid section chain for ${edge.id}`);

  const remaining = new Map(sections);
  const points: Point[] = [];
  let section: ElkEdgeSection | undefined = starts[0];
  while (section) {
    remaining.delete(section.id);
    const sectionRoute = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint]
      .map(point => finitePoint(point, edge.id));
    if (points.length && samePoint(points[points.length - 1], sectionRoute[0])) sectionRoute.shift();
    points.push(...sectionRoute);
    section = nextSection(section, remaining, edge.id);
  }

  if (remaining.size !== 0) throw new Error(`ELK returned disconnected sections for ${edge.id}`);
  return points;
}

function applyEdgeGeometry(input: ElkInput, output: ElkNode, workingScene: SchematicScene): void {
  const outputEdges = indexUnique(output.edges, 'edge');
  if (outputEdges.size !== input.edgeBundles.length) throw new Error('ELK returned an incomplete edge set');

  for (const bundle of input.edgeBundles) {
    const outputEdge = outputEdges.get(bundle.id) as ElkExtendedEdge | undefined;
    if (!outputEdge) throw new Error(`ELK omitted edge ${bundle.id}`);

    const points = sectionPoints(outputEdge, bundle.sourcePortId);
    for (const rawEdgeIndex of bundle.rawEdgeIndices) {
      workingScene.edges[rawEdgeIndex].points = points.map(point => ({ ...point }));
    }
  }
}

function cloneSceneForLayout(scene: SchematicScene): SchematicScene {
  return {
    nodes: scene.nodes.map(node => ({
      ...node,
      ports: node.ports.map(port => ({ ...port })),
      rows: node.rows?.map(row => ({ ...row })),
    })),
    edges: scene.edges.map(edge => ({
      ...edge,
      netIds: [...edge.netIds],
      source: { ...edge.source },
      target: { ...edge.target },
      points: edge.points.map(point => ({ ...point })),
    })),
    groups: scene.groups,
    summary: scene.summary,
    width: scene.width,
    height: scene.height,
  };
}

function validateAndRepairRoutes(scene: SchematicScene, onStage?: (stage: string) => void): void {
  const router = new OrthogonalRouter(scene);
  const invalidCount = scene.edges.reduce((count, edge) =>
    count + (router.validateEdge(edge).length === 0 ? 0 : 1), 0);

  if (invalidCount > 0) {
    onStage?.(`Repairing ${invalidCount} invalid ELK ${invalidCount === 1 ? 'route' : 'routes'}`);
  }
  // ELK places modules; the heuristic pass chooses shared channels and
  // routes long forward edges before short edges to reduce visual crossings.
  router.routeAll(true);
  router.rerouteFeedbackEdges();

  for (const edge of scene.edges) {
    const errors = router.validateEdge(edge);
    if (errors.length) throw new Error(`${edge.id}: ${errors.join('; ')}`);
  }
}

function commitLayout(source: SchematicScene, result: SchematicScene): void {
  for (let index = 0; index < source.nodes.length; index++) {
    source.nodes[index].x = result.nodes[index].x;
    source.nodes[index].y = result.nodes[index].y;
  }
  for (let index = 0; index < source.edges.length; index++) {
    source.edges[index].points = result.edges[index].points.map(point => ({ ...point }));
  }
  source.width = result.width;
  source.height = result.height;
}

/**
 * Lay out the complete visible topology with ELK Layered. The scene is mutated
 * only after ELK geometry and every exact raw edge route pass validation.
 */
export async function layoutScene(
  scene: SchematicScene,
  onStage?: (stage: string) => void,
  layout: ElkLayout = runDefaultLayout,
): Promise<SchematicScene> {
  if (scene.nodes.length === 0) return scene;

  const input = buildElkInput(scene);
  onStage?.('Arranging modules and signal groups with ELK Layered');
  const output = await layout(input.graph);

  const workingScene = cloneSceneForLayout(scene);
  applyNodeGeometry(input, output, workingScene);
  validateNodeSpacing(workingScene.nodes);
  applyEdgeGeometry(input, output, workingScene);

  onStage?.('Validating orthogonal connections');
  validateAndRepairRoutes(workingScene, onStage);
  commitLayout(scene, workingScene);
  return scene;
}
