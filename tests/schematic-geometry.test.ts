import { strict as assert } from 'node:assert';
import { test } from 'vitest';
import type { ElkNode } from 'elkjs/lib/elk-api.js';
import { buildScene, bitWidthPadding, findLinkGroups, labelWidth, metricSizeScale, PORT_SPACING } from '../rust-hier-viewer/src/html/frontend/schematic-model.js';
import { layoutScene as layoutWithEngine } from '../rust-hier-viewer/src/html/frontend/schematic-layout.js';
import { CLEARANCE, isOrthogonal, OrthogonalRouter, segmentIntersectsBox, validateRoutes } from '../rust-hier-viewer/src/html/frontend/schematic-routing.js';
import type { SceneNode, SchematicGraph, SchematicScene } from '../rust-hier-viewer/src/html/frontend/schematic-types.js';

type Layout = (graph: ElkNode) => Promise<ElkNode>;

async function layoutScene(scene: SchematicScene, onStage?: (stage: string) => void, layout?: Layout) {
  return layoutWithEngine(scene, onStage, layout);
}

function deterministicLayout(capture?: ElkNode[]): Layout {
  return async graph => {
    capture?.push(structuredClone(graph));
    const children = graph.children ?? [];
    const positions = new Map(children.map((child, index) => [child.id, { x: index * 500, y: 32 }]));
    const outputChildren = children.map(child => ({ ...child, ...positions.get(child.id) }));
    const ownerByPort = new Map<string, ElkNode>();
    for (const child of outputChildren) {
      for (const port of child.ports ?? []) ownerByPort.set(port.id, child);
    }
    const edges = (graph.edges ?? []).map(edge => {
      const source = ownerByPort.get(edge.sources[0]);
      const target = ownerByPort.get(edge.targets[0]);
      const sourcePort = source?.ports?.find(port => port.id === edge.sources[0]);
      const targetPort = target?.ports?.find(port => port.id === edge.targets[0]);
      assert(source && target && sourcePort && targetPort);
      const startPoint = { x: source.x! + sourcePort.x!, y: source.y! + sourcePort.y! };
      const endPoint = { x: target.x! + targetPort.x!, y: target.y! + targetPort.y! };
      return {
        ...edge,
        sections: [{ id: `section:${edge.id}`, startPoint, endPoint, incomingShape: edge.sources[0] }],
      };
    });
    return {
      ...graph,
      width: Math.max(1, ...outputChildren.map(child => child.x! + child.width! + 64)),
      height: Math.max(1, ...outputChildren.map(child => child.y! + child.height! + 64)),
      children: [...outputChildren].reverse(),
      edges: [...edges].reverse(),
    };
  };
}

function twoModules(count = 4): SchematicGraph {
  const names = Array.from({ length: count }, (_, index) => `${index < count / 2 ? 'request' : 'response'}_field${index}`);
  return {
    version: 1, scopePath: 'top',
    nodes: ['a', 'b'].map((id, nodeIndex) => ({
      id, kind: 'module', label: id, instancePath: `top.${id}`, detail: '',
      ports: names.map((name, index) => ({ id: `p${index}`, name, direction: nodeIndex === 0 ? 'output' : 'input', width: index + 1, ordinal: index })),
    })),
    nets: names.map((name, index) => ({
      id: `n${index}`, name, width: index + 1, status: 'resolved',
      endpoints: [{ nodeId: 'a', portId: `p${index}`, role: 'driver' }, { nodeId: 'b', portId: `p${index}`, role: 'sink' }],
    })),
  };
}

function assertGeometry(scene: SchematicScene): void {
  assert.deepEqual(validateRoutes(scene), []);
  for (const node of scene.nodes) {
    assert(node.width > 0 && node.height > 0);
    for (const port of node.ports) {
      assert.equal(port.x, port.side === 'WEST' ? 0 : node.width);
      assert(port.y > 0 && port.y < node.height);
    }
    for (const other of scene.nodes) {
      if (node === other) continue;
      assert(node.x + node.width + CLEARANCE <= other.x || other.x + other.width + CLEARANCE <= node.x
        || node.y + node.height + CLEARANCE <= other.y || other.y + other.height + CLEARANCE <= node.y,
      `Nodes overlap or lack clearance: ${node.id}, ${other.id}`);
    }
  }
}

test('component dimensions expose wide signal widths with bounded growth', () => {
  assert.equal(bitWidthPadding(1), 0);
  assert(bitWidthPadding(64) > bitWidthPadding(8));
  assert.equal(bitWidthPadding(1 << 30), 112);
  const narrow = buildScene(twoModules(2), new Set());
  const wideGraph = twoModules(2);
  wideGraph.nodes[0].ports[0].width = 512;
  wideGraph.nodes[1].ports[0].width = 512;
  wideGraph.nets[0].width = 512;
  const wide = buildScene(wideGraph, new Set());
  assert(wide.nodes.find(node => node.id === 'a')!.width > narrow.nodes.find(node => node.id === 'a')!.width);
  assert.equal(metricSizeScale(0, 100, 100), 1);
  assert.equal(metricSizeScale(100, 100, 100), 1);
  assert(metricSizeScale(25, 1, 100) > 1);
  assert.equal(metricSizeScale(100, 1, 100), 2);
  const metricNarrow = twoModules(2);
  metricNarrow.nodes.forEach(node => node.ports.forEach(port => { port.width = 1; }));
  const metricWide = structuredClone(metricNarrow);
  metricWide.nodes[0].visualWeight = 100;
  metricWide.nodes[1].visualWeight = 25;
  const metricScene = buildScene(metricWide, new Set());
  assert(metricScene.nodes.find(node => node.id === 'a')!.width > metricScene.nodes.find(node => node.id === 'b')!.width);
});

test('groups use stable naming tokens and actual endpoint node sets', () => {
  const graph = twoModules();
  const original = findLinkGroups(graph.nets);
  assert.equal(original.length, 2);
  assert.deepEqual(original.map(group => group.label).sort(), ['request', 'response']);
  assert.deepEqual(findLinkGroups([...graph.nets].reverse()), original);
  graph.nets[1].endpoints[1].nodeId = 'different-instance';
  assert.deepEqual(findLinkGroups(graph.nets).map(group => group.label), ['response']);
});

test('injected ELK layout is deterministic and maps complete topology by synthetic IDs', async () => {
  const firstCapture: ElkNode[] = [];
  const secondCapture: ElkNode[] = [];
  const first = await layoutScene(buildScene(twoModules(), new Set()), undefined, deterministicLayout(firstCapture));
  const second = await layoutScene(buildScene(twoModules(), new Set()), undefined, deterministicLayout(secondCapture));
  assertGeometry(first);
  assert.deepEqual(first, second);
  assert.deepEqual(firstCapture, secondCapture);
  assert.equal(first.edges.length, 8);
  assert.equal(new Set(first.edges.flatMap(edge => edge.netIds)).size, 4);
  assert(first.nodes.every(node => Number.isFinite(node.x) && Number.isFinite(node.y)));
});

test('ELK receives sanitized synthetic nodes and one visual port per terminal', async () => {
  const graph = twoModules(256);
  const rawId = 'dangerous.\\name[3]: {injected -> node}\n# comment';
  graph.nodes[0].id = rawId;
  graph.nodes[0].label = 'module: "quoted" -> label';
  for (const net of graph.nets) net.endpoints[0].nodeId = rawId;
  const scene = buildScene(graph, new Set());
  const captured: ElkNode[] = [];
  const originalEdges = scene.edges.map(({ points: _points, ...edge }) => structuredClone(edge));
  const originalPorts = scene.nodes.map(node => structuredClone(node.ports));
  await layoutScene(scene, undefined, deterministicLayout(captured));
  const serialized = JSON.stringify(captured[0]);
  assert(!serialized.includes(rawId));
  assert(!serialized.includes(graph.nodes[0].label));
  assert.equal(new Set((captured[0].children ?? []).map(child => child.id)).size, scene.nodes.length);
  assert((captured[0].children ?? []).every(child => (child.ports?.length ?? 0) <= 2));
  assert.deepEqual(scene.nodes.map(node => node.ports), originalPorts);
  assert.deepEqual(scene.edges.map(({ points: _points, ...edge }) => edge), originalEdges);
  assert.equal(scene.edges.length, 512);
  assertGeometry(scene);
});

test('ELK preserves opposite-direction topology when result children are reordered', async () => {
  const scene = buildScene(twoModules(2), new Set());
  const reverse = scene.edges[1];
  [reverse.source, reverse.target] = [reverse.target, reverse.source];
  await layoutScene(scene, undefined, deterministicLayout());
  assertGeometry(scene);
  assert(scene.edges.some(edge => edge.source.nodeId === 'b' && edge.target.nodeId === 'a'));
});

test('missing or invalid ELK node geometry rejects without partially positioning the scene', async () => {
  const invalidResults: Array<(graph: ElkNode) => ElkNode> = [
    graph => ({ ...graph, children: graph.children?.slice(0, -1) }),
    graph => ({ ...graph, children: graph.children?.map((child, index) => index ? { ...child, x: Number.NaN } : child) }),
    graph => ({ ...graph, children: graph.children?.map((child, index) => index ? { ...child, width: Number.POSITIVE_INFINITY } : child) }),
    graph => ({ ...graph, children: graph.children?.map((child, index) => index ? { ...child, height: 0 } : child) }),
  ];
  for (const invalid of invalidResults) {
    const scene = buildScene(twoModules(2), new Set());
    const before = structuredClone(scene);
    await assert.rejects(layoutScene(scene, undefined, async graph => invalid(graph)), /ELK|geometry|node/i);
    assert.deepEqual(scene, before);
  }
});

test('missing edge endpoints, incomplete ELK edges, and ELK errors propagate without fallback', async () => {
  const scene = buildScene(twoModules(), new Set());
  scene.edges[0].source.nodeId = 'missing-node';
  const before = structuredClone(scene);
  let calls = 0;
  await assert.rejects(layoutScene(scene, undefined, async graph => {
    calls++;
    return graph;
  }), /missing schematic node|edge/i);
  assert.equal(calls, 0);
  assert.deepEqual(scene, before);

  const missingEdgeScene = buildScene(twoModules(), new Set());
  const missingEdgeBefore = structuredClone(missingEdgeScene);
  await assert.rejects(layoutScene(missingEdgeScene, undefined, async graph => {
    const result = await deterministicLayout()(graph);
    return { ...result, edges: result.edges?.slice(0, -1) };
  }), /incomplete edge|edge/i);
  assert.deepEqual(missingEdgeScene, missingEdgeBefore);

  const validScene = buildScene(twoModules(), new Set());
  const validBefore = structuredClone(validScene);
  await assert.rejects(layoutScene(validScene, undefined, async () => {
    throw new Error('ELK layout failed');
  }), /ELK layout failed/);
  assert.deepEqual(validScene, validBefore);

  const empty = buildScene({ version: 1, scopePath: 'empty', nodes: [], nets: [] }, new Set());
  await layoutScene(empty, undefined, async () => { throw new Error('Empty scene should not invoke ELK'); });
  assertGeometry(empty);
});

test('independent expanded groups retain every net and connect exact LEFT/RIGHT row ports', async () => {
  const graph = twoModules(8);
  const groups = findLinkGroups(graph.nets);
  const scene = await layoutScene(buildScene(graph, new Set(groups.map(group => group.id))));
  assertGeometry(scene);
  assert.equal(scene.nodes.filter(node => node.expanded).length, 2);
  for (const group of scene.nodes.filter(node => node.kind === 'group')) {
    assert.equal(group.rows!.length, 4);
    for (const row of group.rows!) {
      const legs = scene.edges.filter(edge => edge.netIds.includes(row.netId));
      assert.equal(legs.length, 2);
      for (const edge of legs) {
        const endpoint = edge.source.nodeId === group.id ? edge.source : edge.target;
        const port = group.ports.find(port => port.id === endpoint.portId)!;
        assert.equal(port.y, row.y);
        assert.equal(port.side, edge.source.nodeId === group.id ? 'EAST' : 'WEST');
      }
    }
  }
  const collapsedOne = buildScene(graph, new Set([groups[1].id]));
  assert.equal(collapsedOne.nodes.filter(node => node.expanded).length, 1);
  assert.deepEqual(collapsedOne.groups, scene.groups);
});

test('long labels, wide buses and dense ports fit their node dimensions', async () => {
  const graph = twoModules(32);
  graph.nodes[0].label = 'a_module_with_a_name_that_must_never_overflow_its_rectangle';
  for (const port of graph.nodes[0].ports) port.name = `very_long_port_name_${port.name}`;
  const scene = await layoutScene(buildScene(graph, new Set(findLinkGroups(graph.nets).map(group => group.id))));
  assertGeometry(scene);
  for (const node of scene.nodes) {
    assert(node.width >= labelWidth(node.label) + 24);
    if (node.kind !== 'module') continue;
    const visiblePorts = node.ports.filter(port => !port.hidden);
    for (const port of visiblePorts) {
      const display = port.displayLabel ?? (port.width > 1 ? `${port.label} [${port.width}]` : port.label);
      assert(node.width >= labelWidth(display) + 24);
    }
    for (let index = 1; index < visiblePorts.length; index++) assert(visiblePorts[index].y - visiblePorts[index - 1].y >= PORT_SPACING);
  }
});

test('long expression captions stay bounded while complete RTL remains inspectable', async () => {
  const graph = twoModules(2);
  const expression = Array.from({ length: 300 }, (_, index) => `operand_${index}`).join(' | ');
  graph.nodes[0].kind = 'expr';
  graph.nodes[0].label = expression;
  graph.nodes[0].detail = 'Binary expression';
  const scene = await layoutScene(buildScene(graph, new Set()));
  assertGeometry(scene);
  const node = scene.nodes.find(item => item.id === 'a')!;
  assert(node.label.length <= 64);
  assert(node.width < 600);
  assert(node.detail.includes(expression));
  graph.nodes[0].kind = 'module';
  assert.equal(buildScene(graph, new Set()).nodes.find(item => item.id === 'a')!.label, expression);
});

test('ungrouped fanout retains exact identities; ambiguous nets use explicit junctions', () => {
  const graph = twoModules(2);
  graph.nodes.push({ ...graph.nodes[1], id: 'c', instancePath: 'top.c' });
  graph.nets[0].endpoints.push({ nodeId: 'c', portId: 'p0', role: 'sink' });
  let scene = buildScene(graph, new Set());
  assert.equal(scene.groups.length, 0);
  assert.deepEqual(scene.edges.filter(edge => edge.netIds[0] === 'n0').map(edge => edge.target.nodeId), ['b', 'c']);
  for (const status of ['multi-driver', 'bidirectional', 'unresolved'] as const) {
    graph.nets[0].status = status;
    graph.nets[0].endpoints[0].role = status === 'multi-driver' ? 'driver' : 'unknown';
    graph.nets[0].endpoints[1].role = status === 'multi-driver' ? 'driver' : 'bidirectional';
    scene = buildScene(graph, new Set());
    assert(scene.nodes.some(node => node.kind === 'junction' && node.detail === status));
    assert.equal(scene.edges.filter(edge => edge.netIds[0] === 'n0').length, 3);
    assert(scene.edges.filter(edge => edge.netIds[0] === 'n0').every(edge => edge.status === status));
  }
  graph.nodes[0].kind = 'boundary';
  graph.nodes[0].ports[0].direction = 'input';
  assert.equal(buildScene(graph, new Set()).nodes.find(node => node.id === 'a')!.ports[0].side, 'EAST');
});

function boxNode(id: string, x: number, y: number, side: 'WEST' | 'EAST' = 'EAST'): SceneNode {
  return {
    id, kind: 'module', label: id, detail: '', instancePath: null, x, y, width: 100, height: 100,
    ports: [{ id: 'p', label: '', width: 1, direction: side === 'WEST' ? 'input' : 'output', side, x: side === 'WEST' ? 0 : 100, y: 50 }],
  };
}

function dragScene(): SchematicScene {
  return {
    nodes: [boxNode('a', 0, 0), boxNode('b', 500, 0, 'WEST'), boxNode('obstacle', 260, 150), boxNode('c', 0, 450), boxNode('d', 500, 450, 'WEST')],
    edges: [['ab', 'a', 'b'], ['cd', 'c', 'd']].map(([id, source, target]) => ({
      id, netIds: [id], label: id, status: 'resolved', source: { nodeId: source, portId: 'p' }, target: { nodeId: target, portId: 'p' }, points: [],
    })),
    groups: [], width: 650, height: 600,
  };
}

test('moving an unrelated obstacle reroutes blocked paths and preserves unrelated array references', () => {
  const scene = dragScene();
  const router = new OrthogonalRouter(scene);
  router.routeAll();
  const stable = scene.edges[1].points;
  const blocked = scene.edges[0].points;
  assert.deepEqual(router.moveNode('obstacle', 260, 0), { nodeIds: ['obstacle'], edgeIds: ['ab'] });
  assert.notEqual(scene.edges[0].points, blocked);
  assert.equal(scene.edges[1].points, stable);
  assertGeometry(scene);
  const obstacle = scene.nodes[2];
  assert.deepEqual(router.moveNode('obstacle', 30, 0), { nodeIds: [], edgeIds: [] });
  assert.equal(obstacle.x, 260);
  assert.equal(obstacle.y, 0);
});

test('a 4000-unit tall wall uses exterior channels for initial and incremental routing', () => {
  for (const initiallyBlocking of [true, false]) {
    const scene = dragScene();
    scene.nodes = scene.nodes.slice(0, 3);
    scene.edges = scene.edges.slice(0, 1);
    const wall = scene.nodes[2];
    wall.height = 4000;
    wall.y = initiallyBlocking ? -1950 : 150;
    const router = new OrthogonalRouter(scene);
    router.routeAll();
    if (!initiallyBlocking) {
      assert.equal(scene.edges[0].points.length, 2);
      assert.deepEqual(router.moveNode(wall.id, wall.x, -1950), { nodeIds: [wall.id], edgeIds: ['ab'] });
    }
    assertGeometry(scene);
    assert(scene.edges[0].points.some(point => point.y <= wall.y - CLEARANCE || point.y >= wall.y + wall.height + CLEARANCE),
      'The route must reach a wall exterior beyond the former 1536-unit search cap');
  }
});

test('expanded group is a whole obstacle during initial routing and synchronous group drag', () => {
  const scene = dragScene();
  const group = scene.nodes[2];
  Object.assign(group, { kind: 'group', groupId: 'g', expanded: true, x: 260, y: 0, height: 200,
    rows: [{ netId: 'own', label: 'own', y: 70 }] });
  const router = new OrthogonalRouter(scene);
  router.routeAll();
  assertGeometry(scene);
  assert.equal(router.moveNode('obstacle', 284, 12).nodeIds.length, 1);
  assertGeometry(scene);
  const points = scene.edges[0].points;
  for (let index = 1; index < points.length; index++) assert(!segmentIntersectsBox(points[index - 1], points[index], group));
});

test('wire drag adjusts a vertical and horizontal interior segment while keeping ports attached', () => {
  const scene = dragScene();
  scene.nodes[1].y = 100;
  const router = new OrthogonalRouter(scene);
  router.routeAll();
  const edge = scene.edges[0];
  const start = { ...edge.points[0] };
  const end = { ...edge.points.at(-1)! };
  const vertical = edge.points.findIndex((point, index) => index > 0 && index < edge.points.length - 2 && point.x === edge.points[index + 1].x);
  assert(vertical > 0);
  assert.deepEqual(router.moveSegment(edge.id, vertical, 200), [edge.id]);
  assert(edge.points.some((point, index) => index < edge.points.length - 1 && point.x === 200 && edge.points[index + 1].x === 200));
  assert.deepEqual(edge.points[0], start);
  assert.deepEqual(edge.points.at(-1), end);
  assertGeometry(scene);
  // An explicit dogleg supplies a horizontal interior segment with fixed port escapes.
  edge.points = [start, { x: 140, y: start.y }, { x: 140, y: -60 }, { x: 440, y: -60 }, { x: 440, y: end.y }, end];
  const secondRouter = new OrthogonalRouter(scene);
  assert.deepEqual(secondRouter.moveSegment(edge.id, 2, -84), [edge.id]);
  assert.equal(edge.points[2].y, -84);
  assert.equal(edge.points[3].y, -84);
  assert.deepEqual(edge.points[0], start);
  assert.deepEqual(edge.points.at(-1), end);
  assertGeometry(scene);
  assert.deepEqual(secondRouter.moveSegment(edge.id, 0, 200), []);
  const stable = edge.points;
  assert.deepEqual(secondRouter.moveSegment(edge.id, 2, 180), []);
  assert.equal(edge.points, stable, 'Dragging a wire inside an obstacle must leave its valid path untouched');
});

test('a long straight wire gains a draggable dogleg while short port escapes stay fixed', () => {
  const scene = dragScene();
  const router = new OrthogonalRouter(scene);
  router.routeAll();
  const edge = scene.edges[0];
  assert.equal(edge.points.length, 2);
  const start = { ...edge.points[0] };
  const end = { ...edge.points[1] };
  assert.deepEqual(router.moveSegment(edge.id, 0, -36), [edge.id]);
  assert.equal(edge.points.length, 6);
  assert.deepEqual(edge.points[0], start);
  assert.deepEqual(edge.points.at(-1), end);
  assert.equal(edge.points[2].y, -36);
  assert.equal(edge.points[3].y, -36);
  assertGeometry(scene);
  assert.deepEqual(router.moveSegment(edge.id, 2, -48), [edge.id]);
  assert.equal(edge.points[2].y, -48);
  assert.deepEqual(router.moveSegment(edge.id, 0, -60), []);
  assert.deepEqual(router.moveSegment(edge.id, edge.points.length - 2, -60), []);
  assertGeometry(scene);

  const shortScene = dragScene();
  shortScene.nodes[1].x = 136;
  const shortRouter = new OrthogonalRouter(shortScene);
  shortRouter.routeAll();
  assert.equal(shortScene.edges[0].points.length, 2);
  assert.deepEqual(shortRouter.moveSegment('ab', 0, -36), []);
  assertGeometry(shortScene);
});

test('small endpoint moves retain a chosen channel and meet synchronous drag budget', () => {
  const scene = dragScene();
  scene.nodes[1].y = 100;
  const router = new OrthogonalRouter(scene);
  router.routeAll();
  router.moveSegment('ab', 1, 200);
  const unrelated = scene.edges[1].points;
  const times: number[] = [];
  for (let index = 0; index < 120; index++) {
    const started = performance.now();
    const result = router.moveNode('a', 0, index % 2 === 0 ? 1 : 0);
    times.push(performance.now() - started);
    assert.deepEqual(result.nodeIds, ['a']);
    assert.deepEqual(router.validateEdge(scene.edges[0]), []);
    assert.equal(scene.edges[0].points[1].x, 200);
    assert.equal(scene.edges[1].points, unrelated);
  }
  times.sort((a, b) => a - b);
  console.log(`schematic small-drag p95=${times[114].toFixed(2)}ms max=${times[119].toFixed(2)}ms`);
  assert(times[114] < 16, '120 synchronous small drags should fit a 60Hz frame at p95');
});

test('dense expanded-group moves update attached rows synchronously and preserve the other group', async () => {
  const graph = twoModules(32);
  const groups = findLinkGroups(graph.nets);
  const scene = await layoutScene(buildScene(graph, new Set(groups.map(group => group.id))));
  const router = new OrthogonalRouter(scene);
  const group = scene.nodes.find(node => node.id === groups[0].id)!;
  const other = scene.nodes.find(node => node.id === groups[1].id)!;
  const origin = { x: group.x, y: group.y };
  const otherGeometry = JSON.stringify(other);
  const times: number[] = [];
  for (let index = 0; index < 60; index++) {
    const started = performance.now();
    const changed = router.moveNode(group.id, origin.x + (index % 2 ? 0 : 1), origin.y);
    times.push(performance.now() - started);
    assert.deepEqual(changed.nodeIds, [group.id]);
    assert(changed.edgeIds.length > 0);
    for (const edge of scene.edges) assert.deepEqual(router.validateEdge(edge), []);
    assert.equal(JSON.stringify(other), otherGeometry);
  }
  times.sort((a, b) => a - b);
  console.log(`schematic 32-net expanded-group drag p95=${times[57].toFixed(2)}ms max=${times[59].toFixed(2)}ms`);
  assert(times[57] < 16, 'Expanded group dragging should fit a 60Hz frame at p95');
});

test('512 expression nodes with fanout expose layout and routing costs', async () => {
  const lanes = 16;
  const layers = 32;
  const graph: SchematicGraph = { version: 1, scopePath: 'expr-stress-512', nodes: [], nets: [] };
  const nodeId = (index: number): string => `e${String(index).padStart(4, '0')}`;
  for (let layer = 0; layer < layers; layer++) {
    for (let lane = 0; lane < lanes; lane++) {
      const index = layer * lanes + lane;
      graph.nodes.push({
        id: nodeId(index), kind: 'expr', label: `expr ${index}`, instancePath: null, detail: 'RTL expression',
        ports: [
          { id: 'in0', name: 'in0', ordinal: 0, width: 8, direction: 'input' },
          { id: 'in1', name: 'in1', ordinal: 1, width: 8, direction: 'input' },
          { id: 'out', name: 'out', ordinal: 2, width: 8, direction: 'output' },
        ],
      });
      if (layer + 1 < layers) {
        graph.nets.push({
          id: `wire${index}`, name: `wire${index}`, width: 8, status: 'resolved',
          endpoints: [
            { nodeId: nodeId(index), portId: 'out', role: 'driver' },
            { nodeId: nodeId(index + lanes), portId: 'in0', role: 'sink' },
            { nodeId: nodeId((layer + 1) * lanes + (lane + 1) % lanes), portId: 'in1', role: 'sink' },
          ],
        });
      }
    }
  }
  const started = performance.now();
  const scene = buildScene(graph, new Set());
  const built = performance.now();
  let routingStarted = 0;
  try {
    await layoutScene(scene, stage => {
      if (stage.startsWith('Validating')) routingStarted = performance.now();
    });
  } catch (error) {
    console.log(`schematic 512-expr nodes=${scene.nodes.length} edges=${scene.edges.length} build=${(built - started).toFixed(1)}ms failed-layout=${(performance.now() - built).toFixed(1)}ms`);
    throw error;
  }
  const routed = performance.now();
  assert.equal(scene.nodes.length, 512);
  assert.equal(scene.edges.length, 992);
  assert(routingStarted > built);
  console.log(`schematic 512-expr nodes=${scene.nodes.length} edges=${scene.edges.length} build=${(built - started).toFixed(1)}ms elk-and-setup=${(routingStarted - built).toFixed(1)}ms routing=${(routed - routingStarted).toFixed(1)}ms total=${(routed - started).toFixed(1)}ms`);
  assertGeometry(scene);
  assert(scene.edges.every(edge => isOrthogonal(edge.points)));

  const router = new OrthogonalRouter(scene);
  const node = scene.nodes[256];
  const originX = node.x;
  const times: number[] = [];
  for (let index = 0; index < 60; index++) {
    const tick = performance.now();
    assert.deepEqual(router.moveNode(node.id, originX + (index % 2 ? 0 : 1), node.y).nodeIds, [node.id]);
    times.push(performance.now() - tick);
  }
  times.sort((a, b) => a - b);
  console.log(`schematic 512-expr incremental-drag p95=${times[57].toFixed(2)}ms max=${times[59].toFixed(2)}ms`);
  assert(times[57] < 16, 'An ordinary node drag in the 512-expr scene should fit a 60Hz frame at p95');
  assert.deepEqual(validateRoutes(scene), []);
}, 60000);
