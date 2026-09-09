import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { preview } from 'vite';

const execute = promisify(execFile);
const binary = resolve(process.argv[2] || 'target/debug/hier-viewer');
const evidence = resolve('target/schematic-evidence/integration');
const bundle = resolve(evidence, 'bundle');
const legacyBundle = resolve(evidence, 'legacy');
await mkdir(evidence, { recursive: true });
const generated = await execute(binary, [resolve('cpp-hier-exporter/tests/semantic_schematic.sv'), '--output', bundle, '--', '--top', 'semantic_top'], { timeout: 60_000 });
assert(!generated.stderr.includes('Compilation reported errors'), generated.stderr);
const database = (await readdir(resolve(bundle, '.hier-viewer-cache'))).find(name => name.endsWith('.sqlite'));
assert(database);
const legacyDb = resolve(evidence, 'legacy.sqlite');
await execute('python3', ['-c', `import sqlite3, shutil, sys
shutil.copyfile(sys.argv[1], sys.argv[2])
with sqlite3.connect(sys.argv[2]) as db:
    for name in ('metadata', 'scopes', 'nodes', 'ports', 'nets', 'endpoints'):
        db.execute('DROP TABLE schematic_' + name)
`, resolve(bundle, '.hier-viewer-cache', database), legacyDb]);
await execute(binary, ['--db', legacyDb, '--output', legacyBundle], { timeout: 60_000 });
const server = await preview({ configFile: false, root: resolve('.'), build: { outDir: evidence }, preview: { host: '127.0.0.1', port: 0, open: false } });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const errors = [];
const requests = [];
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => requests.push(request.url()));
const url = server.resolvedUrls.local[0];
const state = () => page.evaluate(() => window.hierarchySchematic.inspect());
async function scope(expected) {
  await page.waitForFunction(expected => {
    const current = window.hierarchySchematic?.inspect();
    return current && !current.loading && current.scene && current.scopePath === expected;
  }, expected, { timeout: 30_000 });
  return state();
}
try {
  await page.goto(`${url}bundle/`);
  await page.locator('#loading-overlay').waitFor({ state: 'hidden' });
  assert(!requests.some(path => /viewer-schematic|\/schematic\//.test(path)), 'Schematic resources stay unloaded in the initial treemap');
  await page.locator('#view-schematic-btn').click();
  const root = await scope('semantic_top');
  assert.equal(await page.locator('.schematic-scope').textContent(), 'semantic_top');
  for (const resource of ['viewer-schematic.js', 'viewer-schematic-worker.js']) {
    assert(requests.some(path => path.endsWith(resource)), `Local resource ${resource} loaded`);
  }
  assert(requests.every(path => path.startsWith(url) || path.startsWith(`blob:${url}`)), 'Generated site uses local static resources');
  await page.locator('[data-node-id="semantic_top.first"]').click();
  await page.getByRole('button', { name: 'Enter hierarchy', exact: true }).click();
  const child = await scope('semantic_top.first');
  assert(child.scene.nodes.some(node => node.id === 'semantic_top.first.lanes[0].first'));
  await page.locator('[data-node-id="semantic_top.first.lanes[0].first"]').click();
  await page.getByRole('button', { name: 'Open source', exact: true }).click();
  await page.locator('#source-panel.visible').waitFor();
  await page.waitForFunction(() => document.querySelector('#source-code')?.textContent.includes('module semantic_leaf'));
  await page.locator('#close-source-btn').click();
  await page.getByRole('button', { name: 'Close schematic details' }).click();
  await page.locator('#schematic-show-grid').check();
  await page.locator('#zoom-in-btn').click();
  const camera = (await state()).camera;
  await page.locator('#view-treemap-btn').click();
  await page.locator('#view-schematic-btn').click();
  assert.deepEqual((await scope('semantic_top.first')).camera, camera, 'View switches preserve the independent camera');
  await page.locator('#zen-toggle-btn').click();
  await page.waitForFunction(() => document.body.classList.contains('zen-active'));
  assert.equal(await page.locator('#zen-view-schematic-btn').getAttribute('aria-pressed'), 'true');
  const overlay = await page.locator('#zen-overlay-shell').boundingBox();
  const controls = await page.locator('.schematic-toolbar').evaluate(toolbar => [...toolbar.querySelectorAll('button, label')].map(control => {
    const box = control.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  }));
  assert(controls.every(box => box.y >= overlay.y + overlay.height || box.x >= overlay.x + overlay.width || box.x + box.width <= overlay.x), 'Zen controls do not overlap the floating view switcher');
  await page.screenshot({ path: resolve(evidence, 'rtl-zen.png') });
  await page.reload();
  await page.locator('#loading-overlay').waitFor({ state: 'hidden' });
  await scope('semantic_top.first');
  assert.equal(await page.locator('#view-schematic-btn').getAttribute('aria-pressed'), 'true');
  assert(await page.locator('#schematic-show-grid').isChecked());
  assert.deepEqual((await state()).camera, camera);
  await page.locator('#zen-exit-btn').click();
  await page.locator('#home-btn').click();
  await scope('semantic_top');
  await page.locator('[data-node-id="semantic_top.first"]').dblclick();
  await scope('semantic_top.first');
  await page.locator('#up-btn').click();
  await scope('semantic_top');
  await page.screenshot({ path: resolve(evidence, 'rtl-main.png') });
  await writeFile(resolve(evidence, 'metrics.json'), JSON.stringify({ root: root.metrics, child: child.metrics, nodes: root.scene.nodes.length, edges: root.scene.edges.length }, null, 2));
  await page.goto(`${url}legacy/`);
  await page.locator('#loading-overlay').waitFor({ state: 'hidden' });
  await page.locator('#view-schematic-btn').click();
  await page.waitForFunction(() => document.querySelector('.schematic-notice')?.textContent.includes('Schematic data is missing'));
  await page.screenshot({ path: resolve(evidence, 'legacy-database.png') });
  await page.locator('#view-treemap-btn').click();
  assert(await page.locator('#treemap-stage.active').isVisible());
  assert.deepEqual(errors, [], 'No browser exceptions in the generated site');
  console.log('Generated schematic site: lazy local resources, full-path navigation, source, Zen, restore and legacy DB checks passed.');
} finally {
  await context.close();
  await browser.close();
  await server.close();
}
