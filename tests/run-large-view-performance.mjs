#!/usr/bin/env node
// Run from the worktree root. All generated evidence stays under target/.
// Baseline: node tests/run-large-view-performance.mjs --bundle /path/to/bundle --baseline
// Current:  node tests/run-large-view-performance.mjs --bundle /path/to/bundle --output target/performance-evidence/optimized.json
// Frozen:   node tests/run-large-view-performance.mjs --bundle /path/to/bundle --assets target/performance-evidence/baseline
// Options: --bundle DIR --reps 3 --steps 16 --timeout 120000 --profile --output FILE
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const evidence = resolve(root, 'target/performance-evidence');
const { values: options } = parseArgs({ options: {
  baseline: { type: 'boolean', default: false },
  assets: { type: 'string' },
  bundle: { type: 'string' },
  output: { type: 'string' },
  reps: { type: 'string', default: '1' },
  steps: { type: 'string', default: '16' },
  timeout: { type: 'string', default: '120000' },
  profile: { type: 'boolean', default: false },
} });
assert.ok(!(options.baseline && options.assets), 'Choose --baseline or --assets');
const repetitions = Number(options.reps);
const steps = Number(options.steps);
const timeout = Number(options.timeout);
for (const [name, value] of Object.entries({ repetitions, steps, timeout })) {
  assert.ok(Number.isInteger(value) && value > 0, `${name} must be a positive integer`);
}
const output = resolve(root, options.output ?? `target/performance-evidence/${options.baseline ? 'baseline' : 'optimized'}.json`);
assert.ok(output.startsWith(evidence + sep), 'Write evidence only under target/performance-evidence');
assert.ok(options.bundle, 'Provide --bundle /path/to/bundle');
const bundle = resolve(options.bundle);
const assetPaths = ['template.html', 'template_styles.css', 'template_body.html',
  'generated/viewer-app.js', 'generated/viewer-chart.js', 'generated/viewer-coverage.js'];
const launchArgs = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-precise-memory-info'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (...args) => execFileSync('git', args, { cwd: root, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' });

async function loadAssets() {
  const commit = git('rev-parse', 'HEAD').trim();
  let directory = options.assets ? resolve(root, options.assets) : null;
  if (options.baseline) {
    directory = resolve(evidence, 'baseline');
    await mkdir(directory, { recursive: true });
    // Read the commit object, never files being edited or regenerated concurrently.
    for (const path of assetPaths) {
      await writeFile(resolve(directory, path.split('/').at(-1)), git('show', `${commit}:rust-hier-viewer/src/html/${path}`));
    }
    await writeFile(resolve(directory, 'snapshot.json'), JSON.stringify({ commit, paths: assetPaths }, null, 2));
  }
  const assets = new Map();
  const hashes = {};
  for (const path of assetPaths) {
    const name = path.split('/').at(-1);
    const location = directory ? resolve(directory, name) : resolve(root, 'rust-hier-viewer/src/html', path);
    const bytes = await readFile(location);
    assets.set(name, bytes);
    hashes[name] = hash(bytes);
  }
  let snapshot = null;
  if (directory) {
    try { snapshot = JSON.parse(await readFile(resolve(directory, 'snapshot.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { assets, metadata: { commit, directory, snapshot, hashes } };
}

async function startOverlay(assets) {
  const original = await readFile(resolve(bundle, 'index.html'), 'utf8');
  const coverageAttribute = original.match(/<body\b[^>]*\b(data-coverage-manifest="[^"]*")/i)?.[1];
  assert.ok(coverageAttribute, 'Expected preloaded coverage in the real bundle');
  const replacements = {
    __TITLE__: 'Large view performance',
    __INLINE_STYLES__: assets.get('template_styles.css').toString(),
    __BODY_CONTENT__: assets.get('template_body.html').toString(),
    __APP_SCRIPT__: assets.get('viewer-app.js').toString(),
  };
  let html = assets.get('template.html').toString().replace(/__TITLE__|__INLINE_STYLES__|__BODY_CONTENT__|__APP_SCRIPT__/g, token => replacements[token]);
  html = html.replace('<body ', `<body ${coverageAttribute} `);
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.bin': 'application/octet-stream', '.xml': 'application/xml' };
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Content-Type', types[extname(pathname)] ?? 'application/octet-stream');
      if (pathname === '/' || pathname === '/index.html') {
        response.setHeader('Content-Type', 'text/html');
        response.end(html);
        return;
      }
      const name = pathname.slice(1);
      if (assets.has(name)) { response.end(assets.get(name)); return; }
      const path = resolve(bundle, `.${pathname}`);
      if (!path.startsWith(bundle + sep)) { response.writeHead(403).end(); return; }
      const details = await stat(path);
      if (!details.isFile()) { response.writeHead(404).end(); return; }
      response.setHeader('Content-Length', details.size);
      createReadStream(path).on('error', () => response.destroy()).pipe(response);
    } catch (error) { response.writeHead(error.code === 'ENOENT' ? 404 : 500).end(); }
  });
  await new Promise(resolveReady => server.listen(0, '127.0.0.1', resolveReady));
  return { server, url: `http://127.0.0.1:${server.address().port}/`, coverageAttribute };
}

// This runs before any application scripts. Wrappers preserve listener identity for removal.
function instrument() {
  const sample = window.__largeViewBenchmark = {
    active: false, handlers: [], inputs: [], frames: [], gl: { draws: 0, textures: 0 }, renderers: [],
  };
  const inputTypes = new Set(['pointerdown', 'pointermove', 'pointerup', 'mousedown', 'mousemove', 'mouseup', 'wheel']);
  const add = EventTarget.prototype.addEventListener;
  const remove = EventTarget.prototype.removeEventListener;
  const listenerMaps = new WeakMap();
  EventTarget.prototype.addEventListener = function(type, listener, options) {
    if (!listener || !inputTypes.has(type)) return add.call(this, type, listener, options);
    let listeners = listenerMaps.get(this);
    if (!listeners) { listeners = new WeakMap(); listenerMaps.set(this, listeners); }
    let wrappers = listeners.get(listener);
    if (!wrappers) { wrappers = new Map(); listeners.set(listener, wrappers); }
    const capture = typeof options === 'boolean' ? options : Boolean(options?.capture);
    const key = `${type}:${capture}`;
    if (!wrappers.has(key)) {
      wrappers.set(key, function(event) {
        const measuring = sample.active;
        const start = performance.now();
        try {
          return typeof listener === 'function' ? listener.call(this, event) : listener.handleEvent(event);
        } finally {
          if (measuring) sample.handlers.push({ type, ms: performance.now() - start });
        }
      });
    }
    return add.call(this, type, wrappers.get(key), options);
  };
  EventTarget.prototype.removeEventListener = function(type, listener, options) {
    const capture = typeof options === 'boolean' ? options : Boolean(options?.capture);
    const wrapper = listenerMaps.get(this)?.get(listener)?.get(`${type}:${capture}`);
    return remove.call(this, type, wrapper ?? listener, options);
  };
  // Use trusted pointer events only; compatibility mouse events would double count latency.
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'wheel']) {
    add.call(window, type, event => {
      if (!sample.active || !event.isTrusted) return;
      const start = performance.now();
      const row = { type, inputToRafMs: null, dispatchToRafMs: null };
      sample.inputs.push(row);
      requestAnimationFrame(() => {
        const now = performance.now();
        row.inputToRafMs = now - event.timeStamp;
        row.dispatchToRafMs = now - start;
      });
    }, true);
  }
  let previousFrame = null;
  function frame(now) {
    if (sample.active && previousFrame !== null) sample.frames.push(now - previousFrame);
    previousFrame = sample.active ? now : null;
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  for (const contextType of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
    if (!contextType) continue;
    for (const method of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'createTexture']) {
      const original = contextType.prototype[method];
      if (!original) continue;
      contextType.prototype[method] = function(...args) {
        sample.gl[method === 'createTexture' ? 'textures' : 'draws'] += 1;
        return original.apply(this, args);
      };
    }
  }
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function(...args) {
    const context = getContext.apply(this, args);
    if (context && String(args[0]).includes('webgl')) {
      const extension = context.getExtension('WEBGL_debug_renderer_info');
      const renderer = extension ? context.getParameter(extension.UNMASKED_RENDERER_WEBGL) : context.getParameter(context.RENDERER);
      if (!sample.renderers.includes(renderer)) sample.renderers.push(renderer);
    }
    return context;
  };
}

function stats(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  const percentile = p => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? null;
  return { count: sorted.length, median: percentile(0.5), p95: percentile(0.95), max: sorted.at(-1) ?? null };
}
const settle = page => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));

async function snapshot(page, cdp) {
  const heap = await cdp.send('Runtime.getHeapUsage');
  return page.evaluate(heap => ({
    heapUsedBytes: heap.usedSize,
    domCount: document.querySelectorAll('*').length,
    gl: { ...window.__largeViewBenchmark.gl },
    renderers: [...window.__largeViewBenchmark.renderers],
    chartStatus: document.querySelector('#chart-status')?.textContent,
    chartLevel: document.querySelector('#chart-level-select')?.value,
    sliceCount: document.querySelectorAll('.chart-slice').length,
    legendCount: document.querySelectorAll('.chart-legend-item').length,
  }), heap);
}

async function gesture(page, selector, kind, artifactPrefix) {
  const locator = page.locator(selector);
  const box = await locator.boundingBox();
  assert.ok(box && box.width > 50 && box.height > 50, `${selector} must be visible`);
  // Stay away from treemap collapse controls and keep every drag inside the viewport.
  const x = box.x + box.width * 0.45;
  const y = box.y + box.height * 0.55;
  await page.mouse.move(x, y);
  await settle(page);
  const before = await locator.screenshot({ path: `${artifactPrefix}-before.png`, timeout });
  const viewBefore = await locator.getAttribute('viewBox') ?? await locator.getAttribute('data-view-box');
  await page.evaluate(() => {
    const sample = window.__largeViewBenchmark;
    sample.handlers = []; sample.inputs = []; sample.frames = [];
    sample.startGl = { ...sample.gl };
    sample.active = true;
  });
  if (kind === 'zoom') {
    for (let index = 0; index < steps; index += 1) {
      // Alternate in/out before the final four zoom-in ticks. This yields enough
      // samples without magnifying the donut's empty center beyond the viewport.
      const zoomOut = index < steps - 4 && index % 2 === 1;
      await page.mouse.wheel(0, zoomOut ? 24 : -24);
      await settle(page);
    }
  } else {
    const button = kind === 'orbit' ? 'right' : 'left';
    await page.mouse.down({ button });
    // Individual moves with rAF pacing are real input and avoid unbounded CDP event floods.
    for (let index = 1; index <= steps; index += 1) {
      await page.mouse.move(x + box.width * 0.18 * index / steps, y + box.height * 0.10 * index / steps);
      await settle(page);
    }
    await page.mouse.up({ button });
  }
  await settle(page);
  const measured = await page.evaluate(() => {
    const sample = window.__largeViewBenchmark;
    sample.active = false;
    return { handlers: sample.handlers, inputs: sample.inputs, frames: sample.frames,
      draws: sample.gl.draws - sample.startGl.draws, textures: sample.gl.textures - sample.startGl.textures };
  });
  // Include delayed raster refinement in a separate sample; it must not hide after input stops.
  const settlingFrames = await page.evaluate(() => new Promise(done => {
    const frames = [];
    let previous = performance.now();
    const started = previous;
    function frame(now) {
      frames.push(now - previous);
      previous = now;
      if (now - started >= 300) done(frames);
      else requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }));
  // Remove hover differences before comparing: both screenshots use the same pointer position.
  await page.mouse.move(x, y);
  await settle(page);
  const after = await locator.screenshot({ path: `${artifactPrefix}-after.png`, timeout });
  const viewAfter = await locator.getAttribute('viewBox') ?? await locator.getAttribute('data-view-box');
  const changed = !before.equals(after);
  assert.ok(changed, `${selector} ${kind} did not change screenshot pixels`);
  assert.ok(measured.inputs.length >= steps, `${kind} did not deliver enough trusted events`);
  return {
    kind, handlerMs: stats(measured.handlers.map(row => row.ms)),
    handlerByType: Object.fromEntries([...new Set(measured.handlers.map(row => row.type))].map(type => [type, stats(measured.handlers.filter(row => row.type === type).map(row => row.ms))])),
    inputToRafMs: stats(measured.inputs.map(row => row.inputToRafMs)),
    dispatchToRafMs: stats(measured.inputs.map(row => row.dispatchToRafMs)),
    frameMs: stats(measured.frames), settlingFrameMs: stats(settlingFrames), webglDrawCalls: measured.draws, textureCreations: measured.textures,
    verification: { changed, beforeSha256: hash(before), afterSha256: hash(after), viewBefore, viewAfter },
    raw: measured,
  };
}

async function run(browser, url, repetition, report) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.setDefaultTimeout(timeout);
  page.setDefaultNavigationTimeout(timeout);
  const result = { repetition, exceptions: [], consoleErrors: [], views: {} };
  report.runs.push(result);
  page.on('pageerror', error => result.exceptions.push(error.stack ?? error.message));
  page.on('console', message => { if (message.type() === 'error') result.consoleErrors.push(message.text()); });
  const cdp = await context.newCDPSession(page);
  const artifactDirectory = resolve(evidence, `${options.baseline ? 'baseline' : 'optimized'}-run-${repetition}`);
  await mkdir(artifactDirectory, { recursive: true });
  await page.addInitScript(instrument);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  if (options.profile) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.start'); }
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#loading-overlay')?.classList.contains('hidden') || document.querySelector('h1')?.textContent === 'Failed to load viewer data', null, { timeout });
    assert.ok(await page.locator('#loading-overlay.hidden').count(), `Viewer failed to load: ${await page.locator('body').innerText()}`);
    await page.waitForFunction(() => {
      const metric = document.querySelector('#coverage-metric-select');
      return metric && !metric.disabled && metric.value !== 'off';
    }, null, { timeout });
    await settle(page);
    result.readyMs = await page.evaluate(() => performance.now());
    for (const view of ['pie', 'three', 'treemap']) {
      console.log(`Run ${repetition}: entering ${view}`);
      const started = await page.evaluate(() => performance.now());
      // Dispatch an actual click without locator's post-click navigation wait entering the metric.
      const button = await page.locator(`#view-${view}-btn`).boundingBox();
      await page.mouse.click(button.x + button.width / 2, button.y + button.height / 2);
      await page.waitForFunction(view => {
        if (view === 'three') return document.querySelector('#chart-status')?.textContent.includes('3D ready');
        if (view === 'pie') return document.querySelector('#chart-visual .chart-pie-canvas') || document.querySelectorAll('#chart-visual .chart-slice').length > 0;
        return document.querySelector('#treemap').getBoundingClientRect().width > 0 && getComputedStyle(document.querySelector('#treemap-stage')).visibility !== 'hidden';
      }, view, { timeout });
      await settle(page);
      const enterMs = await page.evaluate(start => performance.now() - start, started);
      const metrics = result.views[view] = { enterMs, before: await snapshot(page, cdp), gestures: [] };
      const selector = view === 'pie' ? '#chart-visual svg, #chart-visual .chart-pie-canvas' : view === 'three' ? '#chart-visual canvas' : '#treemap';
      for (const kind of view === 'three' ? ['zoom', 'pan', 'orbit'] : ['zoom', 'pan']) {
        console.log(`Run ${repetition}: ${view} ${kind}`);
        metrics.gestures.push(await gesture(page, selector, kind, resolve(artifactDirectory, `${view}-${kind}`)));
      }
      metrics.after = await snapshot(page, cdp);
      await writeFile(output, JSON.stringify(report, null, 2));
      console.log(`Run ${repetition}: ${view} complete, enter ${enterMs.toFixed(1)} ms`);
    }
    assert.deepEqual(result.exceptions, [], 'Browser exceptions invalidate this run');
  } finally {
    if (options.profile) {
      const { profile } = await cdp.send('Profiler.stop');
      await writeFile(resolve(artifactDirectory, 'main-thread.cpuprofile'), JSON.stringify(profile));
    }
    await context.close();
  }
}

await mkdir(dirname(output), { recursive: true });
const { assets, metadata } = await loadAssets();
const dataset = JSON.parse(await readFile(resolve(bundle, 'viewer-meta.json'), 'utf8'));
const overlay = await startOverlay(assets);
const report = { metadata: {
  timestamp: new Date().toISOString(), bundle, dataset, assets: metadata, coverageAttribute: overlay.coverageAttribute,
  launchArgs, viewport: '1440x1000@1', repetitions, steps, timeout, profile: options.profile,
  limitations: ['SwiftShader software rendering is forced identically for baseline and optimized; absolute GPU times are not hardware GPU predictions.',
    'inputToRaf measures trusted event timestamp to next rAF callback, not display presentation. Handler measurements include synchronous work only.',
    'Gestures are rAF-paced; frame intervals include two-rAF pacing and CDP overhead. Instrumentation is identical across runs.',
    'Screenshot changes verify visible interaction; pie viewBox is also recorded. Preloaded coverage is awaited; no RTL export or URG conversion is performed.'],
}, runs: [], status: 'running' };
let browser;
try {
  browser = await chromium.launch({ headless: true, args: launchArgs, timeout });
  report.metadata.browser = browser.version();
  for (let repetition = 1; repetition <= repetitions; repetition += 1) await run(browser, overlay.url, repetition, report);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = error.stack ?? String(error);
  console.error(error);
  process.exitCode = 1;
} finally {
  await writeFile(output, JSON.stringify(report, null, 2));
  await browser?.close();
  await new Promise(done => overlay.server.close(done));
  console.log(`${report.status}: ${output}`);
}
