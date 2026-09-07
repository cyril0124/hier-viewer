import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const [url, outputArgument = 'target/coverage-evidence/chart-coverage'] = process.argv.slice(2);
assert.ok(url, 'Usage: node tests/run-coverage-charts.mjs <preloaded-viewer-url> [output-dir]');
const output = resolve(outputArgument);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
async function assertCoverageOrder(page) {
  const values = (await page.locator('.chart-legend-value').allTextContents()).map(text => text === 'No data' ? -1 : Number.parseFloat(text));
  assert.ok(values.length > 0 && values.every(Number.isFinite));
  assert.deepEqual(values, [...values].sort((left, right) => right - left), '3D coverage is descending with no data last');
}
try {
  for (const [width, height] of [[1440, 1000], [390, 844]]) {
    const page = await browser.newPage({ viewport: { width, height } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    await page.waitForFunction(() => document.querySelector('#loading-overlay').classList.contains('hidden'));
    await page.locator('#view-pie-btn').click();
    await page.locator('#chart-level-select').selectOption('1');
    await page.waitForFunction(() => document.querySelectorAll('.chart-slice').length > 0);
    const slices = () => page.locator('.chart-slice').evaluateAll(nodes => nodes.map(node => ({ d: node.getAttribute('d'), fill: node.getAttribute('fill') })));
    const initial = await slices();
    assert.ok(await page.locator('.chart-legend-coverage').count());
    await page.locator('#coverage-metric-select').selectOption('condition');
    await page.waitForFunction(() => document.querySelector('.chart-coverage-key-title')?.textContent.includes('Condition'));
    const condition = await slices();
    assert.deepEqual(condition.map(node => node.d), initial.map(node => node.d), 'Coverage does not change pie areas');
    assert.notDeepEqual(condition.map(node => node.fill), initial.map(node => node.fill), 'Coverage changes pie colors');
    const item = page.locator('.chart-legend-item').first();
    await item.hover();
    assert.match(await page.locator('#chart-detail-meta').textContent(), /Condition/);
    assert.match(await page.locator('#chart-detail-meta').textContent(), /Subtree coverage/);
    await page.mouse.move(0, 0);
    await page.screenshot({ path: resolve(output, `pie-${width}.png`), fullPage: true });
    await page.locator('#coverage-metric-select').selectOption('off');
    await page.waitForFunction(() => !document.querySelector('.chart-coverage-key'));
    assert.equal(await page.locator('.chart-legend-coverage').count(), 0);
    assert.deepEqual((await slices()).map(node => node.d), initial.map(node => node.d));
    await page.locator('#coverage-metric-select').selectOption('line');
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    await page.route('**/viewer-three.module.js', async route => { await gate; await route.continue(); });
    await page.locator('#view-three-btn').click();
    await page.locator('#coverage-metric-select').selectOption('toggle');
    await page.locator('#coverage-metric-select').selectOption('condition');
    release();
    await page.waitForFunction(() => document.querySelector('#chart-status').textContent.includes('3D ready'));
    await page.unroute('**/viewer-three.module.js');
    assert.equal(await page.locator('#chart-mode-select').inputValue(), 'coverage', '3D defaults to percent heights when coverage is loaded');
    assert.match(await page.locator('#chart-status').textContent(), /height: Condition 0–100%/);
    assert.match(await page.locator('#chart-visual canvas').getAttribute('aria-label'), /fixed 0 to 100 percent/);
    await assertCoverageOrder(page);
    assert.equal(await page.locator('#chart-visual canvas').count(), 1, 'Stale Three.js loads cannot create extra canvases');
    assert.ok((await page.locator('.chart-legend-coverage').allTextContents()).every(text => text.startsWith('Condition')));
    const canvas = page.locator('#chart-visual canvas');
    const box = await canvas.boundingBox();
    assert.ok(box && box.width > 50 && box.height > 50);
    const before = await canvas.screenshot();
    await page.locator('#coverage-metric-select').selectOption('off');
    await page.waitForFunction(() => document.querySelector('#chart-status').textContent.includes('3D ready') && !document.querySelector('.chart-coverage-key'));
    assert.notDeepEqual(await canvas.screenshot(), before, 'Coverage changes actual 3D pixels');
    await page.locator('#coverage-metric-select').selectOption('condition');
    await page.waitForFunction(() => document.querySelector('#chart-status').textContent.includes('3D ready') && document.querySelector('.chart-coverage-key-title')?.textContent.includes('Condition'));
    await page.locator('.chart-legend-item').first().hover();
    assert.match(await page.locator('#chart-detail-meta').textContent(), /Condition/);
    await page.mouse.move(box.x + box.width * .45, box.y + box.height * .45);
    const orbitBefore = await canvas.screenshot();
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(box.x + box.width * .7, box.y + box.height * .6, { steps: 12 });
    await page.mouse.up({ button: 'right' });
    assert.notDeepEqual(await canvas.screenshot(), orbitBefore, '3D scene remains interactive');
    await page.screenshot({ path: resolve(output, `three-${width}.png`), fullPage: true });
    await page.locator('#coverage-clear-btn').click();
    await page.waitForFunction(() => document.querySelector('#chart-status').textContent.includes('3D ready') && !document.querySelector('.chart-coverage-key'));
    assert.equal(await page.locator('.chart-legend-coverage').count(), 0);
    const fixtures = await page.evaluate(async () => {
      const manifestUrl = new URL(document.body.dataset.coverageManifest, location.href);
      const config = await (await fetch(manifestUrl)).json();
      const xml = await (await fetch(new URL('session.xml', manifestUrl))).text();
      const variants = [false, true].map(full => {
        const parsed = new DOMParser().parseFromString(xml, 'application/xml');
        for (const metric of parsed.querySelectorAll('metric[name="Line"]')) {
          const total = metric.getAttribute('value').split('/')[1];
          metric.setAttribute('value', `${full ? total : 0}/${total}`);
        }
        return new XMLSerializer().serializeToString(parsed);
      });
      return { root: config.root, variants };
    });
    const reportColors = [];
    const reportOrders = [];
    for (const xml of fixtures.variants) {
      await page.locator('#coverage-import-btn').click();
      await page.waitForFunction(() => document.querySelector('#coverage-import-dialog').open);
      await page.locator('#coverage-import-mode').selectOption('files');
      await page.locator('#coverage-files').setInputFiles({ name: 'session.xml', mimeType: 'application/xml', buffer: Buffer.from(xml) });
      await page.waitForFunction(() => !document.querySelector('#coverage-mapping-fields').hidden);
      await page.locator('#coverage-root-input').fill(fixtures.root);
      await page.locator('#coverage-preview-btn').click();
      await page.locator('#coverage-apply-btn').click();
      await page.waitForFunction(() => document.querySelector('#chart-status').textContent.includes('3D ready'));
      assert.equal(await page.locator('#chart-mode-select').inputValue(), 'coverage');
      await assertCoverageOrder(page);
      const values = await page.locator('.chart-legend-value').allTextContents();
      assert.ok(values.length > 0 && values.every(value => value === 'No data' || value === (reportColors.length === 0 ? '0.00%' : '100.00%')), 'Zero-coverage instances remain visible; percentages are not summed');
      reportOrders.push(await page.locator('.chart-legend-label').allTextContents());
      reportColors.push(await page.locator('.chart-legend-swatch').evaluateAll(items => items.map(item => item.style.background)));
    }
    assert.deepEqual(reportOrders[0], reportOrders[1], 'Equal coverage scores retain stable hierarchy ordering');
    assert.notDeepEqual(reportColors[0], reportColors[1], 'Replacing a report with the same metric refreshes chart colors');
    assert.deepEqual(errors, []);
    console.log(`${width}: pie geometry, coverage colors/details, 3D pixels/orbit, rapid switching, clear and same-metric report replacement passed`);
    await page.close();
  }
} finally { await browser.close(); }
