import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile, readdir, readlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname, relative, join } from 'node:path';
import { chromium } from 'playwright';

// Run against a generated viewer and an independently checked URG report.
const [url, reportDirectory, expectationsFile, vdbPath] = process.argv.slice(2);
assert.ok(url && reportDirectory && expectationsFile, 'Usage: node tests/run-coverage-ui.mjs <viewer-url> <report-dir> <expectations.json> [vdb-path]');
const expected = JSON.parse(await readFile(expectationsFile, 'utf8'));
assert.ok(typeof expected.coverageRoot === 'string' && Number.isInteger(expected.matched));
assert.ok(Array.isArray(expected.instances) && expected.instances.length >= 2);
const output = resolve(dirname(expectationsFile), 'coverage-ui');
await mkdir(output, { recursive: true });
async function directoryDigest(directory) {
  const hash = createHash('sha256');
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  const paths = entries.map(entry => ({ entry, path: join(entry.parentPath, entry.name) })).sort((a, b) => a.path.localeCompare(b.path));
  for (const { entry, path } of paths) {
    hash.update(`${relative(directory, path)}\0`);
    if (entry.isFile()) for await (const chunk of createReadStream(path)) hash.update(chunk);
    else if (entry.isSymbolicLink()) hash.update(await readlink(path));
  }
  return hash.digest('hex');
}
const inputDigest = vdbPath ? await directoryDigest(resolve(vdbPath)) : null;
const browser = await chromium.launch({ headless: true });
const measurements = [];

async function importReport(page, kind) {
  const capability = page.waitForResponse(response => response.url().endsWith('/api/coverage/capabilities'));
  await page.locator('#coverage-import-btn').click();
  const response = await capability;
  assert.equal(await page.locator('#coverage-import-dialog').evaluate(dialog => dialog.open), true);
  if (kind === 'files') {
    await page.locator('#coverage-import-mode').selectOption('files');
    await page.locator('#coverage-folder').setInputFiles(resolve(reportDirectory));
  } else if (kind === 'xml') {
    await page.locator('#coverage-import-mode').selectOption('files');
    await page.locator('#coverage-files').setInputFiles(resolve(reportDirectory, 'session.xml'));
  } else {
    assert.equal(response.status(), 200, 'Local coverage service must be available');
    await page.locator('#coverage-import-mode').selectOption(kind);
    await page.locator('#coverage-server-path').fill(kind === 'vdb' ? vdbPath : resolve(reportDirectory));
    if (kind === 'vdb') {
      assert.equal(await page.locator('#coverage-timeout').inputValue(), '60');
      await page.locator('#coverage-timeout').fill('0');
    }
    await page.locator('#coverage-load-btn').click();
  }
  await page.waitForFunction(() => !document.querySelector('#coverage-mapping-fields').hidden, null, { timeout: 60_000 });
  await page.locator('#coverage-root-input').fill(expected.coverageRoot);
  const targetOptions = await page.locator('#coverage-target-select option').evaluateAll(options => options.map(option => ({ value: option.value, label: option.textContent })));
  const target = expected.targetRoot ? targetOptions.find(option => option.label === expected.targetRoot) : targetOptions.at(-1);
  assert.ok(target, 'Expected target hierarchy is available');
  await page.locator('#coverage-target-select').selectOption(target.value);
  await page.locator('#coverage-preview-btn').click();
  const mapping = await page.locator('#coverage-mapping-result').textContent();
  assert.ok(mapping.startsWith(`${expected.matched} matched;`), mapping);
  if (expected.unmatchedCoverage !== undefined) assert.ok(mapping.includes(`${expected.unmatchedCoverage} unmatched coverage instances`), mapping);
  await page.locator('#coverage-apply-btn').click();
  await page.waitForFunction(() => !document.querySelector('#coverage-import-dialog').open);
  assert.equal(await page.locator('#coverage-metric-select').inputValue(), 'line');
}

async function openInstance(page, instance) {
  if (await page.locator('#source-panel').evaluate(panel => panel.classList.contains('visible'))) await page.locator('#close-source-btn').click();
  await page.locator('#filter-scope-select').selectOption('path');
  await page.locator('#filter-mode-select').selectOption('regex');
  await page.locator('#search-input').fill(instance.query);
  if (!await page.locator('#match-panel').evaluate(panel => panel.classList.contains('visible'))) await page.locator('#toggle-match-btn').click();
  await page.waitForFunction(query => {
    const matches = [...document.querySelectorAll('.match-item .match-path')];
    return matches.length === 1 && new RegExp(query).test(matches[0].textContent);
  }, instance.query);
  await page.locator('.match-item').click();
  await page.waitForFunction(points => document.querySelector('#source-coverage-status').textContent.includes(`${points} points`), instance.points);
  for (const [line, ratio] of Object.entries(instance.lines)) {
    const cell = page.locator(`[data-coverage-line="${line}"]`);
    assert.equal(await cell.textContent(), ratio, `Line ${line} for ${instance.query}`);
  }
}

try {
  for (const [width, height] of [[1440, 1000], [390, 844]]) {
    const context = await browser.newContext({ viewport: { width, height } });
    try {
      const page = await context.newPage();
      const errors = [];
      const requests = [];
      page.on('request', request => requests.push(request.url()));
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(url);
      await page.waitForFunction(() => document.querySelector('#loading-overlay').classList.contains('hidden'));
      const canvas = page.locator('#treemap');
      const before = await canvas.screenshot();
      assert.equal(requests.filter(path => path.endsWith('/viewer-coverage.js')).length, 0, 'Coverage parser is not loaded during normal browsing');
      const start = performance.now();
      await importReport(page, 'files');
      const importMs = performance.now() - start;
      assert.equal(requests.filter(path => path.endsWith('/viewer-coverage.js')).length, 1, 'Coverage code loads once on Import');
      const after = await canvas.screenshot();
      assert.notDeepEqual(after, before, 'Coverage changes actual canvas pixels');
      await openInstance(page, expected.instances[0]);
      const firstLine = Number(Object.keys(expected.instances[0].lines)[0]);
      await page.locator(`[data-coverage-line="${firstLine}"]`).scrollIntoViewIfNeeded();
      await page.locator(`.source-lineno[data-line="${firstLine}"]`).click();
      assert.ok(await page.locator(`.source-lineno[data-line="${firstLine}"]`).evaluate(button => button.classList.contains('bookmarked')), 'Line-number bookmarking remains independent');
      await page.locator(`[data-coverage-line="${firstLine}"]`).click();
      assert.ok((await page.locator('#source-coverage-line-detail').textContent()).includes(`Line ${firstLine}:`));
      await page.locator('#source-coverage-next').click();
      assert.ok((await page.locator('#source-coverage-line-detail').textContent()).includes('uncovered'));
      await page.screenshot({ path: resolve(output, `${width}-line-coverage.png`), fullPage: true });
      await openInstance(page, expected.instances[1]);
      await openInstance(page, expected.instances[0]);
      const geometry = await page.locator('#source-code .source-line').evaluateAll(rows => {
        const viewport = document.querySelector('#source-code').getBoundingClientRect();
        const heights = rows.map(row => row.getBoundingClientRect()).filter(rect => rect.bottom > viewport.top && rect.top < viewport.bottom).map(rect => rect.height);
        return { min: Math.min(...heights), max: Math.max(...heights) };
      });
      assert.ok(geometry.max - geometry.min < 1, JSON.stringify(geometry));
      await page.locator('#source-coverage-toggle').uncheck();
      assert.equal(await page.locator('[data-coverage-line]').count(), 0, 'Disabling line coverage removes cells');
      await page.locator('#source-coverage-toggle').check();
      assert.ok(await page.locator('[data-coverage-line]').count());
      await page.locator('#close-source-btn').click();
      await page.locator('#coverage-metric-select').selectOption('toggle');
      await page.screenshot({ path: resolve(output, `${width}-heatmap.png`), fullPage: true });
      await page.locator('#coverage-clear-btn').click();
      assert.equal(await page.locator('#coverage-metric-select').isEnabled(), true, 'Turning off coloring keeps the report available');
      assert.equal(await page.locator('#coverage-metric-select').inputValue(), 'off');
      await page.locator('#coverage-metric-select').selectOption('line');
      await openInstance(page, expected.instances[0]);
      await page.locator('#close-source-btn').click();
      await importReport(page, 'xml');
      await page.locator('.match-item').click();
      await page.waitForFunction(() => document.querySelector('#source-coverage-status').textContent.includes('unavailable'));
      assert.equal(await page.locator('[data-coverage-line]').count(), 0, 'XML-only import must not retain old line data');
      await page.locator('#close-source-btn').click();
      if (width === 1440) {
        await importReport(page, 'report');
        await openInstance(page, expected.instances[0]);
        await page.locator('#close-source-btn').click();
        if (vdbPath) {
          await importReport(page, 'vdb');
          await openInstance(page, expected.instances[0]);
          await page.screenshot({ path: resolve(output, 'vdb-line-coverage.png'), fullPage: true });
        }
      }
      assert.deepEqual(errors, [], 'Coverage workflows have no browser runtime errors');
      measurements.push({ width, height, importMs, lineHeight: geometry.min });
    } finally { await context.close(); }
  }
  if (vdbPath) assert.equal(await directoryDigest(resolve(vdbPath)), inputDigest, 'VDB files remain byte-identical after imports');
  await writeFile(resolve(output, 'results.json'), JSON.stringify(measurements, null, 2));
  console.log(JSON.stringify({ passed: true, vdbUnchanged: !!vdbPath, measurements, screenshots: output }, null, 2));
} finally { await browser.close(); }
