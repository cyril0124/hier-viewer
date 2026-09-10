import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, test } from 'vitest';
import { createServer, type ViteDevServer } from 'vite';
import { chromium, type Browser, type Page } from 'playwright';
import type { createSchematic } from '../rust-hier-viewer/src/html/frontend/schematic';
import type { SchematicScene } from '../rust-hier-viewer/src/html/frontend/schematic-types';
import { CLEARANCE, GRID, validateRoutes } from '../rust-hier-viewer/src/html/frontend/schematic-routing';
import { emptyGraph, expressionGraph, twoModules } from './fixtures/schematic-fixture';

declare global {
  interface Window {
    schematicTest: {
      controller: ReturnType<typeof createSchematic>;
      navigated: string[];
      sources: string[];
      frames: number;
      frameGaps: number[];
      stages: string[];
    };
  }
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const evidence = resolve(root, 'target/schematic-evidence/browser');
let server: ViteDevServer;
let browser: Browser;
let baseUrl: string;
const errors = new WeakMap<Page, string[]>();
const requests = new WeakMap<Page, string[]>();

function mountFixture(create: typeof createSchematic) {
  const navigated: string[] = [], sources: string[] = [];
  const controller = create({
    container: document.querySelector<HTMLElement>('#schematic-stage')!,
    available: new URLSearchParams(location.search).get('available') !== 'false',
    onDemand: new URLSearchParams(location.search).get('mode') === 'lazy',
    directory: 'schematic', scopePath: id => id === 0 ? 'top' : `top.scope${id}`,
    navigate: path => navigated.push(path), openSource: path => sources.push(path), hasSource: () => true,
  });
  window.schematicTest = { controller, navigated, sources, frames: 0, frameGaps: [], stages: [] };
  let previous = performance.now();
  const tick = (time: number) => {
    window.schematicTest.frames++;
    window.schematicTest.frameGaps.push(time - previous);
    previous = time;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  new MutationObserver(() => {
    const notice = document.querySelector('.schematic-notice');
    if (notice && !(notice as HTMLElement).hidden) window.schematicTest.stages.push(notice.textContent || '');
  }).observe(document.querySelector('#schematic-stage')!, { subtree: true, childList: true, characterData: true });
  controller.setActive(true, 0);
}

beforeAll(async () => {
  await mkdir(evidence, { recursive: true });
  const htmlRoot = resolve(root, 'rust-hier-viewer/src/html');
  const styles = await readFile(resolve(htmlRoot, 'template_styles.css'), 'utf8');
  // Fail immediately if the local production worker has not been built.
  await readFile(resolve(htmlRoot, 'generated/viewer-schematic-worker.js'));
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${styles}
    #schematic-stage { position: fixed; inset: 0; width: 100vw; height: 100vh; }
    </style></head><body><div id="schematic-stage" class="schematic-stage"></div><script type="module">
    import { createSchematic } from '/rust-hier-viewer/src/html/frontend/schematic.ts';
    (${mountFixture.toString()})(createSchematic);
    </script></body></html>`;
  server = await createServer({
    configFile: false, root, publicDir: false, appType: 'custom',
    server: { host: '127.0.0.1', port: 0, watch: null },
    plugins: [{ name: 'schematic-browser-fixture', configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        const path = request.url?.split('?')[0];
        if (path === '/schematic-fixture.html') {
          response.writeHead(200, { 'content-type': 'text/html' });
          response.end(html);
        } else if (path === '/viewer-schematic-worker.js') {
          void readFile(resolve(htmlRoot, `generated/${path.slice(1)}`)).then(body => {
            response.writeHead(200, { 'content-type': 'text/javascript' });
            response.end(body);
          }).catch(error => { response.writeHead(500); response.end(String(error)); });
        } else if (path?.startsWith('/schematic/')) {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify(path.endsWith('/1.json') ? emptyGraph('top.scope1') : twoModules()));
        } else next();
      });
    } }],
  });
  await server.listen();
  baseUrl = server.resolvedUrls!.local[0];
  browser = await chromium.launch({ headless: true });
}, 60_000);

afterAll(async () => { await browser?.close(); await server?.close(); });

async function newPage() {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(10_000);
  errors.set(page, []);
  requests.set(page, []);
  page.on('pageerror', error => errors.get(page)!.push(error.message));
  page.on('request', request => requests.get(page)!.push(request.url()));
  return page;
}

async function settle(page: Page) {
  await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
}

async function ready(page: Page) {
  await page.waitForFunction(() => window.schematicTest && !window.schematicTest.controller.inspect().loading, undefined, { timeout: 45_000 });
  const state = await inspect(page);
  assert(state.scene, await page.locator('.schematic-notice').textContent() || 'No scene');
  await settle(page);
  return state;
}

async function openPage(graph = twoModules()) {
  const page = await newPage();
  await page.route('**/schematic/0.json', route => route.fulfill({ json: graph }));
  await page.goto(`${baseUrl}schematic-fixture.html`);
  try {
    await ready(page);
    return page;
  } catch (error) {
    await screenshot(page, 'initialization-failure');
    await finish(page);
    throw error;
  }
}

async function inspect(page: Page) { return page.evaluate(() => window.schematicTest.controller.inspect()); }

async function screenshot(page: Page, name: string) {
  await page.screenshot({ path: resolve(evidence, `${name}.png`), fullPage: true });
  await writeFile(resolve(evidence, `${name}.json`), JSON.stringify(await inspect(page), null, 2));
}

async function finish(page: Page) {
  const actualErrors = errors.get(page)!;
  await page.context().close();
  assert.deepEqual(actualErrors, [], 'No uncaught browser exceptions');
}

function geometry(scene: SchematicScene) {
  assert.deepEqual(validateRoutes(scene), [], 'Every route must remain orthogonal, clear of obstacles and attached to its ports');
  for (let index = 0; index < scene.nodes.length; index++) {
    const node = scene.nodes[index];
    for (const other of scene.nodes.slice(index + 1)) {
      assert(node.x + node.width + CLEARANCE <= other.x || other.x + other.width + CLEARANCE <= node.x
        || node.y + node.height + CLEARANCE <= other.y || other.y + other.height + CLEARANCE <= node.y,
      `Node clearance: ${node.id}, ${other.id}`);
    }
  }
}

async function nodePoint(page: Page, id: string) {
  return page.evaluate(id => {
    const node = window.schematicTest.controller.inspect().scene!.nodes.find(node => node.id === id)!;
    const camera = window.schematicTest.controller.inspect().camera!;
    const bounds = document.querySelector('.schematic-viewport > svg')!.getBoundingClientRect();
    return { x: bounds.x + camera.x + (node.x + node.width / 2) * camera.zoom, y: bounds.y + camera.y + (node.y + 18) * camera.zoom };
  }, id);
}

async function clickNode(page: Page, id: string, button: 'left' | 'right' = 'left') {
  const point = await nodePoint(page, id);
  await page.mouse.click(point.x, point.y, { button });
  await settle(page);
}

async function assertDomPaths(page: Page) {
  assert.deepEqual(await page.evaluate(() => {
    const scene = window.schematicTest.controller.inspect().scene!;
    const elements = new Map([...document.querySelectorAll<SVGGElement>('[data-edge-id]')]
      .flatMap(element => (JSON.parse(element.dataset.edgeIds!) as string[]).map(id => [id, element] as const)));
    return scene.edges.filter(edge => elements.get(edge.id)?.querySelector('.schematic-wire-line')?.getAttribute('d') !== edge.points.map((point, index) => `${index ? 'L' : 'M'}${point.x},${point.y}`).join(' ')).map(edge => edge.id);
  }), [], 'DOM paths match live geometry before pointerup');
}

test('two modules and two groups have a compact, deterministic, legible initial layout', async () => {
  const page = await openPage();
  try {
    const { scene, metrics } = await inspect(page);
    geometry(scene!);
    assert.equal(scene!.nodes.filter(node => node.kind === 'module').length, 2);
    assert.equal(scene!.groups.length, 2);
    assert.equal(metrics.layouts, 1);
    const producer = scene!.nodes.find(node => node.id === 'producer')!;
    const consumer = scene!.nodes.find(node => node.id === 'consumer')!;
    for (const group of scene!.nodes.filter(node => node.kind === 'group')) {
      assert(group.x >= producer.x + producer.width && group.x + group.width <= consumer.x);
    }
    assert(scene!.width < 1800 && scene!.height < 1200, 'Simple layout has bounded whitespace');
    assert.deepEqual(await page.locator('.schematic-bus .schematic-wire-line').evaluateAll(paths => [...new Set(paths.map(path => getComputedStyle(path).strokeWidth))]), ['2.5px']);
    assert.equal(await page.locator('.schematic-wire').count(), 4, 'Eight nets use four visible bus legs');
    const labelsFit = await page.locator('.schematic-node').evaluateAll(nodes => nodes.every(node => {
      const box = node.querySelector('rect')!;
      const width = Number(box.getAttribute('width')), height = Number(box.getAttribute('height'));
      return [...node.querySelectorAll('text')].every(text => {
        const bounds = text.getBBox();
        return bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= width && bounds.y + bounds.height <= height;
      });
    }));
    assert(labelsFit, 'Rendered text bounds stay inside rectangles');
    assert(requests.get(page)!.includes(`${baseUrl}viewer-schematic-worker.js`), 'Browser loads the local production worker');
    assert(requests.get(page)!.every(url => url.startsWith(baseUrl)), 'No CDN or layout service requests');
    await screenshot(page, 'two-modules');
    const second = await openPage();
    try { assert.deepEqual((await inspect(second)).scene, scene); } finally { await finish(second); }
  } finally { await finish(page); }
}, 60_000);

test('bus clicks pin the signal inspector without changing the canvas', async () => {
  const page = await openPage();
  try {
    const initial = await inspect(page);
    const groups = initial.scene!.groups;
    const moduleElement = await page.locator('[data-node-id="producer"]').elementHandle();
    const wireElement = await page.locator('[data-edge-id]').first().elementHandle();
    await page.evaluate(() => {
      Worker.prototype.postMessage = () => { throw new Error('A bus click contacted the layout worker'); };
    });
    for (const group of groups) {
      await clickNode(page, group.id);
      const card = page.getByRole('dialog', { name: 'Schematic details' });
      await card.waitFor({ state: 'visible' });
      assert.deepEqual((await inspect(page)).expanded, []);
      assert.equal((await inspect(page)).scene!.height, initial.scene!.height);
      assert.equal(await card.locator('.schematic-signal-detail').count(), group.netIds.length);
      await page.getByRole('button', { name: 'Close schematic details' }).click();
    }
    const state = await inspect(page);
    assert.equal(state.metrics.layouts, initial.metrics.layouts);
    assert(await moduleElement!.evaluate(node => node.isConnected), 'Module DOM is retained after bus inspection');
    assert(await wireElement!.evaluate(node => node.isConnected), 'Wire DOM is retained after bus inspection');
    geometry(state.scene!);
  } finally { await finish(page); }
}, 60_000);

test('reset layout reruns initial placement and keeps buses collapsed', async () => {
  const page = await openPage();
  try {
    const initial = await inspect(page);
    await page.getByRole('button', { name: 'Reset schematic layout' }).click();
    await page.waitForFunction(layouts => window.schematicTest.controller.inspect().metrics.layouts > layouts, initial.metrics.layouts);
    const reset = await ready(page);
    assert.deepEqual(reset.expanded, []);
    assert.equal(reset.metrics.layouts, initial.metrics.layouts + 1);
    assert.equal(await page.locator('#schematic-rtl-detail').isChecked(), false);
    await screenshot(page, 'reset-layout');
  } finally { await finish(page); }
}, 60_000);

test('long names and dense ports fit; group hover card scrolls, pins, drags and closes without canvas gestures', async () => {
  const page = await openPage(twoModules(64, true));
  try {
    const state = await inspect(page);
    geometry(state.scene!);
    for (const node of state.scene!.nodes.filter(node => node.kind === 'module')) {
      assert.equal(node.ports.length, 64);
      const terminals = node.ports.filter(port => !port.hidden);
      assert.equal(terminals.length, 2, 'Dense raw pins share their two interface terminals');
      assert(terminals[1].y - terminals[0].y >= 24);
    }
    assert(await page.locator('.schematic-module').evaluateAll(nodes => nodes.every(node => {
      const width = Number(node.querySelector('rect')!.getAttribute('width'));
      return [...node.querySelectorAll('text')].every(text => text.getBBox().x >= 0 && text.getBBox().x + text.getBBox().width <= width);
    })));
    const point = await nodePoint(page, state.scene!.groups[0].id);
    await page.mouse.move(point.x, point.y);
    const card = page.getByRole('dialog', { name: 'Schematic details' });
    await card.waitFor({ state: 'visible' });
    await page.mouse.click(point.x, point.y);
    assert.deepEqual((await inspect(page)).expanded, state.expanded, 'Large buses use the signal inspector without resizing the scene');
    assert.equal(await card.isVisible(), true);
    assert.equal((await inspect(page)).scene!.height, state.scene!.height);
    const viewportBox = (await page.locator('.schematic-viewport').boundingBox())!;
    const anchored = (await card.boundingBox())!;
    assert.equal(await card.evaluate(node => getComputedStyle(node).transform), 'none', 'Fixed corner cards must not slide on appearance');
    assert(Math.abs(anchored.y - viewportBox.y - 12) < 1);
    assert(Math.abs(viewportBox.x + viewportBox.width - anchored.x - anchored.width - 12) < 1);
    await screenshot(page, 'card-upper-right');
    // Travel via blank canvas more slowly than the old hover-close timeout.
    await page.mouse.move(20, viewportBox.y + 20);
    await page.waitForTimeout(300);
    assert(await card.isVisible(), 'A fixed-corner card remains reachable across the canvas');
    await card.locator('.hover-title').hover();
    await page.waitForTimeout(300); // Cross the production 220 ms hover-close timer while inside the card.
    assert(await card.isVisible());
    const list = card.locator('.schematic-signal-list');
    assert.equal(await list.locator('.schematic-signal-detail').count(), 32);
    assert(await list.evaluate(element => element.scrollHeight > element.clientHeight));
    await list.hover();
    await page.mouse.wheel(0, 500);
    await page.waitForFunction(() => document.querySelector('.schematic-signal-list')!.scrollTop > 0);
    await card.locator('.hover-title').click();
    assert((await card.getAttribute('class'))?.includes('locked'));
    const camera = (await inspect(page)).camera;
    const cardBox = (await card.boundingBox())!;
    const header = (await card.locator('.hover-topbar').boundingBox())!;
    await page.mouse.move(header.x + header.width / 2, header.y + header.height / 2);
    await page.mouse.down();
    await page.mouse.move(header.x + header.width / 2 - 80, header.y + header.height / 2 + 45, { steps: 4 });
    await page.mouse.up();
    assert.notDeepEqual(await card.boundingBox(), cardBox);
    assert.deepEqual((await inspect(page)).camera, camera);
    assert.equal((await inspect(page)).metrics.layouts, state.metrics.layouts);
    await screenshot(page, 'dense-ports-pinned-card');
    await page.getByRole('button', { name: 'Close schematic details' }).click();
    assert(!(await card.isVisible()));
  } finally { await finish(page); }
}, 60_000);

async function interiorWire(page: Page) {
  return page.evaluate(() => {
    const { scene, camera } = window.schematicTest.controller.inspect();
    const bounds = document.querySelector('.schematic-viewport > svg')!.getBoundingClientRect();
    for (const edge of scene!.edges) {
      // Endpoint stubs are deliberately fixed. Test an actual hittable interior segment.
      for (let index = 1; index < edge.points.length - 2; index++) {
        const a = edge.points[index], b = edge.points[index + 1];
        if (Math.abs(a.x - b.x) + Math.abs(a.y - b.y) < 24) continue;
        const x = bounds.x + camera!.x + (a.x + b.x) / 2 * camera!.zoom;
        const y = bounds.y + camera!.y + (a.y + b.y) / 2 * camera!.zoom;
        const hit = document.elementFromPoint(x, y)?.closest<SVGGElement>('[data-edge-id]');
        if (hit?.dataset.edgeId === edge.id) return { id: edge.id, index, x, y, vertical: a.x === b.x };
      }
    }
    throw new Error('Fixture has no visible draggable interior wire segment');
  });
}

test('wire hover glows and click selects without expansion; module card opens source and hierarchy', async () => {
  const page = await openPage();
  try {
    const before = await inspect(page);
    const wire = await interiorWire(page);
    await page.mouse.move(wire.x, wire.y);
    const glow = page.locator('.schematic-wire-hover');
    assert.equal(await glow.getAttribute('visibility'), 'visible');
    assert.equal(await glow.getAttribute('data-highlight-edge'), wire.id);
    const highlightedPaths = await glow.locator('.schematic-highlight-line').evaluateAll(paths => paths.map(path => path.getAttribute('d')));
    assert(highlightedPaths.length > 1, 'Highlight follows both legs through a collapsed bus');
    const visiblePaths = await page.locator('.schematic-wire-line').evaluateAll(paths => paths.map(path => path.getAttribute('d')));
    assert(highlightedPaths.some(path => visiblePaths.includes(path)));
    assert.equal(await glow.evaluate(node => getComputedStyle(node).pointerEvents), 'none');
    const colors = await glow.locator('.schematic-highlight-line').first().evaluate(node => ({
      stroke: getComputedStyle(node).stroke,
      width: getComputedStyle(node).strokeWidth,
      vectorEffect: getComputedStyle(node).vectorEffect,
    }));
    assert.equal(colors.width, '2.5px');
    assert.equal(colors.vectorEffect, 'non-scaling-stroke');
    assert.notEqual(colors.stroke, await page.locator('.schematic-wire-line').first().evaluate(node => getComputedStyle(node).stroke));
    await screenshot(page, 'wire-hover-highlight');
    await page.mouse.click(wire.x, wire.y);
    console.log(await page.evaluate(() => ({ classes: [...document.querySelectorAll('.schematic-wire')].map(node => node.getAttribute('class')), selection: document.querySelector('.schematic-wire-selection')?.outerHTML.slice(0, 500), card: document.querySelector('#schematic-hover-card')?.className })));
    assert.equal(await page.locator('.schematic-wire.selected').count(), 1);
    assert.equal(await page.locator('.schematic-wire-selection').getAttribute('data-highlight-edge'), wire.id);
    const secondWire = await page.evaluate(firstId => {
      const candidate = [...document.querySelectorAll<SVGGElement>('.schematic-wire')]
        .find(group => group.dataset.edgeId !== firstId);
      if (!candidate) throw new Error('Fixture has no second visible wire');
      const path = candidate.querySelector<SVGPathElement>('.schematic-wire-hit')!;
      const point = path.getPointAtLength(path.getTotalLength() / 2);
      const screen = new DOMPoint(point.x, point.y).matrixTransform(path.getScreenCTM()!);
      return { id: candidate.dataset.edgeId!, x: screen.x, y: screen.y };
    }, wire.id);
    await page.keyboard.down('Control');
    await page.mouse.click(secondWire.x, secondWire.y);
    await page.keyboard.up('Control');
    assert.equal(await page.locator('.schematic-wire.selected').count(), 2);
    const selectedEdges = JSON.parse((await page.locator('.schematic-wire-selection').getAttribute('data-highlight-edges'))!);
    assert(selectedEdges.includes(wire.id));
    assert(selectedEdges.includes(secondWire.id));
    await page.mouse.move(12, 90);
    assert.equal(await glow.getAttribute('visibility'), 'hidden');
    assert.equal(await page.locator('.schematic-wire-selection').getAttribute('visibility'), 'visible');
    assert.deepEqual((await inspect(page)).expanded, before.expanded);
    assert.equal((await inspect(page)).metrics.layouts, before.metrics.layouts);
    await clickNode(page, 'producer');
    assert.equal(await page.locator('.schematic-module.selected').count(), 1);
    await page.getByRole('button', { name: 'Open source', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.schematicTest.sources), ['top.producer']);
    await page.getByRole('button', { name: 'Enter hierarchy', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.schematicTest.navigated), ['top.producer']);
    assert(!(await page.getByRole('dialog', { name: 'Schematic details' }).isVisible()));
    await page.locator('[data-node-id="producer"]').dblclick();
    assert.deepEqual(await page.evaluate(() => window.schematicTest.navigated), ['top.producer', 'top.producer'], 'Native double-click retains the node identity through pointer capture');
  } finally { await finish(page); }
}, 60_000);

test('grid module drags update paths during gesture, preserve clearance and suppress clicks', async () => {
  const page = await openPage();
  try {
    await page.getByRole('button', { name: 'Fit schematic' }).click();
    await page.locator('#schematic-show-grid').check();
    await page.locator('#schematic-snap-grid').check();
    assert.equal(await page.locator('.schematic-grid').evaluate(node => getComputedStyle(node).pointerEvents), 'none');
    for (const id of ['producer']) {
      const before = await inspect(page);
      const point = await nodePoint(page, id);
      const original = before.scene!.nodes.find(node => node.id === id)!;
      const direction = [{ x: -1, y: -1 }, { x: 1, y: -1 }, { x: -1, y: 1 }, { x: 1, y: 1 }].find(direction =>
        [14, 27, 39].every(delta => {
          const x = Math.round((original.x + delta * direction.x) / GRID) * GRID;
          const y = Math.round((original.y + delta * direction.y) / GRID) * GRID;
          return before.scene!.nodes.every(other => other.id === id
            || x + original.width + CLEARANCE * 2 <= other.x || other.x + other.width + CLEARANCE * 2 <= x
            || y + original.height + CLEARANCE * 2 <= other.y || other.y + other.height + CLEARANCE * 2 <= y);
        }));
      assert(direction, `Fixture needs a collision-free drag direction for ${id}`);
      await page.mouse.move(point.x, point.y);
      await page.mouse.down();
      for (const delta of [14, 27, 39]) {
        await page.mouse.move(point.x + direction.x * delta * before.camera!.zoom, point.y + direction.y * delta * before.camera!.zoom);
        await settle(page);
        const current = await inspect(page);
        geometry(current.scene!);
        await assertDomPaths(page);
        const moved = current.scene!.nodes.find(node => node.id === id)!;
        assert(moved.x !== original.x || moved.y !== original.y, `Node ${id} moves before release`);
        assert.equal(Math.abs(moved.x % GRID), 0);
        assert.equal(Math.abs(moved.y % GRID), 0);
      }
      await page.mouse.up();
      assert.deepEqual((await inspect(page)).expanded, before.expanded);
      assert.equal((await inspect(page)).metrics.layouts, before.metrics.layouts);
      assert.equal(await page.locator('.schematic-module.selected').count(), 0);
      assert(!(await page.locator('#schematic-hover-card').getAttribute('class'))?.includes('locked'));
    }
    await screenshot(page, 'grid-drag');
  } finally { await finish(page); }
}, 60_000);

test('grid wire drag moves an interior bend continuously while both endpoint stubs stay attached', async () => {
  const page = await openPage();
  try {
    await page.locator('#schematic-show-grid').check();
    await page.locator('#schematic-snap-grid').check();
    const before = await inspect(page);
    const wire = await interiorWire(page);
    const original = before.scene!.edges.find(edge => edge.id === wire.id)!;
    await page.mouse.move(wire.x, wire.y);
    await page.mouse.down();
    for (const delta of [14, 26, 38]) {
      await page.mouse.move(wire.x + (wire.vertical ? delta * before.camera!.zoom : 0), wire.y + (wire.vertical ? 0 : delta * before.camera!.zoom));
      await settle(page);
      const state = await inspect(page);
      geometry(state.scene!);
      const current = state.scene!.edges.find(edge => edge.id === wire.id)!;
      assert.notDeepEqual(current.points, original.points, 'Interior route changes before release');
      assert.deepEqual(current.points[0], original.points[0]);
      assert.deepEqual(current.points.at(-1), original.points.at(-1));
      await assertDomPaths(page);
      const members = await page.locator('[data-edge-id]').evaluateAll((elements, id) => {
        const element = elements.find(element => (element as SVGGElement).dataset.edgeId === id) as SVGGElement;
        return JSON.parse(element.dataset.edgeIds!) as string[];
      }, wire.id);
      for (const other of before.scene!.edges.filter(edge => !members.includes(edge.id))) {
        assert.deepEqual(state.scene!.edges.find(edge => edge.id === other.id)!.points, other.points, 'Wire drag preserves unrelated routes');
      }
    }
    await page.mouse.up();
    assert.equal((await inspect(page)).metrics.layouts, before.metrics.layouts);
    assert.equal(await page.locator('.schematic-wire.selected').count(), 0);
    assert.deepEqual((await inspect(page)).expanded, before.expanded);
  } finally { await finish(page); }
}, 60_000);

test('mouse-anchored zoom and unrestricted pan transform grid without any layout or route changes', async () => {
  const page = await openPage();
  try {
    await page.locator('#schematic-show-grid').check();
    const before = await inspect(page);
    const bounds = (await page.locator('.schematic-viewport > svg').boundingBox())!;
    const anchor = { x: 320, y: 200 };
    const world = { x: (anchor.x - before.camera!.x) / before.camera!.zoom, y: (anchor.y - before.camera!.y) / before.camera!.zoom };
    await page.mouse.move(bounds.x + anchor.x, bounds.y + anchor.y);
    await page.mouse.wheel(0, -220);
    await page.waitForFunction(zoom => window.schematicTest.controller.inspect().camera!.zoom !== zoom, before.camera!.zoom);
    let state = await inspect(page);
    assert(Math.abs((anchor.x - state.camera!.x) / state.camera!.zoom - world.x) < 0.001);
    assert(Math.abs((anchor.y - state.camera!.y) / state.camera!.zoom - world.y) < 0.001);
    for (let repeat = 0; repeat < 4; repeat++) {
      // Near the corner is blank initially; after each pan content moves away from it.
      await page.mouse.move(bounds.x + 15, bounds.y + 15);
      await page.mouse.down();
      await page.mouse.move(bounds.x + 515, bounds.y + 215, { steps: 3 });
      await page.mouse.up();
    }
    state = await inspect(page);
    assert(state.camera!.x > 1440, 'Pan is allowed beyond the content and viewport bounds');
    assert.deepEqual(state.scene, before.scene);
    assert.equal(state.metrics.layouts, before.metrics.layouts);
    assert.equal(await page.locator('#schematic-grid-pattern').getAttribute('patternTransform'), await page.locator('.schematic-world').getAttribute('transform'));
    assert(await page.locator('.schematic-viewport').evaluate(node => node.scrollWidth === node.clientWidth && node.scrollHeight === node.clientHeight));
  } finally { await finish(page); }
}, 60_000);

test('hundreds of expressions use the real worker while continuous dragging remains responsive', async () => {
  const started = performance.now();
  const page = await openPage(expressionGraph());
  try {
    let state = await inspect(page);
    assert.equal(state.scene!.nodes.filter(node => node.kind === 'expr').length, 240);
    geometry(state.scene!);
    assert(state.metrics.layoutMs > 0 && state.metrics.layoutMs < 30_000, JSON.stringify(state.metrics));
    assert((await page.evaluate(() => window.schematicTest.frames)) > 2, 'Animation frames continue during worker layout');
    const inspectStarted = performance.now();
    const beforeInspect = state.metrics.layouts;
    const busId = state.scene!.groups[0]?.id;
    if (busId) {
      await clickNode(page, busId);
      await page.getByRole('dialog', { name: 'Schematic details' }).waitFor({ state: 'visible' });
    }
    const inspectMs = performance.now() - inspectStarted;
    const expandMs = inspectMs;
    state = await inspect(page);
    assert.equal(state.metrics.layouts, beforeInspect);
    assert.deepEqual(state.expanded, []);
    geometry(state.scene!);
    const id = 'expr0';
    // Zoom around this real node for a usable gesture even when the initial fit is tiny.
    const point = await nodePoint(page, id);
    const bounds = (await page.locator('.schematic-viewport > svg').boundingBox())!;
    await page.evaluate(({ factor, anchor }) => window.schematicTest.controller.zoomByFactor(factor, anchor), { factor: 1 / state.camera!.zoom, anchor: { x: point.x - bounds.x, y: point.y - bounds.y } });
    const dragPoint = await nodePoint(page, id);
    const beforeDrag = await inspect(page);
    await page.mouse.move(dragPoint.x, dragPoint.y);
    await page.mouse.down();
    for (let frame = 1; frame <= 12; frame++) {
      await page.mouse.move(dragPoint.x - frame * 2, dragPoint.y + frame * 2);
      await settle(page);
    }
    await page.mouse.up();
    state = await inspect(page);
    geometry(state.scene!);
    assert(state.metrics.dragFrames - beforeDrag.metrics.dragFrames >= 10, JSON.stringify(state.metrics));
    assert(state.metrics.maxDragMs < 100, JSON.stringify(state.metrics));
    assert.equal(state.metrics.layouts, beforeDrag.metrics.layouts);
    await page.getByRole('button', { name: 'Fit schematic' }).click();
    await screenshot(page, '240-expressions');
    await writeFile(resolve(evidence, 'performance.json'), JSON.stringify({ expressions: 240, nodes: state.scene!.nodes.length, edges: state.scene!.edges.length, totalMs: performance.now() - started, expandMs, metrics: state.metrics, frameGaps: await page.evaluate(() => window.schematicTest.frameGaps) }, null, 2));
  } finally { await finish(page); }
}, 60_000);

test('local RTL summaries switch to complete detail and back without refetching the scope', async () => {
  const graph = expressionGraph(320);
  graph.nets.push({ id: 'visible', name: 'visible', width: 1, status: 'resolved', endpoints: [
    { nodeId: 'expr7', portId: 'out', role: 'driver' },
    { nodeId: 'consumer', portId: 'p0', role: 'sink' },
  ] });
  const page = await openPage(graph);
  try {
    const initial = await inspect(page);
    assert.equal(initial.scene!.summary?.nodes, 320);
    assert.equal(initial.scene!.nodes.filter(node => node.kind === 'expr').length, 0);
    assert.match((await page.locator('.schematic-legend').textContent())!, /320 local logic nodes summarized/);
    await page.getByLabel('RTL detail', { exact: true }).check();
    const detail = await ready(page);
    assert.equal(detail.scene!.nodes.filter(node => node.kind === 'expr').length, 320);
    geometry(detail.scene!);
    await page.getByLabel('RTL detail', { exact: true }).uncheck();
    const collapsed = await ready(page);
    assert.equal(collapsed.scene!.summary?.nodes, 320);
    geometry(collapsed.scene!);
    assert.equal(requests.get(page)!.filter(url => url.endsWith('/schematic/0.json')).length, 1);
    await screenshot(page, 'logic-summary');
  } finally { await finish(page); }
}, 60_000);

test('partial RTL exports display a persistent warning while keeping the graph usable', async () => {
  const graph = twoModules();
  graph.nodes.push({ id: 'top:elaboration-errors', kind: 'unresolved', label: 'Elaboration errors',
    instancePath: null, detail: 'Compilation reported errors; connectivity may be incomplete.', ports: [] });
  const page = await openPage(graph);
  try {
    assert.match((await page.locator('.schematic-stats').textContent())!, /Partial RTL/);
    assert.match((await page.locator('.schematic-legend').textContent())!, /resolve compilation errors/);
    assert((await inspect(page)).scene!.nodes.length > 1);
    await screenshot(page, 'partial-export');
  } finally { await finish(page); }
}, 60_000);

test.each([
    { name: 'missing-capability', available: false, status: 200, body: JSON.stringify(twoModules()), expected: /Schematic data is missing.*Regenerate/s },
    { name: 'missing-file', available: true, status: 404, body: '', expected: /Schematic unavailable.*HTTP 404/s },
    { name: 'empty', available: true, status: 200, body: JSON.stringify(emptyGraph()), expected: /No connections.*valid empty schematic/s },
    { name: 'corrupt', available: true, status: 200, body: JSON.stringify({ ...twoModules(), nodes: [] }), expected: /Schematic unavailable.*Corrupt schematic data/s },
    { name: 'invalid-json', available: true, status: 200, body: '{broken', expected: /Schematic unavailable.*JSON/s },
])('data state $name shows a distinct visible message', async fixture => {
    const page = await newPage();
    try {
      await page.route('**/schematic/0.json', route => route.fulfill({ status: fixture.status, body: fixture.body, contentType: 'application/json' }));
      await page.goto(`${baseUrl}schematic-fixture.html?available=${fixture.available}`);
      await page.waitForFunction(() => window.schematicTest && !window.schematicTest.controller.inspect().loading);
      assert.match((await page.locator('.schematic-notice').textContent())!, fixture.expected);
      assert(await page.locator('.schematic-notice').isVisible());
      assert.equal(await page.locator('[data-node-id]').count(), 0);
      if (!fixture.available) assert(!requests.get(page)!.some(url => url.endsWith('/schematic/0.json')));
      await screenshot(page, fixture.name);
    } finally { await finish(page); }
}, 60_000);

test('lazy scopes show generation immediately, poll building and busy, and load the ready graph', async () => {
  const page = await newPage();
  const methods: string[] = [];
  let posts = 0;
  try {
    await page.route('**/api/schematic/scopes/0', async route => {
      const request = route.request();
      methods.push(request.method());
      if (request.method() === 'GET') {
        await route.fulfill({ json: twoModules() });
        return;
      }
      assert.equal(request.headers()['x-hier-schematic'], '1');
      assert.equal(request.postData(), null);
      if (++posts === 1) {
        assert.match((await page.locator('.schematic-notice').textContent())!, /Generating connections/);
        await route.fulfill({ status: 202, json: { state: 'building', message: 'Compiling scope zero' } });
      } else if (posts === 2) {
        await route.fulfill({ status: 202, json: { state: 'busy', message: 'Waiting for another scope' } });
      } else {
        await route.fulfill({ json: { state: 'ready', url: './api/schematic/scopes/0' } });
      }
    });
    await page.goto(`${baseUrl}schematic-fixture.html?mode=lazy&available=false`);
    const state = await ready(page);
    assert.equal(state.scopePath, 'top');
    assert.equal(state.metrics.layouts, 1);
    assert.deepEqual(methods, ['POST', 'POST', 'POST', 'GET']);
    const stages = await page.evaluate(() => window.schematicTest.stages);
    assert(stages.some(stage => stage.includes('Compiling scope zero')));
    assert(stages.some(stage => stage.includes('Waiting for another scope')));
    assert(!requests.get(page)!.some(url => url.includes('/schematic/0.json')));
  } finally { await finish(page); }
}, 60_000);

test.each([404, 405])('lazy API HTTP %s offers serve instructions and a working retry', async status => {
  const page = await newPage();
  let missing = true;
  try {
    await page.route('**/api/schematic/scopes/0', route => {
      if (missing) return route.fulfill({ status, body: 'API unavailable' });
      return route.fulfill({ json: route.request().method() === 'POST'
        ? { state: 'ready', url: './api/schematic/scopes/0' } : twoModules() });
    });
    await page.goto(`${baseUrl}schematic-fixture.html?mode=lazy`);
    await page.waitForFunction(() => window.schematicTest && !window.schematicTest.controller.inspect().loading);
    assert.match((await page.locator('.schematic-notice').textContent())!, /hier-viewer serve.*--schematic/s);
    missing = false;
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    assert.equal((await ready(page)).scopePath, 'top');
  } finally { await finish(page); }
}, 60_000);

test.each(['hide', 'switch'] as const)('lazy delayed readiness after %s cannot fetch or lay out the old scope', async action => {
  const page = await newPage();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let requestSeen!: () => void;
  const seen = new Promise<void>(resolve => { requestSeen = resolve; });
  let finished!: () => void;
  const fulfilled = new Promise<void>(resolve => { finished = resolve; });
  const graphGets: string[] = [];
  try {
    await page.route('**/api/schematic/scopes/*', async route => {
      const request = route.request();
      if (request.method() === 'GET') {
        graphGets.push(request.url());
        await route.fulfill({ json: emptyGraph('top.scope1') });
        return;
      }
      const id = request.url().endsWith('/0') ? 0 : 1;
      if (id === 0) {
        requestSeen();
        await held;
      }
      await route.fulfill({ json: { state: 'ready', url: `./api/schematic/scopes/${id}` } }).catch(() => {});
      if (id === 0) finished();
    });
    await page.goto(`${baseUrl}schematic-fixture.html?mode=lazy`);
    await seen;
    await page.evaluate(action => window.schematicTest.controller.setActive(action === 'switch', action === 'switch' ? 1 : 0), action);
    if (action === 'switch') await ready(page);
    const before = await inspect(page);
    release();
    await fulfilled;
    await settle(page);
    assert.deepEqual(await inspect(page), before);
    assert.equal(before.metrics.layouts, action === 'switch' ? 1 : 0);
    assert(graphGets.every(url => url.endsWith('/1')));
    assert.equal(before.loading, false);
  } finally { release(); await finish(page); }
}, 60_000);

test('switching scope and hiding cancels in-flight data and cannot show stale content on resume', async () => {
  const page = await newPage();
  let release!: () => void;
  const held = new Promise<void>(done => { release = done; });
  let requestSeen!: () => void;
  const seen = new Promise<void>(done => { requestSeen = done; });
  await page.route('**/schematic/0.json', async route => {
    requestSeen();
    await held;
    await route.fulfill({ json: twoModules() }).catch(() => {});
  });
  try {
    await page.goto(`${baseUrl}schematic-fixture.html`);
    await seen;
    await page.evaluate(() => window.schematicTest.controller.setActive(true, 1));
    await ready(page);
    release();
    await settle(page);
    assert.equal((await inspect(page)).scopePath, 'top.scope1');
    assert.equal((await inspect(page)).scene!.nodes.length, 0);
    await page.unroute('**/schematic/0.json');
    await page.route('**/schematic/0.json', route => route.fulfill({ json: expressionGraph(320) }));
    await page.evaluate(() => window.schematicTest.controller.setActive(true, 0));
    await page.waitForFunction(() => window.schematicTest.controller.inspect().loading && window.schematicTest.controller.inspect().metrics.layouts >= 2);
    await page.evaluate(() => window.schematicTest.controller.setActive(false, 0));
    const hidden = await inspect(page);
    assert.equal(hidden.loading, false);
    await page.waitForTimeout(300); // Give any already-queued worker message a chance to arrive.
    assert.deepEqual(await inspect(page), hidden);
    await page.evaluate(() => window.schematicTest.controller.setActive(true, 1));
    assert.equal((await ready(page)).scopePath, 'top.scope1');
    await page.evaluate(() => window.schematicTest.controller.setActive(true, 0));
    assert.equal((await ready(page)).scopePath, 'top.expressions');
  } finally { release(); await finish(page); }
}, 60_000);
