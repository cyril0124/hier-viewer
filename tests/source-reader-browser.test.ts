import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { createServer, type ViteDevServer } from 'vite';
import { chromium, type Browser, type Page } from 'playwright';
import type { createSourceReader } from '../rust-hier-viewer/src/html/frontend/source-reader';
import type { ViewerState, HierarchyNode } from '../rust-hier-viewer/src/html/frontend/types';
import type { CoverageSummary, CoverageSelection } from '../rust-hier-viewer/src/html/frontend/coverage-types';

declare global {
  interface Window {
    reader: ReturnType<typeof createSourceReader>;
    readerState: ViewerState;
    readerReady: boolean;
    parseCoverageSummary: (xml: string) => CoverageSummary;
    readerCoverage: CoverageSelection | null;
    readerNodes: HierarchyNode[];
    deferCoverage: boolean;
    largeCoverage: boolean;
    releaseCoverage: (() => void) | null;
  }
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let server: ViteDevServer;
let browser: Browser;
let url: string;
const errors = new WeakMap<Page, string[]>();

beforeAll(async () => {
  const htmlRoot = resolve(root, 'rust-hier-viewer/src/html');
  const [body, styles] = await Promise.all([
    readFile(resolve(htmlRoot, 'template_body.html'), 'utf8'),
    readFile(resolve(htmlRoot, 'template_styles.css'), 'utf8'),
  ]);
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${styles}</style></head><body>${body}<script type="module">
import { createSourceReader } from '/rust-hier-viewer/src/html/frontend/source-reader.ts';
import { createViewerState } from '/rust-hier-viewer/src/html/frontend/state.ts';
import { createPersistence } from '/rust-hier-viewer/src/html/frontend/persistence.ts';
import { parseCoverageSummary } from '/rust-hier-viewer/src/html/frontend/coverage.ts';
window.parseCoverageSummary = parseCoverageSummary;
const data = { rootId: 0, defaultMetric: 'instances', title: 'Reader fixture', builtAtUnixMs: 0, debugUiLabels: false, analysisDefinitions: null, analysisFile: null, nodes: [] };
const state = createViewerState(data);
// These tests render source lines directly; hierarchy navigation is exercised by the full viewer test.
const reader = createSourceReader({
  state,
  getNode(id) { if (window.readerNodes?.[id]) return window.readerNodes[id]; throw new Error('Unexpected hierarchy lookup in source-only fixture'); },
  getCoverage() { return window.readerCoverage ?? null; },
  savePersistedState: () => persistence.savePersistedState(),
  registerSearchHistoryInput: (...args) => persistence.registerSearchHistoryInput(...args),
  scheduleUiAnnotations() {}, cancelScheduledHoverUpdate() {}, clearUiAnnotationHoverTargetWithin() {},
  hoverCard: document.getElementById('hover-card'),
  updateHover() { throw new Error('Unexpected hover update in source-only fixture'); },
});
const persistence = createPersistence({ state, nodes: data.nodes, normalizeSourceBookmarks: reader.normalizeSourceBookmarks, expandTreePath() { throw new Error('Unexpected tree expansion in source-only fixture'); } });
reader.bindSourceEvents();
reader.sourcePanel.classList.add('visible');
window.reader = reader;
window.readerState = state;
window.readerReady = true;
document.getElementById('loading-overlay').classList.add('hidden');
</script></body></html>`;
  server = await createServer({
    configFile: false, root, publicDir: false, appType: 'custom',
    server: { host: '127.0.0.1', port: 0, watch: null },
    plugins: [{
      name: 'source-reader-fixture',
      configureServer(vite) {
        vite.middlewares.use('/source-reader-fixture.html', (_request, response) => {
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          response.end(html);
        });
      },
    }],
  });
  await server.listen();
  url = `${server.resolvedUrls!.local[0]}source-reader-fixture.html`;
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

async function openPage(width: number, height: number) {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  const failures: string[] = [];
  errors.set(page, failures);
  page.on('pageerror', (error) => failures.push(error.message));
  await page.goto(url);
  await page.waitForFunction(() => window.readerReady === true);
  assert.deepEqual(await page.evaluate(() => ({ width: innerWidth, height: innerHeight })), { width, height });
  return page;
}

async function checkPlainSearch(page: Page) {
  await page.evaluate(() => {
    window.readerState.sourceSearch = '';
    const input = document.querySelector<HTMLInputElement>('#source-search-input')!;
    input.value = '';
    const lines = new Array<string>(500000).fill('wire x;');
    lines[999] = 'needle_a;';
    lines[1999] = 'needle_b;';
    window.reader.renderSourceLines(lines, 1, 1, 1, { targetKind: 'instance', bookmarkKey: 'plain-fixture' });
    input.focus();
  });
  assert.equal(await page.evaluate(() => window.reader.currentSourceView!.renderMode), 'plain');
  let query = '';
  for (const character of 'needle') {
    query += character;
    await page.keyboard.type(character);
    await page.waitForFunction((expected) => {
      const textarea = document.querySelector<HTMLTextAreaElement>('.source-plain-text')!;
      return document.querySelector('#source-search-status')!.textContent === '1/2 matches'
        && textarea.value.slice(textarea.selectionStart, textarea.selectionEnd) === expected;
    }, query);
    const result = await page.evaluate(() => {
      const textarea = document.querySelector<HTMLTextAreaElement>('.source-plain-text')!;
      return { focused: document.activeElement!.id, selected: textarea.value.slice(textarea.selectionStart, textarea.selectionEnd), start: textarea.selectionStart, expected: textarea.value.indexOf('needle_a') };
    });
    assert.equal(result.focused, 'source-search-input');
    assert.equal(result.selected, query);
    assert.equal(result.start, result.expected);
  }
  for (const [key, status, marker] of [['Enter', '2/2 matches', 'needle_b'], ['Shift+Enter', '1/2 matches', 'needle_a']] as const) {
    await page.keyboard.press(key);
    const result = await page.evaluate((wanted) => {
      const textarea = document.querySelector<HTMLTextAreaElement>('.source-plain-text')!;
      const rect = textarea.getBoundingClientRect();
      const style = getComputedStyle(textarea);
      const line = wanted === 'needle_a' ? 999 : 1999;
      const y = rect.top + parseFloat(style.paddingTop) + line * parseFloat(style.lineHeight) - textarea.scrollTop;
      return {
        focused: document.activeElement!.id, status: document.querySelector('#source-search-status')!.textContent,
        selected: textarea.value.slice(textarea.selectionStart, textarea.selectionEnd), start: textarea.selectionStart,
        expected: textarea.value.indexOf(wanted), lineVisible: rect.height > 0 && y >= rect.top && y + parseFloat(style.lineHeight) <= rect.bottom,
      };
    }, marker);
    assert.equal(result.focused, 'source-search-input');
    assert.equal(result.status, status);
    assert.equal(result.selected, 'needle');
    assert.equal(result.start, result.expected);
    assert.equal(result.lineVisible, true);
  }
}

async function checkHorizontalSearch(page: Page) {
  await page.evaluate(() => {
    window.readerState.sourceSearch = '';
    const input = document.querySelector<HTMLInputElement>('#source-search-input')!;
    input.value = '';
    const lines = new Array<string>(500).fill('wire x;');
    lines[249] = ' '.repeat(400) + 'needle_a;';
    lines[349] = 'needle_b;';
    window.reader.renderSourceLines(lines, 1, 1, 1, { targetKind: 'instance', bookmarkKey: 'long-line-fixture' });
    document.querySelector('#source-code')!.scrollLeft = 0;
    input.focus();
  });
  await page.locator('#source-search-input').fill('needle');
  await page.waitForFunction(() => document.querySelector('#source-search-status')!.textContent === '1/2 matches');
  for (const [key, expectedLine] of [[null, 250], ['Enter', 350], ['Shift+Enter', 250]] as const) {
    if (key) await page.keyboard.press(key);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const result = await page.evaluate(() => {
      const code = document.querySelector<HTMLElement>('#source-code')!;
      const hit = code.querySelector<HTMLElement>('.source-find-hit.current')!;
      const rect = hit.getBoundingClientRect();
      const viewport = code.getBoundingClientRect();
      return {
        virtualized: window.reader.currentSourceView!.virtualized,
        line: Number(hit.closest<HTMLElement>('.source-line')!.dataset.line), text: hit.textContent, focused: document.activeElement!.id,
        left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
        viewportLeft: Math.max(0, viewport.left), viewportRight: Math.min(innerWidth, viewport.left + code.clientWidth),
        viewportTop: Math.max(0, viewport.top), viewportBottom: Math.min(innerHeight, viewport.top + code.clientHeight), scrollLeft: code.scrollLeft,
      };
    });
    const detail = JSON.stringify(result);
    assert.equal(result.virtualized, true, detail);
    assert.equal(result.line, expectedLine, detail);
    assert.equal(result.text, 'needle', detail);
    assert.equal(result.focused, 'source-search-input', detail);
    assert.ok(result.left >= result.viewportLeft - 1 && result.right <= result.viewportRight + 1, detail);
    assert.ok(result.top >= result.viewportTop - 1 && result.bottom <= result.viewportBottom + 1, detail);
    if (expectedLine === 250) assert.ok(result.scrollLeft > 0, detail);
  }
}

describe('production source reader', () => {
  test('coverage follows cached-file instances, rejects stale responses, and keeps plain mode bounded', async () => {
    const page = await openPage(1280, 900);
    let sourceRequests = 0;
    const sourceLines = Array.from({ length: 400 }, (_, index) => `wire signal_${index};`);
    const sourceText = sourceLines.join('\n');
    await page.route('**/coverage-fixture.sv', route => { sourceRequests++; return route.fulfill({ contentType: 'text/plain', body: sourceText }); });
    try {
      await page.evaluate(lines => {
        window.readerNodes = [0, 1].map(id => ({ id, name: `q${id}`, path: `dut.q${id}`, module: 'Queue', parent: null, children: [], definitionFilePath: '/fixtures/queue.sv', definitionSourceHref: '/coverage-fixture.sv', definitionLine: 1, definitionEndLine: 400 } as unknown as HierarchyNode));
        const scopes = [0, 1].map(id => ({ name: `q${id}`, path: `dut.q${id}`, parent: null, children: [], metrics: { assert: { covered: 1, total: 3, excluded: 0 } } }));
        window.readerCoverage = {
          display: { name: 'fixture', metric: 'line', summary: { release: 'test', roots: [0, 1], byPath: new Map(scopes.map((scope, id) => [scope.path, id])), scopes }, mapping: { sourceRoot: 0, targetRoot: 0, scopeByNode: new Int32Array([0, 1]), matched: 2, unmatchedScopes: [], unmatchedNodeIds: [] } },
          source: { id: 'fixture', name: 'fixture', files: [], readText: async () => '' },
          report: {
            async getMetricDetail(instancePath, _moduleName, metric) {
              if (metric === 'assert') return { instancePath, metric, filePath: '/fixtures/queue.sv', blocks: [
                { kind: 'table', rows: [{ header: true, status: 'neutral', cells: ['Total', 'Covered'] }, { header: false, status: 'neutral', cells: ['3', '1'] }] },
                { kind: 'table', title: 'Assertions', rows: [
                  { header: true, status: 'neutral', cells: ['Name', 'Failures', 'Successes', 'Status'] },
                  { header: false, status: 'covered', cells: ['passed', '0', '4', 'Succeeded'] },
                  { header: false, status: 'failed', cells: ['mixed', '1', '2', 'Failed'] },
                  { header: false, status: 'uncovered', cells: ['never', '0', '0', 'No success'] },
                  { header: false, status: 'neutral', cells: ['unknown', '-', '-', 'Unknown'] },
                ] },
              ] };
              return { instancePath, metric, filePath: '/fixtures/queue.sv', blocks: [{ kind: 'table', rows: [{ cells: ['Total', 'Covered'], header: true, status: 'neutral' }, { cells: ['205', '204'], header: false, status: 'neutral' }] }, { kind: 'table', rows: [{ cells: ['Signal', 'Status'], header: true, status: 'neutral' }, ...Array.from({ length: 205 }, (_, index) => ({ cells: [`signal_${index}<img src=x onerror=alert(1)>`, index === 204 ? 'No' : 'Yes'], header: false, status: index === 204 ? 'uncovered' as const : 'covered' as const }))] }] };
            },
            clear() {},
            async getLineCoverage(path) {
              const second = path === 'dut.q1';
              const numbers = window.largeCoverage ? Array.from({ length: 400 }, (_, index) => index + 1) : [25, 26, 27, 28, 31, 32, 33, 34];
              const rows = numbers.map(line => {
                const excluded = !window.largeCoverage && !second && line === 31;
                const total = !window.largeCoverage && line === 34 ? 2 : 1;
                let covered: number;
                if (window.largeCoverage) {
                  covered = Number(line !== 400);
                } else if (second) {
                  covered = total;
                } else if (excluded) {
                  covered = 0;
                } else if (line === 34) {
                  covered = 1;
                } else {
                  covered = Number(![28, 32, 33].includes(line));
                }
                return { line, covered, total, sourceText: lines[line - 1], excluded };
              });
              const result = { instancePath: path, filePath: '/fixtures/queue.sv', lines: rows, totals: { covered: rows.reduce((sum, row) => sum + row.covered, 0), total: rows.length, excluded: 0 }, reportPath: 'mod0.html#Line' };
              if (window.deferCoverage && !second) return new Promise(resolve => { window.releaseCoverage = () => resolve(result); });
              return result;
            },
          },
        };
      }, sourceLines);
      await page.evaluate(() => window.reader.renderSource(0, 'definition'));
      await page.waitForFunction(() => document.querySelector('[data-coverage-line="28"]')?.textContent === '0/1');
      await page.evaluate(() => {
        const original = window.readerCoverage!.report.getLineCoverage;
        window.readerCoverage!.report.getLineCoverage = async (...args) => {
          const data = await original(...args);
          return data ? { ...data, filePath: '/old/different.sv' } : null;
        };
        window.readerCoverage = { ...window.readerCoverage! };
        window.reader.refreshCoverage();
      });
      await page.waitForFunction(() => document.querySelector('#source-coverage-status')!.textContent!.includes('Source file does not match') && !document.querySelector('[data-coverage-line]'));
      assert.equal(await page.locator('[data-coverage-line]').count(), 0);
      await page.evaluate(() => {
        const original = window.readerCoverage!.report.getLineCoverage;
        window.readerCoverage!.report.getLineCoverage = async (...args) => {
          const data = await original(...args);
          return data ? { ...data, filePath: '/old/queue.sv' } : null;
        };
        window.readerCoverage = { ...window.readerCoverage! };
        window.reader.refreshCoverage();
      });
      await page.waitForFunction(() => document.querySelector('[data-coverage-line="28"]')?.textContent === '0/1');
      assert.match(await page.locator('#source-coverage-status').textContent() ?? '', /report text matched; source relocated/);
      await page.evaluate(() => {
        const view = window.reader.currentSourceView!;
        view.lines![27] = 'different RTL;';
        window.readerCoverage = { ...window.readerCoverage! };
        window.reader.refreshCoverage();
      });
      await page.waitForFunction(() => document.querySelector('#source-coverage-status')!.textContent!.includes('Source text does not match') && !document.querySelector('[data-coverage-line]'));
      assert.equal(await page.locator('[data-coverage-line]').count(), 0, 'Relocated sources must still pass source text validation');
      await page.evaluate(() => {
        window.reader.currentSourceView!.lines![27] = 'wire signal_27;';
        window.readerCoverage = { ...window.readerCoverage! };
        window.reader.refreshCoverage();
      });
      await page.waitForFunction(() => document.querySelector('[data-coverage-line="28"]')?.textContent === '0/1');
      await page.locator('[data-coverage-export-line="28"]').check();
      assert.equal(await page.locator('#coverage-export-count').textContent(), '1 selected');
      await page.locator('#coverage-export-open').click();
      const firstExport = await page.locator('#coverage-export-text').inputValue();
      assert.match(firstExport, /"coverageInstance": "dut.q0"/);
      assert.match(firstExport, /"covered": 0/);
      assert.match(firstExport, /28: wire signal_27;/);
      await page.locator('#coverage-export-close').click();
      await page.locator('#coverage-export-uncovered').click();
      assert.equal(await page.locator('#coverage-export-count').textContent(), '4 selected');
      assert.equal(await page.locator('[data-coverage-export-line="31"]').isChecked(), false, 'Excluded Line rows are not selected');
      assert.equal(await page.locator('[data-coverage-export-line="34"]').isChecked(), true, 'Partially covered Line rows are selected');
      await page.locator('#coverage-export-uncovered').click();
      assert.equal(await page.locator('#coverage-export-count').textContent(), '4 selected', 'Bulk selection is idempotent');
      await page.locator('[data-coverage-export-line="25"]').check();
      await page.locator('#coverage-export-uncovered').click();
      assert.equal(await page.locator('#coverage-export-count').textContent(), '5 selected', 'Bulk selection keeps explicitly selected covered rows');
      await page.locator('.source-lineno[data-line="28"]').click();
      assert.equal(await page.locator('.source-lineno[data-line="28"]').getAttribute('aria-pressed'), 'true');
      const heights = await page.locator('.source-virtual-content .source-line').evaluateAll(rows => rows.map(row => row.getBoundingClientRect().height));
      assert.ok(Math.max(...heights) - Math.min(...heights) < 1);
      await page.evaluate(async () => { window.deferCoverage = true; await window.reader.renderSource(0, 'definition'); });
      await page.waitForFunction(() => !!window.releaseCoverage);
      await page.evaluate(() => window.reader.renderSource(1, 'definition'));
      await page.waitForFunction(() => document.querySelector('[data-coverage-line="28"]')?.textContent === '1/1');
      await page.evaluate(() => window.releaseCoverage!());
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await page.locator('[data-coverage-line="28"]').textContent(), '1/1');
      assert.equal(sourceRequests, 1, 'Source text cache remains shared by file');
      assert.equal(await page.locator('#coverage-export-count').textContent(), '0 selected', 'Changing instances clears selection');
      await page.locator('[data-coverage-export-line="28"]').check();
      await page.locator('[data-coverage-metric="toggle"]').click();
      await page.waitForFunction(() => document.querySelectorAll('#coverage-detail-content .coverage-result-table tbody tr').length === 100);
      assert.equal(await page.locator('#coverage-detail-content img').count(), 0, 'Report cells remain inert text');
      await page.locator('#coverage-export-uncovered').click();
      assert.equal(await page.locator('#coverage-export-count').textContent(), '2 selected', 'Select uncovered includes hidden pages');
      assert.equal(await page.locator('[data-coverage-export-key]:checked').count(), 1, 'Covered detail rows are not selected');
      await page.locator('[data-coverage-export-page]').check();
      assert.equal(await page.locator('#coverage-export-count').textContent(), '102 selected');
      await page.getByRole('button', { name: 'Next rows', exact: true }).click();
      assert.equal(await page.locator('.coverage-table-pagination span').textContent(), '101–200 / 205');
      assert.equal(await page.locator('[data-coverage-export-page]').isChecked(), false);
      await page.getByRole('button', { name: 'Next rows', exact: true }).click();
      assert.equal(await page.locator('#coverage-detail-content .coverage-result-table tbody tr').count(), 5);
      await page.locator('#coverage-detail-missing').check();
      assert.equal(await page.locator('#coverage-detail-content .coverage-result-table tbody tr').count(), 1);
      await page.locator('[data-coverage-export-page]').check();
      assert.equal(await page.locator('#coverage-export-count').textContent(), '102 selected', 'Filtering keeps earlier selections');
      await page.locator('#coverage-export-open').click();
      const exported = await page.locator('#coverage-export-text').inputValue();
      assert.match(exported, /"coverageInstance": "dut.q1"/);
      assert.match(exported, /## Line/);
      assert.match(exported, /## Toggle/);
      assert.match(exported, /signal_204<img/);
      assert.ok(!exported.includes('signal_100<img'), 'Other pages are not implicitly selected');
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
      await page.locator('#coverage-export-copy').click();
      await page.waitForFunction(() => document.querySelector('#coverage-export-status')!.textContent!.startsWith('Copied.'));
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), exported);
      const downloaded = page.waitForEvent('download');
      await page.locator('#coverage-export-download').click();
      const download = await downloaded;
      assert.equal(download.suggestedFilename(), 'coverage-selection.md');
      assert.equal(await readFile((await download.path())!, 'utf8'), exported);
      await page.setViewportSize({ width: 390, height: 844 });
      const bounds = await page.locator('#coverage-export-dialog').boundingBox();
      assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390 && bounds.height <= 844);
      await page.evaluate(() => {
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
        document.execCommand = () => false;
      });
      await page.locator('#coverage-export-copy').click();
      assert.match(await page.locator('#coverage-export-status').textContent() ?? '', /Text selected/);
      assert.equal(await page.locator('#coverage-export-text').evaluate((textarea: HTMLTextAreaElement) => textarea.value.slice(textarea.selectionStart, textarea.selectionEnd)), exported);
      await page.locator('#coverage-export-close').click();
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.locator('[data-coverage-metric="line"]').click();
      assert.equal(await page.locator('[data-coverage-export-line="28"]').isChecked(), true, 'Tab changes keep line selections');
      await page.locator('#coverage-export-clear').click();
      assert.equal(await page.locator('[data-coverage-export-line="28"]').isChecked(), false);
      await page.locator('[data-coverage-export-line="28"]').check();
      await page.evaluate(() => { window.readerCoverage = { ...window.readerCoverage! }; window.reader.refreshCoverage(); });
      assert.equal(await page.locator('#coverage-export-count').textContent(), '0 selected', 'Replacing a report clears selection');
      await page.locator('[data-coverage-metric="assert"]').click();
      await page.locator('#coverage-export-uncovered').click();
      assert.equal(await page.locator('#coverage-export-count').textContent(), '2 selected', 'Assert includes failures and no success, excluding covered and unknown rows');
      await page.locator('#coverage-export-open').click();
      const assertionExport = await page.locator('#coverage-export-text').inputValue();
      assert.match(assertionExport, /"mixed"/);
      assert.match(assertionExport, /"never"/);
      assert.ok(!assertionExport.includes('"passed"') && !assertionExport.includes('"unknown"'));
      await page.locator('#coverage-export-close').click();
      await page.locator('[data-coverage-metric="line"]').click();
      await page.evaluate(lines => {
        window.largeCoverage = true;
        const large = new Array<string>(500000).fill('wire padding;');
        large.splice(0, lines.length, ...lines);
        window.reader.renderSourceLines(large, 1, 1, 1, { targetKind: 'definition' });
      }, sourceLines);
      await page.waitForFunction(() => !document.querySelector<HTMLElement>('#source-coverage-plain')!.hidden && document.querySelector<HTMLSelectElement>('#source-coverage-line-select')!.options.length === 200);
      assert.equal(await page.evaluate(() => window.reader.currentSourceView!.renderMode), 'plain');
      await page.locator('#source-coverage-page-next').click();
      assert.equal(await page.locator('#source-coverage-page').textContent(), '201–400 / 400');
      await page.locator('#source-coverage-next').click();
      const selected = await page.locator('.source-plain-text').evaluate((textarea: HTMLTextAreaElement) => textarea.value.slice(textarea.selectionStart, textarea.selectionEnd));
      assert.equal(selected, sourceLines[399]);
      await page.locator('#coverage-export-add-line').click();
      await page.locator('#coverage-export-open').click();
      assert.match(await page.locator('#coverage-export-text').inputValue(), /"line": 400/);
      await page.evaluate(() => { window.readerCoverage = null; window.reader.refreshCoverage(); });
      assert.equal(await page.locator('#coverage-export-dialog').evaluate((dialog: HTMLDialogElement) => dialog.open), false);
      assert.equal(await page.locator('#coverage-export-text').inputValue(), '');
      assert.equal(await page.locator('#source-coverage-bar').isVisible(), false);
      assert.deepEqual(errors.get(page), []);
    } finally { await page.context().close(); }
  });
  test('native XML coverage parser preserves scopes and rejects invalid coverage', async () => {
    const page = await openPage(1280, 900);
    try {
      const result = await page.evaluate(() => {
        const wrap = (body: string) => `<session version="1.1" release="U-2023.03"><old_coverage>${body}</old_coverage></session>`;
        const xml = wrap('<scope type="instance" name="tb"><metric name="Line" value="1/2" excl="1"/><metric name="Cond" value="3/4"/><metric name="Assert" value="2/5" excl="0"/><scope type="instance" name="dut"><metric name="Toggle" value="0/0" excl="0"/><metric name="Branch" value="0/0" excl="2"/></scope></scope><scope type="Groups" name="top"/><scope type="Asserts" name="top"/>');
        const summary = window.parseCoverageSummary(xml);
        const invalid = [
          '<broken>',
          '<!DOCTYPE session [<!ENTITY x SYSTEM "http://invalid.test/external">]>' + xml,
          wrap('<scope type="instance" name="tb"><metric name="Line" value="3/2"/></scope>'),
          wrap('<scope type="instance" name="tb"><metric name="Line" value="-1/2"/></scope>'),
          wrap('<scope type="instance" name="tb"><metric name="Line" value="1/9007199254740992"/></scope>'),
          wrap('<scope type="instance" name="tb"/><scope type="instance" name="tb"/>'),
          wrap('<scope type="instance" name="tb"><metric name="Line" value="0/0"/><metric name="Line" value="0/0"/></scope>'),
          '<session version="2.0" release="test"/>',
        ];
        return {
          scopes: summary.scopes.map(scope => ({ path: scope.path, parent: scope.parent, metrics: scope.metrics })),
          rejected: invalid.map(input => { try { window.parseCoverageSummary(input); return false; } catch { return true; } }),
        };
      });
      assert.deepEqual(result.scopes, [
        { path: 'tb', parent: null, metrics: { line: { covered: 1, total: 2, excluded: 1 }, condition: { covered: 3, total: 4, excluded: 0 }, assert: { covered: 2, total: 5, excluded: 0 } } },
        { path: 'tb.dut', parent: 0, metrics: { toggle: { covered: 0, total: 0, excluded: 0 }, branch: { covered: 0, total: 0, excluded: 2 } } },
      ]);
      assert.ok(result.rejected.every(Boolean), JSON.stringify(result));
      assert.deepEqual(errors.get(page), []);
    } finally { await page.context().close(); }
  });
  for (const [width, height] of [[1280, 900], [390, 844]] as const) {
    for (const [name, check] of [['virtual long-line search', checkHorizontalSearch], ['500000-line plain search', checkPlainSearch]] as const) {
      test(`${width}x${height}: ${name}`, async () => {
        const page = await openPage(width, height);
        try {
          await check(page);
          assert.deepEqual(errors.get(page), [], 'Browser runtime errors');
        } finally {
          await page.context().close();
        }
      });
    }
  }
});
