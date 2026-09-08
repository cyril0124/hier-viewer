import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { createServer, type ViteDevServer } from 'vite';
import { chromium, type Browser, type Page } from 'playwright';
import type * as Three from 'three';
import type { ChartApi, ChartController } from '../rust-hier-viewer/src/html/frontend/chart-types';
import type { createViewerState } from '../rust-hier-viewer/src/html/frontend/state';
import type { HierarchyNode, ViewerState } from '../rust-hier-viewer/src/html/frontend/types';

interface DrawFrame {
  timestamp: number;
  calls: number;
  instances: number[];
  canvas: HTMLCanvasElement;
}

declare global {
  interface Window {
    chartTest: {
      controller: ChartController;
      state: ViewerState;
      focused: number[];
      weightReads: number;
      frames: DrawFrame[];
      scene: Three.Scene | null;
      camera: Three.Camera | null;
      three: typeof Three;
      switchView: (mode: 'pie2d' | 'three3d' | 'treemap', coverage?: boolean) => void;
    };
    chartDom: {
      svg: SVGSVGElement;
      slices: Element[];
      paths: (string | null)[];
      rows: Element[];
      changed: Set<Element>;
      churn: number;
      observer: MutationObserver;
    };
  }
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const frontierSize = 1024;
let server: ViteDevServer;
let browser: Browser;
let fixtureUrl: string;
const pageErrors = new WeakMap<Page, string[]>();

// Serialized into the fixture page so the mock itself is typechecked alongside the tests.
function mountFixture(
  makeState: typeof createViewerState,
  initCharts: (api: ChartApi) => ChartController | null,
  three: typeof Three,
  count: number,
) {
  const nodes: HierarchyNode[] = Array.from({ length: count + 1 }, (_, id) => ({
    id, name: id ? `unit_${id}` : 'synthetic', path: id ? `synthetic.unit_${id}` : 'synthetic',
    module: 'SyntheticUnit', definitionKey: null, parent: id ? 0 : null, depth: id ? 1 : 0,
    children: id ? [] : Array.from({ length: count }, (_, index) => count - index),
    subtreeInstances: 1, subtreeLeaves: 1, subtreeSignalCount: 1, subtreeInternalSignalCount: 1,
    subtreeSignalBits: id || count,
    subtreeVariableBits: id === count && new URLSearchParams(location.search).get('dominant') === 'true' ? count * count : id || count,
    subtreeNetBits: 0,
    moduleVariableCount: 1, moduleNetCount: 0, moduleSignalCount: 1,
    moduleVariableBits: id || count, moduleNetBits: 0, moduleSignalBits: id || count,
    moduleInternalSignalCount: 1, filePath: null, sourceHref: null,
    definitionFilePath: null, definitionSourceHref: null, line: null, column: null,
    endLine: null, endColumn: null, definitionLine: null, definitionColumn: null,
    definitionEndLine: null, definitionEndColumn: null,
  }));
  const state = makeState({
    rootId: 0, defaultMetric: 'instances', title: 'Synthetic chart regression', builtAtUnixMs: 0,
    debugUiLabels: false, analysisDefinitions: null, analysisFile: null, nodes,
  });
  let controller: ChartController;
  const fixture: Window['chartTest'] = {
    controller: null as unknown as ChartController,
    state, focused: [], weightReads: 0, frames: [], scene: null, camera: null, three,
    switchView(mode, coverage = false) {
      state.mainViewMode = mode;
      state.chartPanelOpen = mode !== 'treemap';
      state.chartRenderMode = mode === 'three3d' ? 'three3d' : 'pie2d';
      state.chartMode = coverage && mode === 'three3d' ? 'coverage' : 'weighted_bits';
      if (coverage) {
        const scopes = nodes.map(node => ({
          name: node.name, path: node.path, parent: node.parent, children: node.children,
          metrics: node.id === 1 ? {} : { line: { covered: Math.max(0, node.id - 2), total: count, excluded: 0 } },
        }));
        state.coverage = {
          name: 'Synthetic coverage', metric: 'line',
          summary: { release: 'test', roots: [0], byPath: new Map(nodes.map(node => [node.path, node.id])), scopes },
          mapping: { sourceRoot: 0, targetRoot: 0, scopeByNode: Int32Array.from(nodes.map(node => node.id)), matched: nodes.length, unmatchedScopes: [], unmatchedNodeIds: [] },
        };
      } else {
        state.coverage = undefined;
      }
      document.querySelector('#chart-panel')!.classList.toggle('hidden', mode === 'treemap');
      controller.invalidate();
      controller.render();
    },
  };
  window.chartTest = fixture;

  // Count actual GPU draw submissions, grouping all render callbacks in the same animation frame.
  let timestamp = -1;
  const requestFrame = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = callback => requestFrame(time => { timestamp = time; callback(time); });
  const beforeRender = three.Scene.prototype.onBeforeRender;
  three.Scene.prototype.onBeforeRender = function (renderer, scene, camera, geometry, material, group) {
    fixture.scene = this;
    fixture.camera = camera;
    fixture.frames.push({ timestamp, calls: 0, instances: [], canvas: renderer.domElement });
    beforeRender.call(this, renderer, scene, camera, geometry, material, group);
  };
  for (const prototype of [WebGLRenderingContext.prototype, WebGL2RenderingContext.prototype]) {
    const methods = prototype as unknown as Record<string, (...args: number[]) => void>;
    for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
      const original = methods[name];
      if (!original) continue;
      methods[name] = function (this: WebGLRenderingContext, ...args: number[]) {
        const frame = fixture.frames.at(-1);
        if (frame && frame.canvas === this.canvas) {
          frame.calls++;
          if (name.endsWith('Instanced')) frame.instances.push(args.at(-1)!);
        }
        return Reflect.apply(original, this, args);
      };
    }
  }

  const api: ChartApi = {
    state,
    getNode: id => nodes[id],
    visibleParent: id => nodes[id].parent,
    currentMaxDepth: () => 1,
    setRootAndReset(id) { state.currentRoot = id; controller.invalidate(); controller.render(); },
    focusNodeInMainView(id) { state.selectedId = id; fixture.focused.push(id); },
    analysisActive: () => false,
    buildSignalAnalysis() {}, syncAnalysisControls() {}, savePersistedState() {},
    currentThemeVisuals: () => ({ dark: false, canvasBase: '#ffffff', panel: '#eeeeee', text: '#222222', textSoft: '#777777', match: '#ffaa00' }),
    mixHexColors(base, accent, mix) {
      const channels = [1, 3, 5].map(offset => Math.round(
        parseInt(base.slice(offset, offset + 2), 16) * (1 - mix)
        + parseInt(accent.slice(offset, offset + 2), 16) * mix,
      ).toString(16).padStart(2, '0'));
      return '#' + channels.join('');
    },
    hexToRgba(hex, alpha) { return `rgba(${[1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16)).join(',')},${alpha})`; },
    themeNodeAccent: index => ['#ca4949', '#23866a', '#537dc6', '#d89425'][index % 4],
    subtreeWeightedBits(node) { fixture.weightReads++; return node.subtreeVariableBits; },
    formatMetricValue: value => String(value),
    requestDraw() { controller.render(); },
  };
  const initialized = initCharts(api);
  if (!initialized) throw new Error('Production chart initialization returned null');
  controller = initialized;
  fixture.controller = controller;
  document.querySelector('#loading-overlay')!.classList.add('hidden');
  fixture.switchView('pie2d');
}

beforeAll(async () => {
  const htmlRoot = resolve(root, 'rust-hier-viewer/src/html');
  const [body, styles, threeModule, threeCore] = await Promise.all([
    readFile(resolve(htmlRoot, 'template_body.html'), 'utf8'),
    readFile(resolve(htmlRoot, 'template_styles.css'), 'utf8'),
    readFile(resolve(htmlRoot, 'vendor/three.module.js'), 'utf8'),
    readFile(resolve(htmlRoot, 'vendor/three.core.js'), 'utf8'),
  ]);
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${styles}</style></head><body>${body}<script type="module">
import { createViewerState } from '/rust-hier-viewer/src/html/frontend/state.ts';
import { initHierarchyCharts } from '/rust-hier-viewer/src/html/frontend/chart.ts';
import * as THREE from '/viewer-three.module.js';
(${mountFixture.toString()})(createViewerState, initHierarchyCharts, THREE, Number(new URLSearchParams(location.search).get('count') || ${frontierSize}));
</script></body></html>`;
  const routes = new Map([
    ['/chart-fixture.html', { type: 'text/html', body: html }],
    ['/viewer-three.module.js', { type: 'text/javascript', body: threeModule }],
    // The shipped module imports its core by this relative name.
    ['/three.core.js', { type: 'text/javascript', body: threeCore }],
  ]);
  server = await createServer({
    configFile: false, root, publicDir: false, appType: 'custom',
    server: { host: '127.0.0.1', port: 0, watch: null },
    plugins: [{
      name: 'chart-rendering-fixture',
      configureServer(vite) {
        vite.middlewares.use((request, response, next) => {
          const route = routes.get(request.url?.split('?')[0] ?? '');
          if (!route) return next();
          response.writeHead(200, { 'content-type': `${route.type}; charset=utf-8` });
          response.end(route.body);
        });
      },
    }],
  });
  await server.listen();
  fixtureUrl = `${server.resolvedUrls!.local[0]}chart-fixture.html`;
  browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] });
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

async function openPage(count = frontierSize, dominant = false) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  try {
    await page.goto(`${fixtureUrl}?count=${count}&dominant=${dominant}`);
    await page.waitForFunction(count => count > 2000 ? Boolean(document.querySelector('.chart-pie-canvas')) : document.querySelectorAll('.chart-slice').length === count, count);
    await page.evaluate(() => Promise.all(document.getAnimations().map(animation => animation.finished)));
    await settleFrames(page);
    return page;
  } catch (error) {
    await page.context().close();
    throw new Error(`Chart fixture failed to open. Browser errors: ${JSON.stringify(errors)}`, { cause: error });
  }
}

async function settleFrames(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function closePage(page: Page) {
  const errors = pageErrors.get(page);
  await page.context().close();
  assert.deepEqual(errors, [], 'No browser exceptions or console errors');
}

async function observeChartDom(page: Page) {
  await page.evaluate(() => {
    const svg = document.querySelector<SVGSVGElement>('#chart-visual svg')!;
    const slices = [...svg.querySelectorAll('.chart-slice')];
    const changed = new Set<Element>();
    const observer = new MutationObserver(records => {
      for (const record of records) {
        window.chartDom.churn += record.addedNodes.length + record.removedNodes.length;
        if (record.type === 'attributes' && slices.includes(record.target as Element)) changed.add(record.target as Element);
      }
    });
    window.chartDom = { svg, slices, paths: slices.map(slice => slice.getAttribute('d')), rows: [...document.querySelectorAll('.chart-legend-item')], changed, churn: 0, observer };
    observer.observe(document.querySelector('#chart-visual')!, { subtree: true, childList: true, attributes: true });
    observer.observe(document.querySelector('#chart-legend')!, { subtree: true, childList: true });
  });
}

async function assertLegendBounded(page: Page, rowHeight: number) {
  const result = await page.locator('#chart-legend').evaluate((legend, height) => ({
    rows: legend.querySelectorAll('.chart-legend-item').length,
    limit: Math.ceil(legend.clientHeight / height) + 10,
    scrollHeight: legend.scrollHeight,
    rowHeights: [...legend.querySelectorAll('.chart-legend-item')].map(row => row.getBoundingClientRect().height),
  }), rowHeight);
  assert.ok(result.rows > 0 && result.rows <= result.limit, JSON.stringify(result));
  assert.ok(result.scrollHeight >= frontierSize * rowHeight, 'All rows retain a scroll position');
  assert.ok(result.rowHeights.every(height => height === rowHeight - 2), JSON.stringify(result));
}

async function openThree(page: Page, coverage = false) {
  await page.evaluate(value => window.chartTest.switchView('three3d', value), coverage);
  await page.waitForFunction(() => document.querySelector('#chart-status')?.textContent?.includes('3D ready'));
  await settleFrames(page);
  assert.ok(await page.locator('.chart-three-canvas').isVisible());
}

async function assertDrawBudget(page: Page) {
  const frames = await page.evaluate(() => {
    const totals = new Map<number, number>();
    for (const frame of window.chartTest.frames) totals.set(frame.timestamp, (totals.get(frame.timestamp) ?? 0) + frame.calls);
    return { totals: [...totals.values()], instances: window.chartTest.frames.flatMap(frame => frame.instances) };
  });
  assert.ok(frames.totals.length > 0 && frames.totals.every(calls => calls > 0 && calls < 100), JSON.stringify(frames));
  assert.ok(frames.instances.filter(count => count === frontierSize).length >= 2, 'Bars and pedestals both submit the full frontier as instances');
}

// Project an actual rendered instance center. Expected node IDs come from the synthetic data,
// independently of the production raycaster and its instanceId-to-entry lookup.
async function instancePoint(page: Page, index: number, pedestal = false) {
  return page.evaluate(({ index, pedestal }) => {
    const { three, scene, camera } = window.chartTest;
    const meshes = scene!.children.filter((child): child is Three.InstancedMesh => child instanceof three.InstancedMesh);
    const matrix = new three.Matrix4();
    const bars = meshes.find(mesh => { mesh.getMatrixAt(0, matrix); return matrix.elements[5] > 1; })!;
    const mesh = pedestal ? meshes.find(mesh => mesh !== bars)! : bars;
    mesh.getMatrixAt(index, matrix);
    const point = new three.Vector3(0, 0.5, 0).applyMatrix4(matrix).applyMatrix4(mesh.matrixWorld).project(camera!);
    const rect = document.querySelector('.chart-three-canvas')!.getBoundingClientRect();
    return { x: rect.left + (point.x + 1) * rect.width / 2, y: rect.top + (1 - point.y) * rect.height / 2 };
  }, { index, pedestal });
}

describe('production chart rendering with synthetic large frontiers', () => {
  test('Canvas picking follows the displaced highlighted sector and excludes its vacated area', async () => {
    const page = await openPage(4096, true);
    try {
      const canvas = page.locator('.chart-pie-canvas');
      const points = await canvas.evaluate(canvas => {
        const rect = canvas.getBoundingClientRect();
        const [, , width, height] = canvas.dataset.viewBox!.split(' ').map(Number);
        const outer = Math.min(width, height) * 0.33;
        const inner = outer * 0.44;
        const fraction = 4096 ** 2 / (4096 ** 2 + 4095 * 4096 / 2);
        const angle = -Math.PI / 2 + fraction * Math.PI;
        const point = (radius: number) => ({
          clientX: rect.left + (width * 0.44 + Math.cos(angle) * radius) * rect.width / width,
          clientY: rect.top + (height * 0.52 + Math.sin(angle) * radius) * rect.height / height,
        });
        return { interior: point((inner + outer) / 2), protruding: point(outer + 6), vacated: point(inner + 6) };
      });
      await page.mouse.move(points.interior.clientX, points.interior.clientY);
      await settleFrames(page);
      assert.equal(await page.locator('#chart-detail-path').textContent(), 'synthetic.unit_4096');
      await canvas.dispatchEvent('click', points.vacated);
      assert.deepEqual(await page.evaluate(() => window.chartTest.focused), [], 'The vacated inner edge is not selectable');
      await page.mouse.move(points.protruding.clientX, points.protruding.clientY);
      await settleFrames(page);
      assert.equal(await page.locator('#chart-detail-path').textContent(), 'synthetic.unit_4096');
      await page.mouse.click(points.protruding.clientX, points.protruding.clientY);
      assert.deepEqual(await page.evaluate(() => window.chartTest.focused), [4096]);
    } finally { await closePage(page); }
  });

  test('large Canvas pie keeps all sectors selectable and reuses its canvas through zoom and pan', async () => {
    const page = await openPage(4096);
    try {
      const canvas = page.locator('.chart-pie-canvas');
      const element = await canvas.elementHandle();
      const reads = await page.evaluate(() => window.chartTest.weightReads);
      const initialView = await canvas.getAttribute('data-view-box');
      const before = await canvas.screenshot();
      const box = (await canvas.boundingBox())!;
      await page.mouse.move(box.x + box.width * 0.44, box.y + box.height * 0.52);
      await page.mouse.wheel(0, -120);
      await page.waitForFunction(initial => document.querySelector<HTMLElement>('.chart-pie-canvas')!.dataset.viewBox !== initial, initialView);
      const zoomed = await canvas.getAttribute('data-view-box');
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.48, box.y + box.height * 0.56, { steps: 6 });
      await page.mouse.up();
      await settleFrames(page);
      assert.notEqual(await canvas.getAttribute('data-view-box'), zoomed);
      assert.notDeepEqual(await canvas.screenshot(), before);
      assert.equal(await element!.evaluate(canvas => canvas === document.querySelector('.chart-pie-canvas')), true);
      assert.equal(await page.evaluate(() => window.chartTest.weightReads), reads);
      await page.evaluate(() => window.chartTest.controller.fitView());
      await settleFrames(page);
      const point = await canvas.evaluate(canvas => {
        const rect = canvas.getBoundingClientRect();
        const [vx, vy, vw, vh] = canvas.dataset.viewBox!.split(' ').map(Number);
        const baseW = vw;
        const baseH = vh;
        const angle = -Math.PI / 2 + (4096 / (4096 * 4097 / 2)) * Math.PI;
        const radius = Math.min(baseW, baseH) * 0.33 * 0.7;
        const clientX = rect.left + (baseW * 0.44 + Math.cos(angle) * radius - vx) * rect.width / vw;
        const clientY = rect.top + (baseH * 0.52 + Math.sin(angle) * radius - vy) * rect.height / vh;
        // MouseEvent coordinates are integer pixels; subpixel sectors may share that pixel.
        const pixelX = vx + (Math.trunc(clientX) - rect.left) * vw / rect.width - baseW * 0.44;
        const pixelY = vy + (Math.trunc(clientY) - rect.top) * vh / rect.height - baseH * 0.52;
        const fraction = ((Math.atan2(pixelY, pixelX) + Math.PI / 2 + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2);
        let cumulative = 0;
        let expectedId = 1;
        for (let id = 4096; id >= 1; id--) {
          cumulative += id / (4096 * 4097 / 2);
          if (fraction < cumulative) { expectedId = id; break; }
        }
        return { clientX, clientY, expectedId };
      });
      await canvas.dispatchEvent('mousemove', point);
      assert.equal(await page.locator('#chart-detail-path').textContent(), `synthetic.unit_${point.expectedId}`);
      await canvas.dispatchEvent('click', point);
      assert.equal(await page.evaluate(() => window.chartTest.focused.at(-1)), point.expectedId);
      await page.locator('#chart-legend').evaluate(legend => { legend.scrollTop = legend.scrollHeight; });
      const last = page.locator('[data-chart-index="4095"]');
      await last.click();
      assert.equal(await page.evaluate(() => window.chartTest.focused.at(-1)), 1);
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.waitForFunction(() => {
        const canvas = document.querySelector<HTMLCanvasElement>('.chart-pie-canvas')!;
        const [, , width, height] = canvas.dataset.viewBox!.split(' ').map(Number);
        return Math.abs(canvas.width / width - canvas.height / height) < 0.01;
      });
      await page.evaluate(() => {
        window.chartTest.controller.zoomByFactor(1.2);
        window.chartTest.switchView('treemap');
      });
      await settleFrames(page);
      assert.equal(await canvas.count(), 0, 'Switching views disposes the pending Canvas redraw');
    } finally { await closePage(page); }
  });

  test('2D zoom and pan preserve SVG identity and do not rebuild slices or legend rows', async () => {
    const page = await openPage();
    try {
      await observeChartDom(page);
      const initial = await page.evaluate(() => ({ viewBox: window.chartDom.svg.getAttribute('viewBox'), reads: window.chartTest.weightReads }));
      const box = await page.locator('#chart-visual svg').boundingBox();
      assert.ok(box);
      await page.mouse.move(box.x + box.width * 0.44, box.y + box.height * 0.52);
      await page.mouse.wheel(0, -120);
      await page.waitForFunction(value => document.querySelector('#chart-visual svg')!.getAttribute('viewBox') !== value, initial.viewBox);
      const zoomed = await page.locator('#chart-visual svg').getAttribute('viewBox');
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.48, box.y + box.height * 0.56, { steps: 6 });
      await page.mouse.up();
      await settleFrames(page);
      assert.notEqual(await page.locator('#chart-visual svg').getAttribute('viewBox'), zoomed, 'Pan changes the camera');
      const result = await page.evaluate(() => ({
        svg: document.querySelector('#chart-visual svg') === window.chartDom.svg,
        slices: [...document.querySelectorAll('.chart-slice')].every((slice, index) => slice === window.chartDom.slices[index] && slice.getAttribute('d') === window.chartDom.paths[index]),
        rows: [...document.querySelectorAll('.chart-legend-item')].every((row, index) => row === window.chartDom.rows[index]),
        count: document.querySelectorAll('.chart-slice').length,
        churn: window.chartDom.churn, reads: window.chartTest.weightReads,
      }));
      assert.deepEqual(result, { svg: true, slices: true, rows: true, count: frontierSize, churn: 0, reads: initial.reads });
    } finally { await closePage(page); }
  });

  for (const coverage of [false, true]) {
    test(`virtual legend keeps ${coverage ? 'coverage' : 'normal'} rows bounded and supports scroll, End, Home and arrow navigation`, async () => {
      const page = await openPage();
      try {
        if (coverage) await page.evaluate(() => window.chartTest.switchView('pie2d', true));
        const rowHeight = coverage ? 82 : 60;
        await assertLegendBounded(page, rowHeight);
        await page.locator('#chart-legend').evaluate(legend => { legend.scrollTop = legend.scrollHeight; });
        const last = page.locator(`.chart-legend-item[data-chart-index="${frontierSize - 1}"]`);
        await last.waitFor({ state: 'visible' });
        await assertLegendBounded(page, rowHeight);
        await last.click();
        assert.equal(await page.evaluate(() => window.chartTest.state.selectedId), 1);
        await page.keyboard.press('Home');
        await page.waitForFunction(() => (document.activeElement as HTMLElement)?.dataset.chartIndex === '0');
        for (const [key, index] of [['End', 1023], ['ArrowUp', 1022], ['ArrowDown', 1023], ['Home', 0]] as const) {
          await page.keyboard.press(key);
          await settleFrames(page);
          const focused = await page.evaluate(() => {
            const row = document.activeElement as HTMLElement;
            const rect = row.getBoundingClientRect();
            const legend = document.querySelector('#chart-legend')!.getBoundingClientRect();
            return { index: Number(row.dataset.chartIndex), visible: rect.top >= legend.top && rect.bottom <= legend.bottom };
          });
          assert.deepEqual(focused, { index, visible: true });
          await assertLegendBounded(page, rowHeight);
        }
        await page.keyboard.press('End');
        await page.keyboard.press('Enter');
        assert.deepEqual(await page.evaluate(() => window.chartTest.focused), [1, 1]);
      } finally { await closePage(page); }
    });
  }

  test('hover mutates only the intended slice and restores it across virtual legend windows', async () => {
    const page = await openPage();
    try {
      await observeChartDom(page);
      for (const index of [0, 1023]) {
        await page.locator('#chart-legend').evaluate((legend, index) => { legend.scrollTop = index ? legend.scrollHeight : 0; }, index);
        const row = page.locator(`.chart-legend-item[data-chart-index="${index}"]`);
        await row.waitFor({ state: 'visible' });
        await page.evaluate(() => window.chartDom.changed.clear());
        await row.hover();
        const active = await page.evaluate(() => ({
          indices: window.chartDom.slices.flatMap((slice, index) => slice.classList.contains('active') ? [index] : []),
          changed: [...window.chartDom.changed].map(slice => window.chartDom.slices.indexOf(slice)),
          path: document.querySelector('#chart-detail-path')!.textContent,
        }));
        assert.deepEqual(active, { indices: [index], changed: [index], path: `synthetic.unit_${frontierSize - index}` });
        await page.mouse.move(0, 0);
        const restored = await page.evaluate(index => ({
          active: document.querySelectorAll('.chart-slice.active').length,
          transform: (window.chartDom.slices[index] as SVGElement).style.transform,
          stroke: window.chartDom.slices[index].getAttribute('stroke-width'),
          changed: [...window.chartDom.changed].map(slice => window.chartDom.slices.indexOf(slice)),
          hidden: document.querySelector('#chart-detail-card')!.classList.contains('hidden'),
        }), index);
        assert.deepEqual(restored, { active: 0, transform: '', stroke: '1.25', changed: [index], hidden: true });
      }
    } finally { await closePage(page); }
  });

  test('3D submits instanced bars under 100 draw calls per frame and orbit changes pixels', async () => {
    const page = await openPage();
    try {
      await openThree(page);
      await assertDrawBudget(page);
      const beforeBurst = await page.evaluate(() => {
        const count = window.chartTest.frames.length;
        for (let index = 0; index < 12; index++) window.chartTest.controller.zoomByFactor(1.01);
        return count;
      });
      await settleFrames(page);
      assert.equal(await page.evaluate(() => window.chartTest.frames.length), beforeBurst + 1, 'A burst of camera changes submits one animation frame');
      const canvas = page.locator('.chart-three-canvas');
      const before = await canvas.screenshot();
      const box = await canvas.boundingBox();
      assert.ok(box);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down({ button: 'right' });
      await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.6, { steps: 8 });
      await page.mouse.up({ button: 'right' });
      await page.mouse.move(0, 0);
      await settleFrames(page);
      assert.notDeepEqual(await canvas.screenshot(), before, 'Orbit changes rendered pixels');
      await page.evaluate(() => window.chartTest.controller.zoomByFactor(3));
      await settleFrames(page);
      await assertDrawBudget(page);
      const labels = await page.evaluate(() => {
        const { scene, three } = window.chartTest;
        return scene!.children.filter(child => child instanceof three.Sprite && child.visible).length;
      });
      assert.ok(labels > 0 && labels <= 80, `Visible bar labels: ${labels}`);
    } finally { await closePage(page); }
  });

  test('3D hover and click resolve bar and zero/no-data pedestal instance indices', async () => {
    const page = await openPage();
    try {
      await openThree(page, true);
      for (const [index, pedestal, expectedValue] of [[991, false, null], [1022, true, '0.00%'], [1023, true, 'No data']] as const) {
        const point = await instancePoint(page, index, pedestal);
        await page.mouse.move(point.x, point.y);
        await settleFrames(page);
        assert.equal(await page.locator('#chart-detail-path').textContent(), `synthetic.unit_${frontierSize - index}`);
        if (expectedValue) assert.ok((await page.locator('#chart-detail-meta').textContent())!.includes(expectedValue));
        await page.mouse.click(point.x, point.y);
        assert.equal(await page.evaluate(() => window.chartTest.state.selectedId), frontierSize - index);
        await page.mouse.move(0, 0);
        assert.ok(await page.locator('#chart-detail-card').evaluate(card => card.classList.contains('hidden')));
      }
      assert.deepEqual(await page.evaluate(() => window.chartTest.focused), [33, 2, 1]);
      await assertDrawBudget(page);
    } finally { await closePage(page); }
  });

  test('switching views cancels queued SVG and WebGL work without stale DOM writes', async () => {
    const page = await openPage();
    try {
      await observeChartDom(page);
      const viewBox = await page.evaluate(() => {
        const before = window.chartDom.svg.getAttribute('viewBox');
        window.chartTest.controller.zoomByFactor(2);
        window.chartTest.switchView('three3d');
        return before;
      });
      await page.waitForFunction(() => document.querySelector('#chart-status')?.textContent?.includes('3D ready'));
      await settleFrames(page);
      assert.equal(await page.evaluate(() => window.chartDom.svg.getAttribute('viewBox')), viewBox, 'Detached SVG has no queued camera update');
      const frameCount = await page.evaluate(() => {
        const count = window.chartTest.frames.length;
        window.chartTest.controller.zoomByFactor(2);
        window.chartTest.switchView('pie2d');
        return count;
      });
      await settleFrames(page);
      assert.equal(await page.evaluate(() => window.chartTest.frames.length), frameCount, 'Disposed renderer does not draw a queued frame');
      assert.equal(await page.locator('.chart-three-canvas').count(), 0);
      assert.equal(await page.locator('.chart-slice').count(), frontierSize);
      await openThree(page);
      const closedCount = await page.evaluate(() => {
        const count = window.chartTest.frames.length;
        window.chartTest.controller.zoomByFactor(2);
        window.chartTest.switchView('treemap');
        return count;
      });
      await settleFrames(page);
      assert.equal(await page.evaluate(() => window.chartTest.frames.length), closedCount);
      assert.equal(await page.locator('.chart-three-canvas').count(), 0);
    } finally { await closePage(page); }
  });
});
