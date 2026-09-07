'use strict';

// Run against a generated, served bundle with source files and an available Playwright installation.
// NODE_PATH=/path/to/node_modules node tests/viewer-ui.browser.cjs http://127.0.0.1:8766 output/screenshots
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const url = process.argv[2];
const output = process.argv[3];
assert.ok(url && output, 'Provide a viewer URL and a screenshot directory');
fs.mkdirSync(output, { recursive: true });

async function checkControls(page) {
  const issues = await page.evaluate(() => {
    const controls = [...document.querySelectorAll('#toolbar button, #toolbar select, #toolbar input, .breadcrumb-row button')]
      .filter((el) => el.checkVisibility() && !el.closest('.advanced-popover'));
    const boxes = controls.map((el) => ({ id: el.id, rect: el.getBoundingClientRect() }));
    const errors = [];
    for (const { id, rect } of boxes) {
      if (rect.left < -1 || rect.right > innerWidth + 1 || rect.top < -1 || rect.bottom > innerHeight + 1) errors.push(`${id} outside viewport`);
    }
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i].rect;
        const b = boxes[j].rect;
        if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) {
          errors.push(`${boxes[i].id} overlaps ${boxes[j].id}`);
        }
      }
    }
    if (document.documentElement.scrollWidth > innerWidth) errors.push('horizontal page overflow');
    return errors;
  });
  assert.deepEqual(issues, []);
}

async function checkTreemap(page) {
  const result = await page.locator('#treemap').evaluate((canvas) => {
    const { width, height } = canvas;
    const data = canvas.getContext('2d').getImageData(0, 0, width, height).data;
    const colors = new Set();
    for (let i = 0; i < data.length; i += 4 * 97) colors.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
    return { colors: colors.size, height: canvas.getBoundingClientRect().height };
  });
  assert.ok(result.colors > 8, `Treemap has only ${result.colors} colors`);
  assert.ok(result.height >= 220, `Treemap is only ${result.height}px tall`);
}

(async () => {
  const browser = process.env.CDP_URL
    ? await chromium.connectOverCDP(process.env.CDP_URL)
    : await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const shot = (name) => page.screenshot({ path: path.join(output, `${name}.png`), animations: 'disabled' });
  try {
    await page.goto(url);
    await page.locator('#loading-overlay').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('body').getAttribute('data-theme'), 'github-light');
    assert.ok(await page.locator('#metric-select').isVisible(), 'Sizing control is hidden');
    assert.ok(await page.locator('#depth-select').isVisible(), 'Depth control is hidden');
    await checkControls(page);
    await checkTreemap(page);
    assert.ok((await page.locator('#toolbar').boundingBox()).height <= 180);
    await shot('desktop');
    await page.locator('#metric-select').selectOption('weighted_signals');
    assert.ok((await page.locator('#status-left').textContent()).includes('accurate'));
    await page.locator('#advanced-controls-btn').click();
    assert.ok(await page.locator('#weighted-variable-input').isVisible());
    await page.locator('#decomposition-select').selectOption('self');
    await page.locator('#close-advanced-btn').click();
    await checkTreemap(page);
    await shot('weighted');
    await page.locator('#metric-select').selectOption('instances');
    await page.locator('#advanced-controls-btn').click();
    await page.locator('#layout-select').selectOption('classic');
    await page.locator('#close-advanced-btn').click();

    await page.locator('#toggle-tree-btn').click();
    await page.locator('#tree-panel.visible').waitFor();
    await shot('hierarchy');
    await page.locator('.tree-row:has(.tree-indicator.leaf) .tree-entry').first().click();
    await page.locator('#source-panel.visible').waitFor();
    await page.waitForFunction(() => document.querySelector('#source-code').textContent.includes('module'));
    await shot('source');
    await page.locator('#toggle-source-fullscreen-btn').click();
    assert.equal(await page.locator('#toggle-source-fullscreen-btn').getAttribute('aria-pressed'), 'true');
    await page.locator('#close-source-btn').click();
    await page.locator('#close-tree-btn').click();
    if (await page.locator('#home-btn').isEnabled()) await page.locator('#home-btn').click();

    await page.locator('#filter-mode-select').selectOption('regex');
    await page.locator('#search-input').fill('[');
    await page.waitForFunction(() => document.querySelector('#status-right').textContent.includes('Invalid filter'));
    assert.equal(await page.locator('#status-right').getAttribute('class'), 'hint error');
    await page.locator('#search-input').fill('.*');
    await page.waitForFunction(() => document.querySelector('#status-left').textContent.includes('search matches'));
    await page.locator('#toggle-match-btn').click();
    await page.locator('#copy-matches-btn').click();
    await page.waitForFunction(() => document.querySelector('#status-right').textContent.startsWith('Copied'));
    assert.equal(await page.locator('#copy-matches-btn svg').count(), 1);
    await page.locator('#close-match-btn').click();
    await page.locator('#search-input').fill('');

    await page.locator('#advanced-controls-btn').click();
    await page.locator('#theme-select').selectOption('vscode-dark');
    const settings = await page.locator('#advanced-popover').boundingBox();
    assert.ok(settings.x >= 0 && settings.x + settings.width <= 1440, 'Desktop settings outside viewport');
    await shot('dark-settings');
    await page.reload();
    await page.locator('#loading-overlay').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('body').getAttribute('data-theme'), 'vscode-dark');
    await page.locator('#advanced-controls-btn').click();
    await page.locator('#theme-select').selectOption('github-light');
    await page.locator('#advanced-controls-btn').click();

    await page.locator('#view-pie-btn').click();
    await page.locator('#chart-visual svg').waitFor();
    assert.ok(await page.locator('#chart-visual svg path').count() > 0);
    await shot('pie');
    await page.locator('#view-three-btn').click();
    await page.waitForFunction(() => document.querySelector('#chart-status').textContent.includes('3D ready'));
    await shot('three');
    const canvas = page.locator('#chart-visual canvas');
    const before = await canvas.screenshot();
    const box = await canvas.boundingBox();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.6, { steps: 12 });
    await page.mouse.up({ button: 'right' });
    assert.notDeepEqual(await canvas.screenshot(), before, '3D orbit did not change canvas pixels');
    await page.locator('#fit-btn').click();
    const fittedStatus = await page.locator('#status-left').textContent();
    await page.locator('#zoom-in-btn').click();
    assert.notEqual(await page.locator('#status-left').textContent(), fittedStatus, '3D zoom status stopped updating after Fit');

    await page.locator('#view-treemap-btn').click();
    await page.locator('#zen-toggle-btn').click();
    assert.ok((await page.locator('#treemap').boundingBox()).height >= 895);
    await page.locator('#zen-exit-btn').click();
    for (const width of [768, 390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await checkControls(page);
      await checkTreemap(page);
      await shot(`mobile-${width}`);
      await page.locator('#advanced-controls-btn').click();
      const dialog = await page.locator('#advanced-popover').boundingBox();
      assert.ok(dialog.x >= 0 && dialog.x + dialog.width <= width + 1, 'Settings outside mobile viewport');
      await shot(`settings-${width}`);
      await page.locator('#close-advanced-btn').click();
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#view-three-btn').click();
    await page.waitForFunction(() => document.querySelector('#chart-status').textContent.includes('3D ready'));
    assert.ok((await canvas.boundingBox()).height >= 150, 'Mobile 3D canvas is clipped');
    await shot('mobile-three');
    assert.deepEqual(errors, [], 'Browser runtime errors');
    console.log('PASS: desktop/mobile layout, treemap pixels, source, filters, clipboard, persisted theme, pie, 3D orbit, zen.');
  } catch (error) {
    await shot('failure');
    throw error;
  } finally {
    await context.close();
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
