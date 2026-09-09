import { strict as assert } from 'node:assert';
import { vi, test } from 'vitest';
import { buildScene, findLinkGroups } from '../rust-hier-viewer/src/html/frontend/schematic-model.js';
import { setGroupExpanded } from '../rust-hier-viewer/src/html/frontend/schematic-groups.js';
import { OrthogonalRouter, validateRoutes } from '../rust-hier-viewer/src/html/frontend/schematic-routing.js';
import type { SchematicGraph } from '../rust-hier-viewer/src/html/frontend/schematic-types.js';

function graph(count = 4): SchematicGraph {
  const names = Array.from({ length: count }, (_, index) => `${index < count / 2 ? 'request' : 'response'}_${index}`);
  return {
    version: 1, scopePath: 'top',
    nodes: ['left', 'right'].map((id, side) => ({
      id, kind: 'module', label: id, instancePath: `top.${id}`, detail: '',
      ports: names.map((name, index) => ({ id: `p${index}`, name, direction: side ? 'input' as const : 'output' as const, width: 1, ordinal: index })),
    })),
    nets: names.map((name, index) => ({
      id: `n${index}`, name, width: 1, status: 'resolved' as const,
      endpoints: [{ nodeId: 'left', portId: `p${index}`, role: 'driver' as const }, { nodeId: 'right', portId: `p${index}`, role: 'sink' as const }],
    })),
  };
}

function preparedScene() {
  const source = graph();
  const groups = findLinkGroups(source.nets);
  const scene = buildScene(source, new Set());
  const left = scene.nodes.find(node => node.id === 'left')!;
  const right = scene.nodes.find(node => node.id === 'right')!;
  left.x = 0; left.y = 0;
  right.x = 700; right.y = 0;
  for (const group of scene.nodes.filter(node => node.kind === 'group')) {
    group.x = 280; group.y = group.id.includes('request') ? 0 : 180;
  }
  const router = new OrthogonalRouter(scene);
  router.routeAll();
  return { source, groups, scene, router, netById: new Map(source.nets.map(net => [net.id, net])) };
}

test('incremental expansion updates rows and exact net port coordinates', () => {
  const { groups, scene, router, netById } = preparedScene();
  const group = scene.nodes.find(node => node.id === groups[0].id)!;
  const oldEdge = scene.edges.find(edge => edge.netIds.includes(groups[1].netIds[0]))!;
  const oldPoints = oldEdge.points;
  const changed = setGroupExpanded(scene, router, group.id, true, netById);
  assert.equal(group.expanded, true);
  assert.equal(group.rows?.length, 2);
  for (const row of group.rows!) assert.equal(group.ports.find(port => JSON.parse(port.id)[0] === row.netId)?.y, row.y);
  assert(changed.nodeIds.includes(group.id));
  assert.equal(scene.edges.find(edge => edge.id === oldEdge.id)?.points, oldPoints);
  assert.deepEqual(validateRoutes(scene), []);
});

test('multiple toggles preserve flags and restore dimensions', () => {
  const { groups, scene, router, netById } = preparedScene();
  const group = scene.nodes.find(node => node.id === groups[0].id)!;
  const collapsed = { width: group.width, height: group.height };
  setGroupExpanded(scene, router, group.id, true, netById);
  setGroupExpanded(scene, router, group.id, false, netById);
  assert.equal(group.expanded, false);
  assert.deepEqual({ width: group.width, height: group.height }, collapsed);
  assert.equal(group.rows?.length, 0);
  assert.deepEqual(validateRoutes(scene), []);
});

test('crowded expansion keeps the group near its center and moves only colliding neighbors', () => {
  const { groups, scene, netById } = preparedScene();
  const group = scene.nodes.find(node => node.id === groups[0].id)!;
  const neighbor = scene.nodes.find(node => node.id === groups[1].id)!;
  group.y = 100;
  neighbor.x = group.x;
  neighbor.y = group.y + group.height + 12;
  const router = new OrthogonalRouter(scene);
  router.routeAll();
  const originalNeighbor = { x: neighbor.x, y: neighbor.y };
  const center = group.y + group.height / 2;
  setGroupExpanded(scene, router, group.id, true, netById);
  assert(Math.abs((group.y + group.height / 2) - center) < 1);
  assert(neighbor.y > group.y + group.height);
  setGroupExpanded(scene, router, group.id, false, netById);
  assert.deepEqual({ x: neighbor.x, y: neighbor.y }, originalNeighbor);
});

test('failed route rolls back all geometry and path references', () => {
  const { groups, scene, router, netById } = preparedScene();
  const before = structuredClone(scene);
  const originalPaths = scene.edges.map(edge => edge.points);
  const originalPorts = scene.nodes.map(node => node.ports);
  const group = scene.nodes.find(node => node.id === groups[0].id)!;
  const route = (router as unknown as { route: (edge: unknown, interactive?: boolean) => unknown }).route;
  let calls = 0;
  vi.spyOn(router as unknown as { route: (edge: unknown, interactive?: boolean) => unknown }, 'route')
    .mockImplementation((edge, interactive) => {
      calls++;
      if (calls === 2) throw new Error('forced late route failure');
      return route.call(router, edge, interactive);
    });

  assert.throws(() => setGroupExpanded(scene, router, group.id, true, netById), /forced late route failure/);
  assert.deepEqual(scene, before);
  scene.edges.forEach((edge, index) => assert.equal(edge.points, originalPaths[index]));
  scene.nodes.forEach((node, index) => assert.equal(node.ports, originalPorts[index]));
  assert.deepEqual(validateRoutes(scene), []);
  vi.restoreAllMocks();
  setGroupExpanded(scene, router, group.id, true, netById);
  assert.equal(group.expanded, true);
  assert(router.moveNode('left', 1, 0).nodeIds.includes('left'));
  assert.deepEqual(validateRoutes(scene), []);
});

test('dense groups update without rebuilding distant geometry', () => {
  const source = graph(256);
  const scene = buildScene(source, new Set());
  const groups = scene.nodes.filter(node => node.kind === 'group');
  scene.nodes.find(node => node.id === 'left')!.x = 0;
  const right = scene.nodes.find(node => node.id === 'right')!;
  right.x = 1000;
  right.y = 32;
  groups[0].x = 400;
  groups[0].y = 32;
  groups[1].x = 400;
  groups[1].y = 4000;
  const router = new OrthogonalRouter(scene);
  router.routeAll();
  const netById = new Map(source.nets.map(net => [net.id, net]));
  const distant = groups[1];
  const ports = distant.ports;
  const origin = { x: distant.x, y: distant.y };
  const samples: number[] = [];
  for (let index = 0; index < 4; index++) {
    const started = performance.now();
    setGroupExpanded(scene, router, groups[0].id, index % 2 === 0, netById);
    samples.push(performance.now() - started);
    assert.equal(distant.ports, ports);
    assert.deepEqual({ x: distant.x, y: distant.y }, origin);
    assert.deepEqual(validateRoutes(scene), []);
  }
  console.log(`512 wire legs: group updates ${samples.map(ms => ms.toFixed(1)).join(', ')}ms`);
  assert(Math.max(...samples) < 250, 'Local updates must avoid a seconds-long global layout');
});
