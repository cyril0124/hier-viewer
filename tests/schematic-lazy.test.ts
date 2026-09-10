import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import { loadSchematicGraph, requestSchematicScope } from '../rust-hier-viewer/src/html/frontend/schematic-data';
import { twoModules } from './fixtures/schematic-fixture';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const scopeUrl = './api/schematic/scopes/7';
const ready = () => Response.json({ state: 'ready', url: scopeUrl });

test('lazy ready always POSTs before the graph GET and shows a notice before the first fetch', async () => {
  const controller = new AbortController();
  const notices: string[] = [];
  const fetchMock = vi.fn<typeof fetch>(async (_url, options) => {
    assert.equal(notices[0], 'Generating connections...');
    return options?.method === 'POST' ? ready() : Response.json(twoModules());
  });
  vi.stubGlobal('fetch', fetchMock);
  for (let attempt = 0; attempt < 2; attempt++) {
    const url = await requestSchematicScope(7, controller.signal, title => notices.push(title));
    assert.equal(url, scopeUrl);
    assert.deepEqual(await loadSchematicGraph(url, controller.signal, () => {}), twoModules());
  }
  assert.deepEqual(fetchMock.mock.calls, Array.from({ length: 2 }, () => [
    [scopeUrl, { method: 'POST', headers: { 'X-Hier-Schematic': '1' }, signal: controller.signal }],
    [scopeUrl, { signal: controller.signal }],
  ]).flat());
});

test('building and busy report server messages and retry after 500ms and 1s without leaking listeners', async () => {
  vi.useFakeTimers();
  const signal = new AbortController().signal;
  const add = vi.spyOn(signal, 'addEventListener');
  const remove = vi.spyOn(signal, 'removeEventListener');
  const notices: string[][] = [];
  const fetchMock = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ state: 'building', message: 'Compiling scope 7' }, { status: 202 }))
    .mockResolvedValueOnce(Response.json({ state: 'busy', message: 'Another scope is building' }, { status: 202 }))
    .mockResolvedValueOnce(ready());
  vi.stubGlobal('fetch', fetchMock);
  const pending = requestSchematicScope(7, signal, (title, detail) => notices.push([title, detail]));
  await vi.advanceTimersByTimeAsync(0);
  assert.deepEqual(notices.at(-1), ['Generating connections...', 'Compiling scope 7']);
  await vi.advanceTimersByTimeAsync(499);
  assert.equal(fetchMock.mock.calls.length, 1);
  await vi.advanceTimersByTimeAsync(1);
  assert.deepEqual(notices.at(-1), ['Waiting to generate connections...', 'Another scope is building']);
  await vi.advanceTimersByTimeAsync(999);
  assert.equal(fetchMock.mock.calls.length, 2);
  await vi.advanceTimersByTimeAsync(1);
  assert.equal(await pending, scopeUrl);
  assert.equal(fetchMock.mock.calls.length, 3);
  assert.equal(vi.getTimerCount(), 0);
  assert.equal(add.mock.calls.length, 2);
  assert.deepEqual(remove.mock.calls, add.mock.calls.map(([event, listener]) => [event, listener]));
});

test.each([404, 405])('missing local API HTTP %s explains serving and static export', async status => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>Not found</html>', { status })));
  await assert.rejects(requestSchematicScope(7, new AbortController().signal, () => {}),
    /local schematic API is unavailable.*hier-viewer serve.*--schematic.*static hosting/);
});

test('server errors preserve the actionable backend message', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'Source missing: restore design.sv' }, { status: 500 })));
  await assert.rejects(requestSchematicScope(7, new AbortController().signal, () => {}), /Source missing: restore design.sv.*retry/);
});

test('aborting a retry clears its timer and listener without another POST', async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const add = vi.spyOn(controller.signal, 'addEventListener');
  const remove = vi.spyOn(controller.signal, 'removeEventListener');
  const fetchMock = vi.fn(async () => Response.json({ state: 'busy', message: 'Waiting' }, { status: 202 }));
  vi.stubGlobal('fetch', fetchMock);
  const pending = requestSchematicScope(7, controller.signal, () => {});
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await vi.advanceTimersByTimeAsync(0);
  assert.equal(vi.getTimerCount(), 1);
  controller.abort();
  await rejected;
  assert.equal(vi.getTimerCount(), 0);
  assert.deepEqual(remove.mock.calls, add.mock.calls.map(([event, listener]) => [event, listener]));
  await vi.advanceTimersByTimeAsync(2000);
  assert.equal(fetchMock.mock.calls.length, 1);
});

test.each(['ready', 'building'] as const)('a late %s POST response after cancellation cannot return a graph URL or schedule a timer', async state => {
  vi.useFakeTimers();
  const controller = new AbortController();
  let complete!: (response: Response) => void;
  const fetchMock = vi.fn(() => new Promise<Response>(resolve => { complete = resolve; }));
  vi.stubGlobal('fetch', fetchMock);
  const notice = vi.fn();
  const pending = requestSchematicScope(7, controller.signal, notice);
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  controller.abort();
  complete(state === 'ready' ? ready() : Response.json({ state, message: 'Building' }, { status: 202 }));
  await rejected;
  assert.equal(notice.mock.calls.length, 1);
  assert.equal(vi.getTimerCount(), 0);
  assert.equal(fetchMock.mock.calls.length, 1);
});

test('cancellation while parsing a ready response cannot return its URL', async () => {
  const controller = new AbortController();
  let complete!: (value: unknown) => void;
  const response = ready();
  let started!: () => void;
  const parsing = new Promise<void>(resolve => { started = resolve; });
  vi.spyOn(response, 'json').mockImplementation(() => {
    started();
    return new Promise(resolve => { complete = resolve; });
  });
  vi.stubGlobal('fetch', vi.fn(async () => response));
  const pending = requestSchematicScope(7, controller.signal, () => {});
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await parsing;
  controller.abort();
  complete({ state: 'ready', url: scopeUrl });
  await rejected;
});

test('a pre-aborted request does not update the notice or fetch', async () => {
  const controller = new AbortController();
  controller.abort();
  const fetchMock = vi.fn();
  const notice = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  await assert.rejects(requestSchematicScope(7, controller.signal, notice), { name: 'AbortError' });
  assert.equal(fetchMock.mock.calls.length, 0);
  assert.equal(notice.mock.calls.length, 0);
});
