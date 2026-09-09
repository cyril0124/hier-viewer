import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import { loadSchematicGraph, parseSchematicGraph } from '../rust-hier-viewer/src/html/frontend/schematic-data';
import type { SchematicGraph } from '../rust-hier-viewer/src/html/frontend/schematic-types';
import { emptyGraph, twoModules } from './fixtures/schematic-fixture';

afterEach(() => vi.unstubAllGlobals());

test('accepts valid empty scopes and preserves instance, port, bus and ambiguous connection identities', () => {
  assert.deepEqual(parseSchematicGraph(emptyGraph()), emptyGraph());
  const graph = twoModules();
  graph.nodes.push({ ...structuredClone(graph.nodes[1]), id: 'second-consumer', instancePath: 'top.secondConsumer' });
  graph.nets[0].endpoints.push({ nodeId: 'second-consumer', portId: 'p0', role: 'sink' });
  graph.nets[1].status = 'bidirectional';
  graph.nets[1].endpoints[0].role = 'bidirectional';
  graph.nodes[0].ports[1].direction = 'inout';
  graph.nets[2].status = 'multi-driver';
  graph.nets[2].endpoints[1].role = 'driver';
  graph.nets[3].status = 'unresolved';
  graph.nets[3].endpoints[0].role = 'unknown';
  assert.deepEqual(parseSchematicGraph(graph), graph);
});

const corruptions: [string, (graph: SchematicGraph) => void][] = [
  ['unsupported version', graph => { Object.assign(graph, { version: 2 }); }],
  ['duplicate node', graph => { graph.nodes.push(graph.nodes[0]); }],
  ['duplicate port', graph => { graph.nodes[0].ports.push(graph.nodes[0].ports[0]); }],
  ['duplicate net', graph => { graph.nets.push(graph.nets[0]); }],
  ['duplicate endpoint', graph => { graph.nets[0].endpoints.push(graph.nets[0].endpoints[0]); }],
  ['missing node', graph => { graph.nets[0].endpoints[0].nodeId = 'absent'; }],
  ['missing port', graph => { graph.nets[0].endpoints[0].portId = 'absent'; }],
  ['negative width', graph => { graph.nodes[0].ports[0].width = -1; }],
  ['unsafe width', graph => { graph.nets[0].width = Number.MAX_SAFE_INTEGER + 1; }],
  ['fractional ordinal', graph => { graph.nodes[0].ports[0].ordinal = 0.5; }],
  ['unknown direction', graph => { Object.assign(graph.nodes[0].ports[0], { direction: 'sideways' }); }],
  ['unknown kind', graph => { Object.assign(graph.nodes[0], { kind: 'gate' }); }],
  ['unknown role', graph => { Object.assign(graph.nets[0].endpoints[0], { role: 'source' }); }],
  ['unknown status', graph => { Object.assign(graph.nets[0], { status: 'ok' }); }],
];

test.each(corruptions)('rejects corrupt external JSON: %s', (_name, corrupt) => {
  const graph = twoModules();
  corrupt(graph);
  assert.throws(() => parseSchematicGraph(graph), /Corrupt schematic data/);
});

test('streams split UTF-8 names and reports byte progress with and without Content-Length', async () => {
  const graph = twoModules();
  graph.nodes[0].label = '模块 α';
  const bytes = new TextEncoder().encode(JSON.stringify(graph));
  for (const knownLength of [true, false]) {
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      // One-byte chunks split multibyte characters and JSON tokens.
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { headers: knownLength ? { 'content-length': String(bytes.length) } : {} })));
    const progress: number[][] = [];
    assert.deepEqual(await loadSchematicGraph('/scope.json', new AbortController().signal, (received, total) => progress.push([received, total])), graph);
    assert.deepEqual(progress[0], [0, knownLength ? bytes.length : 0]);
    assert.deepEqual(progress.at(-1), [bytes.length, knownLength ? bytes.length : 0]);
    assert(progress.every((value, index) => !index || value[0] >= progress[index - 1][0]));
  }
});

test('missing HTTP data, malformed JSON and invalid graph remain distinct failures', async () => {
  for (const [response, pattern] of [
    [new Response('', { status: 404 }), /HTTP 404.*Regenerate/],
    [new Response('{broken'), /JSON|Unexpected|property name/],
    [Response.json({ version: 1, nodes: [], nets: [] }), /Corrupt schematic data/],
  ] as const) {
    vi.stubGlobal('fetch', vi.fn(async () => response));
    await assert.rejects(loadSchematicGraph('/scope.json', new AbortController().signal, () => {}), pattern);
  }
});

test('an abort during streaming cannot return a stale graph', async () => {
  const controller = new AbortController();
  const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(twoModules())));
  vi.stubGlobal('fetch', fetchMock);
  await assert.rejects(loadSchematicGraph('/scope.json', controller.signal, received => {
    if (received) controller.abort();
  }), { name: 'AbortError' });
  assert.deepEqual(fetchMock.mock.calls, [['/scope.json', { signal: controller.signal }]]);
});
