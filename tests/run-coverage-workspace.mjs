import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const [url, instanceQuery, expectedRatio] = process.argv.slice(2);
assert.ok(url && instanceQuery && expectedRatio, 'Usage: node tests/run-coverage-workspace.mjs <url> <instance-query> <covered/total>');
const output = resolve('target/coverage-workspace-evidence');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errors = [];
const treePerformance = [];
let reportRequests = 0;
page.on('request', request => {
  if (/\/coverage-[^/]+\/.*\.(xml|html)(?:\?|$)/.test(request.url())) reportRequests++;
});
page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(url);
  await page.locator('#loading-overlay').waitFor({ state: 'hidden' });
  await page.waitForFunction(() => !document.querySelector('#coverage-metric-select').disabled);
  const loadedRequests = reportRequests;
  for (const metric of ['condition', 'line']) {
    await page.locator('#coverage-clear-btn').click();
    assert.equal(await page.locator('#coverage-metric-select').inputValue(), 'off');
    assert.ok(await page.locator('#coverage-metric-select').isEnabled(), 'X keeps the loaded report available');
    await page.locator('#coverage-metric-select').selectOption(metric);
    assert.ok(await page.locator('#coverage-clear-btn').isEnabled());
    assert.equal(await page.locator('#coverage-metric-select').inputValue(), metric);
    await page.waitForFunction(() => !document.querySelector('#coverage-legend').hidden);
  }
  assert.equal(reportRequests, loadedRequests, 'Re-enabling coloring does not reload the report');
  await page.locator('#view-coverage-btn').click();
  await page.waitForFunction(() => document.querySelector('#coverage-workspace-report').textContent !== 'No report loaded');
  await page.locator('#coverage-tree-search').fill(instanceQuery);
  const row = page.locator('.coverage-tree-row').filter({ has: page.locator('.coverage-tree-name', { hasText: instanceQuery.split('.').at(-1) }) }).last();
  await row.locator('[data-tree-metric="line"]').click();
  await page.waitForFunction(ratio => document.querySelector('#source-coverage-status').textContent.startsWith(`${ratio} points`), expectedRatio);
  await page.locator('.coverage-line-list-row').first().waitFor();
  const sourceTitle = await page.locator('#source-title').textContent();
  assert.ok(sourceTitle.includes(instanceQuery));
  assert.equal(await page.locator('#source-panel').count(), 1);
  assert.ok(await page.locator('#source-code').isVisible());
  const candidateRows = page.locator('.coverage-tree-row');
  if (await candidateRows.count() > 1) {
    await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.coverage-tree-row')];
      rows.at(-2).querySelector('[data-tree-metric="line"]').click();
      rows.at(-1).querySelector('[data-tree-metric="line"]').click();
    });
    await page.waitForFunction(ratio => document.querySelector('#source-coverage-status').textContent.startsWith(`${ratio} points`), expectedRatio);
    assert.equal(await page.locator('#source-title').textContent(), sourceTitle);
  }
  const widths = await page.evaluate(() => ['.coverage-instances', '.coverage-source-host', '.coverage-details-host'].map(selector => document.querySelector(selector).getBoundingClientRect().width));
  assert.ok(widths.every(width => width > 250), JSON.stringify(widths));
  const selectedRows = await page.locator('.coverage-tree-row.selected').count();
  assert.equal(selectedRows, 1);

  // A source-linked detail jump must leave the detail metric open alongside RTL.
  await page.locator('[data-coverage-metric="branch"]').click();
  await page.waitForFunction(() => !document.querySelector('#coverage-detail-status').textContent.startsWith('Loading'));
  assert.ok(await page.locator('#source-code').isVisible());
  assert.ok(await page.locator('#coverage-detail-view').isVisible());
  const jump = page.locator('.coverage-line-jump:enabled').first();
  if (await jump.count()) {
    await jump.click();
    assert.equal(await page.locator('[data-coverage-metric="branch"]').getAttribute('aria-selected'), 'true');
    assert.ok(await page.locator('#source-code').isVisible());
  }
  await page.locator('[data-coverage-metric="line"]').click();
  await page.locator('#coverage-export-uncovered').click();
  const selected = await page.locator('#coverage-export-count').textContent();
  assert.ok(!selected.startsWith('0 '), selected);
  await page.locator('#coverage-export-open').click();
  const exported = await page.locator('#coverage-export-text').inputValue();
  assert.ok(exported.includes(instanceQuery));
  assert.ok(exported.includes('reportSourceFile'));
  await page.locator('#coverage-export-close').click();

  // Keyboard resize and persisted widths do not disturb source identity or selection.
  await page.locator('#coverage-split-left').focus();
  await page.keyboard.press('ArrowRight');
  const resized = await page.locator('#coverage-split-left').getAttribute('aria-valuenow');
  await page.screenshot({ path: resolve(output, 'desktop.png') });
  await page.locator('#view-treemap-btn').click();
  await page.locator('#treemap-stage').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#source-panel').count(), 1);
  assert.ok(await page.locator('#treemap-stage').isVisible());
  assert.equal(await page.locator('#coverage-workspace').isVisible(), false);
  await page.locator('#view-coverage-btn').click();
  await page.waitForFunction(ratio => document.querySelector('#source-coverage-status').textContent.startsWith(`${ratio} points`), expectedRatio);
  assert.equal(await page.locator('#coverage-export-count').textContent(), '0 selected');
  assert.equal(await page.locator('#coverage-split-left').getAttribute('aria-valuenow'), resized);

  // Broad matching expands ancestor paths without mounting the complete hierarchy.
  for (let sample = 0; sample < 3; sample++) {
    treePerformance.push(await page.evaluate(async query => {
      const input = document.querySelector('#coverage-tree-search');
      const samples = [];
      for (const value of [query.split('.')[0], query]) {
        const start = performance.now();
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const viewport = document.querySelector('#coverage-tree-scroll');
        const mounted = document.querySelectorAll('.coverage-tree-row').length;
        if (mounted > Math.ceil(viewport.clientHeight / 36) + 17) throw new Error(`Unbounded tree DOM: ${mounted}`);
        samples.push({ ms: performance.now() - start, mounted, count: document.querySelector('#coverage-tree-count').textContent });
      }
      return samples;
    }, instanceQuery));
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('[data-coverage-pane="instances"]').click();
  assert.ok(await page.locator('#coverage-tree-search').isVisible());
  await page.locator('[data-coverage-pane="source"]').click();
  assert.ok(await page.locator('#source-code').isVisible());
  const mobileSource = await page.locator('#source-panel').evaluate(panel => ({ animation: getComputedStyle(panel).animationName, height: panel.querySelector('#source-code').getBoundingClientRect().height }));
  assert.equal(mobileSource.animation, 'none', 'Docked source must not replay the floating-panel fade on pane switches');
  assert.ok(mobileSource.height > 200, JSON.stringify(mobileSource));
  await page.screenshot({ path: resolve(output, 'mobile-source.png') });
  await page.locator('[data-coverage-pane="details"]').click();
  assert.ok(await page.locator('#coverage-workspace-lines').isVisible());
  await page.screenshot({ path: resolve(output, 'mobile-details.png') });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));

  await page.locator('#coverage-workspace-clear').click();
  await page.waitForFunction(() => document.querySelector('#coverage-workspace-report').textContent === 'No report loaded');
  assert.ok(await page.locator('#coverage-metric-select').isDisabled(), 'Remove unloads the report');
  assert.equal(await page.locator('#coverage-export-count').textContent(), '0 selected');
  assert.ok(await page.locator('#coverage-workspace-lines').isHidden());
  assert.ok(await page.locator('#coverage-detail-view').isHidden());
  await page.reload();
  await page.locator('#loading-overlay').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#view-coverage-btn').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('#coverage-split-left').getAttribute('aria-valuenow'), resized);
  assert.equal(await page.locator('#chart-panel.active').count(), 0);
  assert.deepEqual(errors, []);
  const result = { passed: true, ratio: expectedRatio, widths, selected, treePerformance, screenshots: output };
  await writeFile(resolve(output, 'results.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
}
