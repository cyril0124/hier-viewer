import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { chromium } from 'playwright';

const [url, expectationsFile] = process.argv.slice(2);
assert.ok(url && expectationsFile, 'Usage: node tests/run-coverage-details.mjs <preloaded-viewer-url> <expectations.json>');
const expected = JSON.parse(await readFile(expectationsFile, 'utf8'));
const output = resolve(dirname(expectationsFile), 'coverage-ui');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    await page.waitForFunction(() => document.querySelector('#loading-overlay').classList.contains('hidden'));
    async function open(index) {
      if (await page.locator('#source-panel').evaluate(panel => panel.classList.contains('visible'))) await page.locator('#close-source-btn').click();
      await page.locator('#filter-scope-select').selectOption('path');
      await page.locator('#filter-mode-select').selectOption('regex');
      await page.locator('#search-input').fill(expected.instances[index].query);
      if (!await page.locator('#match-panel').evaluate(panel => panel.classList.contains('visible'))) await page.locator('#toggle-match-btn').click();
      await page.waitForFunction(query => {
        const matches = document.querySelectorAll('.match-item');
        return matches.length === 1 && new RegExp(query).test(matches[0].querySelector('.match-path').textContent);
      }, expected.instances[index].query);
      await page.locator('.match-item').click();
      await page.waitForFunction(() => document.querySelector('#source-coverage-bar').hidden === false);
    }
    async function metric(value) {
      await page.locator(`[data-coverage-metric="${value}"]`).click();
      await page.waitForFunction(() => document.querySelectorAll('#coverage-detail-content table').length > 0);
      assert.equal(await page.locator('#source-code').isVisible(), false);
    }
    await open(0);
    await metric('condition');
    assert.match(await page.locator('#coverage-detail-content').textContent(), /EXPRESSION/);
    assert.ok(await page.locator('#coverage-detail-content .missing').count());
    await page.locator('#coverage-detail-missing').check();
    assert.equal(await page.locator('#coverage-detail-content .hit').count(), 0);
    await page.locator('#coverage-detail-missing').uncheck();
    await page.screenshot({ path: resolve(output, `integrated-condition-${width}.png`), fullPage: true });
    await page.locator('.coverage-line-jump').first().click();
    assert.equal(await page.locator('#source-code').isVisible(), true);
    await metric('branch');
    assert.ok(await page.locator('#coverage-detail-content .missing').count());
    await page.screenshot({ path: resolve(output, `integrated-branch-${width}.png`), fullPage: true });
    await metric('toggle');
    assert.match(await page.locator('#coverage-detail-content').textContent(), /Toggle 1->0/);
    assert.match(await page.locator('#coverage-detail-content').textContent(), /Toggle 0->1/);
    assert.ok(await page.locator('#coverage-detail-content .missing').count());
    await page.screenshot({ path: resolve(output, `integrated-toggle-${width}.png`), fullPage: true });
    await metric('condition');
    await open(1);
    await page.waitForFunction(() => document.querySelectorAll('#coverage-detail-content table').length > 0);
    assert.equal(await page.locator('#coverage-detail-content .missing').count(), 0, 'Second instance must not inherit first-instance misses');
    await open(0);
    await page.waitForFunction(() => document.querySelectorAll('#coverage-detail-content .missing').length > 0);
    await page.locator('[data-coverage-metric="line"]').click();
    await page.waitForFunction(() => document.querySelector('[data-coverage-line="28"]')?.textContent === '0/1');
    assert.equal(await page.locator('#source-code').isVisible(), true);
    assert.deepEqual(errors, []);
    console.log(`${width}: Condition/Branch/Toggle details, filter, source jump and instance isolation passed`);
    await page.close();
  }
} finally { await browser.close(); }
