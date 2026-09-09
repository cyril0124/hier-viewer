import assert from 'node:assert/strict';
import { test } from 'vitest';
import { expressionGraph } from './fixtures/schematic-fixture';
import { summarizeLogic } from '../rust-hier-viewer/src/html/frontend/schematic-summary';
import { buildScene, findLinkGroups } from '../rust-hier-viewer/src/html/frontend/schematic-model';

test('large local logic summaries retain exact interface nets without modifying RTL', () => {
  const graph = expressionGraph(320);
  // Connect the first chain to a real module, so the summary has an external terminal.
  graph.nets.push({ id: 'visible', name: 'visible', width: 1, status: 'resolved', endpoints: [
    { nodeId: 'expr7', portId: 'out', role: 'driver' },
    { nodeId: 'consumer', portId: 'p0', role: 'sink' },
  ] });
  const before = structuredClone(graph);
  const summary = summarizeLogic(graph);
  assert.equal(summary.hiddenNodes, 320);
  assert.equal(summary.hiddenNets, 280);
  assert.equal(summary.graph.nodes.length, 3);
  assert.deepEqual(graph, before);
  const external = summary.graph.nets.find(net => net.id === 'visible')!;
  assert.deepEqual(external.endpoints[1], graph.nets.at(-1)!.endpoints[1]);
  const owner = summary.graph.nodes.find(node => node.id === external.endpoints[0].nodeId)!;
  assert(owner.detail.includes('320 RTL'));
  assert(owner.ports.some(port => port.id === external.endpoints[0].portId && port.direction === 'output'));
  const detail = buildScene(graph, new Set(), true);
  assert.equal(detail.nodes.filter(node => node.kind === 'expr').length, 320);
  assert.equal(detail.summary, undefined);
});

test('internal diagnostic nets remain explicit in the summary count and complete detail', () => {
  const graph = expressionGraph(320);
  graph.nets.find(net => net.id === 'dep1')!.status = 'unresolved';
  graph.nets.push({ id: 'visible', name: 'visible', width: 1, status: 'resolved', endpoints: [
    { nodeId: 'expr7', portId: 'out', role: 'driver' },
    { nodeId: 'consumer', portId: 'p0', role: 'sink' },
  ] });
  const summary = summarizeLogic(graph);
  assert.equal(summary.hiddenNets, 280);
  assert.equal(summary.graph.nodes.at(-1)!.kind, 'unresolved');
  assert.match(summary.graph.nodes.at(-1)!.detail, /1 internal nets/);
  assert(buildScene(graph, new Set(), true).edges.some(edge => edge.netIds.includes('dep1') && edge.status === 'unresolved'));
});

test('interface prefixes collect fields instead of creating one box per field', () => {
  const graph = expressionGraph(0);
  graph.nets.forEach((net, index) => { net.name = `request_lane_${index >> 1}_field_${index % 2}`; });
  const groups = findLinkGroups(graph.nets);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].netIds.length, 8);
  assert.equal(groups[0].label, 'request_lane');
});

test('scope input and output pins are separated without losing their endpoint identities', () => {
  const graph = expressionGraph(0);
  graph.nodes[0].kind = 'boundary';
  graph.nodes[0].ports.forEach((port, index) => { port.direction = index < 4 ? 'input' : 'output'; });
  const scene = buildScene(graph, new Set());
  const boundary = scene.nodes.filter(node => node.kind === 'boundary');
  assert.equal(boundary.length, 2);
  assert.deepEqual(boundary.flatMap(node => node.ports.map(port => port.id)).sort(), graph.nodes[0].ports.map(port => port.id).sort());
  assert(boundary.find(node => node.label === 'Inputs')!.ports.every(port => port.side === 'EAST'));
  assert(boundary.find(node => node.label === 'Outputs')!.ports.every(port => port.side === 'WEST'));
});
