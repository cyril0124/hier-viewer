'use strict';

// Measure browser-side input-to-paint latency and rAF intervals during real pointer input.
// node tests/viewer-performance.browser.cjs <viewer-url> <report.json>
const assert = require('node:assert/strict');
const { mkdir, writeFile } = require('node:fs/promises');
const { dirname } = require('node:path');
const { chromium } = require('playwright');

const [url, output] = process.argv.slice(2);
assert.ok(url && output, 'Provide a viewer URL and a JSON report path');

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    median: sorted[Math.floor(sorted.length / 2)],
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

async function armInputMeasurement(page, selector, statusSelector, expected) {
  await page.evaluate(({ selector, statusSelector, expected }) => {
    const input = document.querySelector(selector);
    const status = document.querySelector(statusSelector);
    window.__benchmark.inputResult = null;
    input.addEventListener('input', () => {
      const start = performance.now();
      const observer = new MutationObserver(() => {
        if (!new RegExp(expected).test(status.textContent)) return;
        observer.disconnect();
        requestAnimationFrame(() => requestAnimationFrame(() => {
          window.__benchmark.inputResult = performance.now() - start;
        }));
      });
      observer.observe(status, { childList: true, subtree: true, characterData: true });
    }, { once: true, capture: true });
  }, { selector, statusSelector, expected });
}

async function measuredInput(page, selector, statusSelector, query, expected) {
  await armInputMeasurement(page, selector, statusSelector, expected);
  await page.locator(selector).fill(query);
  await page.waitForFunction(() => window.__benchmark.inputResult !== null);
  return page.evaluate(() => window.__benchmark.inputResult);
}

async function measureRun(browser, run) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await page.addInitScript(() => {
      window.__benchmark = { ready: null, inputResult: null };
      const observer = new MutationObserver(() => {
        if (!document.getElementById('loading-overlay')?.classList.contains('hidden')) return;
        observer.disconnect();
        requestAnimationFrame(() => { window.__benchmark.ready = performance.now(); });
      });
      observer.observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
    });
    await page.goto(url);
    await page.waitForFunction(() => window.__benchmark.ready !== null);
    const metrics = { run, readyMs: await page.evaluate(() => window.__benchmark.ready) };

    await page.locator('#filter-mode-select').selectOption('regex');
    metrics.filterMs = await measuredInput(page, '#search-input', '#status-left', '.*', '\\d+ search matches');
    await measuredInput(page, '#search-input', '#status-left', '', '^(?!.*search matches).*$');

    await page.locator('#view-three-btn').click();
    await page.waitForFunction(() => document.querySelector('#chart-status').textContent.includes('3D ready'));
    const canvas = page.locator('#chart-visual canvas');
    const box = await canvas.boundingBox();
    assert.ok(box && box.width > 0 && box.height > 0, '3D canvas is visible');
    const before = await canvas.screenshot();
    await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.45);
    await page.evaluate(() => {
      const sample = window.__benchmark;
      sample.frames = [];
      sample.dragging = true;
      let last = null;
      function frame(time) {
        if (!sample.dragging) return;
        if (last !== null) sample.frames.push(time - last);
        last = time;
        requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
    });
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(box.x + box.width * 0.75, box.y + box.height * 0.65, { steps: 30 });
    await page.mouse.up({ button: 'right' });
    const frames = await page.evaluate(() => {
      window.__benchmark.dragging = false;
      return window.__benchmark.frames;
    });
    assert.ok(frames.length >= 2, 'Drag must span at least two measured animation frames');
    assert.notDeepEqual(await canvas.screenshot(), before, 'Orbit changes rendered pixels');
    metrics.dragFrameMedianMs = stats(frames).median;
    metrics.dragFrameP95Ms = [...frames].sort((a, b) => a - b)[Math.ceil(frames.length * 0.95) - 1];
    metrics.dragFrames = frames;

    await page.locator('#view-treemap-btn').click();
    await page.locator('#toggle-tree-btn').click();
    await page.locator('.tree-row:has(.tree-indicator.leaf) .tree-entry').first().click();
    await page.waitForFunction(() => document.querySelector('#source-code').textContent.includes('module'));
    await page.locator('#source-search-mode-select').selectOption('regex');
    metrics.sourceSearchMs = await measuredInput(page, '#source-search-input', '#source-search-status', 'module', '^1/\\d+ matches$');
    assert.equal(await page.locator('#source-search-next-btn').isEnabled(), true);

    const heap = await cdp.send('Runtime.getHeapUsage');
    metrics.heapUsedBytes = heap.usedSize;
    await cdp.send('HeapProfiler.collectGarbage');
    metrics.retainedHeapBytes = (await cdp.send('Runtime.getHeapUsage')).usedSize;
    const resources = await page.evaluate(() => [
      ...performance.getEntriesByType('navigation'),
      ...performance.getEntriesByType('resource'),
    ].map((entry) => ({ name: entry.name, transferBytes: entry.transferSize, decodedBytes: entry.decodedBodySize })));
    metrics.transferBytes = resources.reduce((sum, entry) => sum + entry.transferBytes, 0);
    metrics.decodedBytes = resources.reduce((sum, entry) => sum + entry.decodedBytes, 0);
    metrics.resources = resources;
    assert.deepEqual(errors, [], 'Browser errors invalidate a performance sample');
    return metrics;
  } finally {
    await context.close();
  }
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const runs = [];
    for (let run = 1; run <= 5; run += 1) {
      const result = await measureRun(browser, run);
      runs.push(result);
      console.log(`Run ${run}: ready ${result.readyMs.toFixed(1)} ms, filter ${result.filterMs.toFixed(1)} ms, search ${result.sourceSearchMs.toFixed(1)} ms`);
    }
    const names = ['readyMs', 'filterMs', 'dragFrameMedianMs', 'dragFrameP95Ms', 'sourceSearchMs', 'heapUsedBytes', 'retainedHeapBytes', 'transferBytes', 'decodedBytes'];
    const summary = Object.fromEntries(names.map((name) => [name, stats(runs.map((run) => run[name]))]));
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify({
      metadata: { url, browser: browser.version(), viewport: '1440x900', runs: 5, timestamp: new Date().toISOString() },
      runs, summary,
    }, null, 2));
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
