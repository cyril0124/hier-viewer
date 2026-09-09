import { strict as assert } from 'node:assert';
import { test } from 'vitest';
import { setGroupExpanded } from '../rust-hier-viewer/src/html/frontend/schematic-groups.js';
import { buildScene } from '../rust-hier-viewer/src/html/frontend/schematic-model.js';
import { OrthogonalRouter, validateRoutes } from '../rust-hier-viewer/src/html/frontend/schematic-routing.js';
import type { SceneEdge, SchematicScene } from '../rust-hier-viewer/src/html/frontend/schematic-types.js';
import { visibleWires } from '../rust-hier-viewer/src/html/frontend/schematic-wires.js';
import { twoModules } from './fixtures/schematic-fixture.js';

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function rawEdgeIds(scene: SchematicScene): string[] {
  return sorted(scene.edges.map(edge => edge.id));
}

function visibleEdgeIds(scene: SchematicScene): string[] {
  return sorted(visibleWires(scene).flatMap(wire => wire.edgeIds));
}

function visibleNetIds(scene: SchematicScene): string[] {
  return sorted(new Set(visibleWires(scene).flatMap(wire => wire.netIds)));
}

function routeCollapsedFixture(count = 8) {
  const graph = twoModules(count);
  const scene = buildScene(graph, new Set());
  const producer = scene.nodes.find(node => node.id === 'producer')!;
  const consumer = scene.nodes.find(node => node.id === 'consumer')!;
  producer.x = 0;
  producer.y = 32;
  consumer.x = 800;
  consumer.y = 32;
  scene.nodes.filter(node => node.kind === 'group').forEach((group, index) => {
    group.x = 340;
    group.y = 32 + index * 220;
  });
  const router = new OrthogonalRouter(scene);
  router.routeAll();
  return { graph, scene, router };
}

test('256 physical pins retain every raw ID and net while using compact terminals', () => {
  const graph = twoModules(256);
  for (const node of graph.nodes) node.ports.push({ id: 'unused', name: 'unused_physical_pin', direction: node.id === 'producer' ? 'output' : 'input', width: 1, ordinal: 256 });
  const scene = buildScene(graph, new Set());
  const expectedPortIds = sorted(graph.nodes[0].ports.map(port => port.id));

  for (const module of scene.nodes.filter(node => node.kind === 'module')) {
    assert.deepEqual(sorted(module.ports.map(port => port.id)), expectedPortIds);
    assert.equal(module.ports.find(port => port.id === 'unused')?.hidden, true);
    const terminals = module.ports.filter(port => !port.hidden);
    assert.equal(terminals.length, 2);
    assert.deepEqual(terminals.map(port => port.bundleCount).sort((left, right) => left! - right!), [128, 128]);
    assert(terminals.every(port => port.displayLabel));
    assert(module.width >= 144);
    assert(module.height >= 48 + terminals.length * 24 + 12);
    assert(module.height < 256, 'Physical pin count must not allocate one rendered row per pin');
  }

  assert.equal(scene.edges.length, 512);
  assert.deepEqual(sorted(new Set(scene.edges.flatMap(edge => edge.netIds))), sorted(graph.nets.map(net => net.id)));
});

test('visible buses retain all physical edges and exact unique net unions', () => {
  const { graph, scene } = routeCollapsedFixture();
  const wires = visibleWires(scene);
  assert(wires.some(wire => wire.netIds.length > 1));
  assert.deepEqual(visibleEdgeIds(scene), rawEdgeIds(scene));
  assert.deepEqual(visibleNetIds(scene), sorted(graph.nets.map(net => net.id)));
  for (const wire of wires) assert.equal(wire.netIds.length, new Set(wire.netIds).size);
});

function edge(id: string, source: string, target: string, status: SceneEdge['status']): SceneEdge {
  return {
    id,
    netIds: [`net:${id}`],
    label: `label:${id}`,
    status,
    source: { nodeId: source, portId: `out:${id}` },
    target: { nodeId: target, portId: `in:${id}` },
    points: [{ x: 10, y: 20 }, { x: 90, y: 20 }],
  };
}

test('identical paths do not merge across endpoint groups, statuses, or directions', () => {
  const scene: SchematicScene = {
    nodes: [],
    edges: [
      edge('forward-a', 'source', 'target', 'resolved'),
      edge('forward-b', 'source', 'target', 'resolved'),
      edge('other-status', 'source', 'target', 'unresolved'),
      edge('reverse', 'target', 'source', 'resolved'),
      edge('other-endpoints', 'different-source', 'different-target', 'resolved'),
    ],
    groups: [],
    width: 100,
    height: 40,
  };

  const wires = visibleWires(scene);
  assert.equal(wires.length, 4);
  assert.deepEqual(wires.find(wire => wire.edge.id === 'forward-a')?.edgeIds, ['forward-a', 'forward-b']);
  assert(wires.some(wire => wire.edge.id === 'other-status'));
  assert(wires.some(wire => wire.edge.id === 'reverse'));
  assert(wires.some(wire => wire.edge.id === 'other-endpoints'));
});

test('expansion creates exact signal rows and collapse restores the same visible bundles', () => {
  const { graph, scene, router } = routeCollapsedFixture();
  const group = scene.nodes.find(node => node.kind === 'group')!;
  const netById = new Map(graph.nets.map(net => [net.id, net]));
  const collapsedWires = visibleWires(scene);
  const collapsedSignature = collapsedWires.map(wire => sorted(wire.netIds)).sort((left, right) => left.join().localeCompare(right.join()));
  const rawIds = rawEdgeIds(scene);

  setGroupExpanded(scene, router, group.id, true, netById);
  assert.equal(group.expanded, true);
  assert.deepEqual(group.rows?.map(row => row.netId), scene.groups.find(item => item.id === group.id)?.netIds);
  assert.equal(new Set(group.rows?.map(row => row.y)).size, group.rows?.length);
  for (const row of group.rows ?? []) {
    const rowPorts = group.ports.filter(port => JSON.parse(port.id)[0] === row.netId);
    assert.equal(rowPorts.length, 2);
    assert(rowPorts.every(port => port.y === row.y));
  }
  assert(visibleWires(scene).length > collapsedWires.length);
  assert.deepEqual(visibleEdgeIds(scene), rawIds);
  assert.deepEqual(visibleNetIds(scene), sorted(graph.nets.map(net => net.id)));
  assert.deepEqual(validateRoutes(scene), []);

  setGroupExpanded(scene, router, group.id, false, netById);
  assert.equal(group.expanded, false);
  assert.deepEqual(group.rows, []);
  assert.deepEqual(visibleWires(scene).map(wire => sorted(wire.netIds)).sort((left, right) => left.join().localeCompare(right.join())), collapsedSignature);
  assert.deepEqual(visibleEdgeIds(scene), rawIds);
  assert.deepEqual(validateRoutes(scene), []);
});

test('compact labels never replace full physical pin, net, or expanded row labels', () => {
  const graph = twoModules(8);
  for (const [index, net] of graph.nets.entries()) {
    const prefix = index < graph.nets.length / 2 ? 'request' : 'response';
    const fullLabel = `${prefix}_extremely_long_interface_signal_name_field_${index}`;
    net.name = fullLabel;
    for (const endpoint of net.endpoints) {
      graph.nodes.find(node => node.id === endpoint.nodeId)!.ports[index].name = fullLabel;
    }
  }

  const collapsed = buildScene(graph, new Set());
  for (const module of collapsed.nodes.filter(node => node.kind === 'module')) {
    assert.deepEqual(module.ports.map(port => port.label), graph.nets.map(net => net.name));
    assert(module.ports.filter(port => !port.hidden).every(port => port.displayLabel!.length < port.label.length));
  }
  assert.deepEqual(sorted(collapsed.edges.map(edge => edge.label)), sorted(graph.nets.flatMap(net => [net.name, net.name])));

  const expanded = buildScene(graph, new Set(collapsed.groups.map(group => group.id)));
  const rowLabels = expanded.nodes.filter(node => node.kind === 'group').flatMap(node => node.rows?.map(row => row.label) ?? []);
  assert.deepEqual(sorted(rowLabels), sorted(graph.nets.map(net => net.width > 1 ? `${net.name} [${net.width}]` : net.name)));
});
