import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { createServer, type ViteDevServer } from 'vite';
import { chromium, type Browser, type Page } from 'playwright';
import type { createSourceReader } from '../rust-hier-viewer/src/html/frontend/source-reader';
import type { ViewerState } from '../rust-hier-viewer/src/html/frontend/types';

declare global {
  interface Window {
    reader: ReturnType<typeof createSourceReader>;
    readerState: ViewerState;
    readerReady: boolean;
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
const data = { rootId: 0, defaultMetric: 'instances', title: 'Reader fixture', builtAtUnixMs: 0, debugUiLabels: false, analysisDefinitions: null, analysisFile: null, nodes: [] };
const state = createViewerState(data);
// These tests render source lines directly; hierarchy navigation is exercised by the full viewer test.
const reader = createSourceReader({
  state,
  getNode() { throw new Error('Unexpected hierarchy lookup in source-only fixture'); },
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
</script></body></html>`;
  server = await createServer({
    configFile: false, root, publicDir: false, appType: 'custom',
    server: { host: '127.0.0.1', port: 0 },
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
