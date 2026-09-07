'use strict';

const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { promisify } = require('node:util');

const execute = promisify(execFile);
const session = `source-reader-${process.pid}`;
const root = path.join(__dirname, '../rust-hier-viewer/src/html');
const source = fs.readFileSync(path.join(root, 'template_app.js'), 'utf8');
const body = fs.readFileSync(path.join(root, 'template_body.html'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'template_styles.css'), 'utf8');

function one(pattern, label) {
  const matches = [...source.matchAll(pattern)];
  assert.equal(matches.length, 1, `exactly one ${label}`);
  return matches[0][0];
}

// Load complete, unmodified reader declarations, not a second implementation.
const declarations = [...source.matchAll(/^    (?:async )?function \w+\([^\n]*\) \{[\s\S]*?^    \}/gm)];
const start = declarations.findIndex((match) => match[0].startsWith('    function nodeHasInstanceSource('));
const end = declarations.findIndex((match) => match[0].startsWith('    function sourceRenderModeStatusSuffix('));
assert.ok(start >= 0 && end > start, 'reader declaration boundaries exist');
const readerFunctions = declarations.slice(start, end).map((match) => match[0]).join('\n');
const searchInputFunction = one(/^    function applySourceSearchValue\([^\n]*\) \{[\s\S]*?^    \}/gm, 'search input function');
const handlers = [...source.matchAll(/^    sourceSearch(?:ModeSelect|Input|PrevBtn|NextBtn)\.addEventListener\([^\n]*\{[\s\S]*?^    \}\);/gm)];
assert.equal(handlers.length, 5, 'reader search event handlers');
const scrollHandler = one(/^    sourceCode\.addEventListener\("scroll",[^\n]*\{[\s\S]*?^    \}\);/gm, 'reader scroll handler');
const elements = [...source.matchAll(/^    const (\w+) = document\.getElementById\("([^"]+)"\);/gm)]
  .filter((match) => /source/i.test(match[1])).map((match) => match[0]).join('\n');
const constants = source.split('\n').filter((line) => /^    const SOURCE_/.test(line)).join('\n');
const panel = body.match(/    <aside class="source-panel"[\s\S]*?<\/aside>/);
assert.ok(panel, 'original source reader HTML exists');

const readerScript = `
window.readerErrors = [];
window.addEventListener('error', (event) => readerErrors.push(event.message));
window.addEventListener('unhandledrejection', (event) => readerErrors.push(String(event.reason)));
${elements}
${constants}
const state = {
  sourceSearch: '', sourceSearchMode: 'wildcard', sourceSearchMatchIndex: -1,
  sourceSearchError: '', sourceBookmarksByFile: {}, sourceNodeId: null,
  sourceBookmarkEditingKey: null, sourceBookmarkEditingLine: null,
  sourceBookmarkEditingDraft: '',
};
let currentSourceView = null;
let sourceSearchMatchElements = [];
let sourceSearchInputTimer = null;
const sourceLineHeightCache = new Map();
let sourceVirtualRenderQueued = false;
let sourceVirtualRenderForce = false;
${readerFunctions}
${searchInputFunction}
${handlers.map((match) => match[0]).join('\n')}
${scrollHandler}
sourcePanel.classList.add('visible');
window.readerReady = true;
`;
const routes = new Map([
  ['/', ['text/html', `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/styles.css"></head><body>${panel[0]}<script src="/reader.js"></script></body></html>`]],
  ['/styles.css', ['text/css', styles]],
  ['/reader.js', ['text/javascript', readerScript]],
]);
const server = http.createServer((request, response) => {
  const route = routes.get(request.url);
  if (!route) {
    response.writeHead(404);
    response.end('Not found');
    return;
  }
  response.writeHead(200, { 'Content-Type': `${route[0]}; charset=utf-8` });
  response.end(route[1]);
});

async function browser(...args) {
  const { stdout } = await execute('agent-browser', ['--session', session, '--json', ...args], {
    timeout: 30000,
    maxBuffer: 1024 * 1024,
  });
  const result = JSON.parse(stdout);
  assert.equal(result.success, true, result.error || `agent-browser ${args[0]} failed`);
  return result.data;
}

async function evaluate(code) {
  return (await browser('eval', code)).result;
}

async function checkPlainSearch(viewport) {
  await evaluate(`(() => {
    state.sourceSearch = '';
    sourceSearchInput.value = '';
    const lines = new Array(500000).fill('wire x;');
    lines[999] = 'needle_a;';
    lines[1999] = 'needle_b;';
    renderSourceLines(lines, 1, 1, 1, {targetKind: 'instance', bookmarkKey: 'plain-fixture'});
    sourceSearchInput.focus();
  })()`);
  assert.equal(await evaluate('currentSourceView.renderMode'), 'plain');
  let query = '';
  for (const character of 'needle') {
    query += character;
    await browser('press', character);
    // Wait for the production debounce and rendering, not a fixed sleep.
    await browser('wait', '--fn', `sourceSearchInputTimer === null && sourceSearchInput.value === ${JSON.stringify(query)} && sourceSearchStatus.textContent === '1/2 matches'`);
    const result = await evaluate(`(() => {
      const textarea = plainSourceTextarea();
      return {
        focused: document.activeElement.id,
        selected: textarea.value.slice(textarea.selectionStart, textarea.selectionEnd),
        start: textarea.selectionStart,
        expected: textarea.value.indexOf('needle_a'),
      };
    })()`);
    assert.equal(result.focused, 'source-search-input', `${viewport}: focus after ${query}`);
    assert.equal(result.selected, query, `${viewport}: selection after ${query}`);
    assert.equal(result.start, result.expected, `${viewport}: first hit after ${query}`);
  }
  for (const [key, status, marker] of [
    ['Enter', '2/2 matches', 'needle_b'],
    ['Shift+Enter', '1/2 matches', 'needle_a'],
  ]) {
    await browser('press', key);
    const result = await evaluate(`(() => {
      const textarea = plainSourceTextarea();
      const rect = textarea.getBoundingClientRect();
      const style = getComputedStyle(textarea);
      const line = ${JSON.stringify(marker)} === 'needle_a' ? 999 : 1999;
      const y = rect.top + parseFloat(style.paddingTop) + line * parseFloat(style.lineHeight) - textarea.scrollTop;
      return {
        focused: document.activeElement.id,
        status: sourceSearchStatus.textContent,
        selected: textarea.value.slice(textarea.selectionStart, textarea.selectionEnd),
        start: textarea.selectionStart,
        expected: textarea.value.indexOf(${JSON.stringify(marker)}),
        lineVisible: rect.height > 0 && y >= rect.top && y + parseFloat(style.lineHeight) <= rect.bottom,
      };
    })()`);
    assert.equal(result.focused, 'source-search-input', `${viewport}: focus after ${key}`);
    assert.equal(result.status, status, `${viewport}: result counter after ${key}`);
    assert.equal(result.selected, 'needle', `${viewport}: selection after ${key}`);
    assert.equal(result.start, result.expected, `${viewport}: target after ${key}`);
    assert.equal(result.lineVisible, true, `${viewport}: selected line visible after ${key}`);
  }
  console.log(`PASS ${viewport}: 500000-line plain search retains focus after every debounced character; Enter/Shift+Enter select and reveal the correct hit`);
}

async function checkHorizontalSearch(viewport) {
  await evaluate(`(() => {
    state.sourceSearch = '';
    sourceSearchInput.value = '';
    const lines = new Array(500).fill('wire x;');
    lines[249] = ' '.repeat(400) + 'needle_a;';
    lines[349] = 'needle_b;';
    renderSourceLines(lines, 1, 1, 1, {targetKind: 'instance', bookmarkKey: 'long-line-fixture'});
    sourceCode.scrollLeft = 0;
    sourceSearchInput.focus();
  })()`);
  await browser('fill', '#source-search-input', 'needle');
  await browser('wait', '--fn', "sourceSearchInputTimer === null && sourceSearchStatus.textContent === '1/2 matches'");
  for (const [key, expectedLine] of [[null, 250], ['Enter', 350], ['Shift+Enter', 250]]) {
    if (key) await browser('press', key);
    // Allow the real scroll listener and virtual-window RAF to finish, too.
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const result = await evaluate(`(() => {
      const hit = sourceCode.querySelector('.source-find-hit.current');
      const rect = hit.getBoundingClientRect();
      const code = sourceCode.getBoundingClientRect();
      return {
        virtualized: currentSourceView.virtualized,
        line: Number(hit.closest('.source-line').dataset.line),
        text: hit.textContent,
        focused: document.activeElement.id,
        left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
        viewportLeft: Math.max(0, code.left),
        viewportRight: Math.min(innerWidth, code.left + sourceCode.clientWidth),
        viewportTop: Math.max(0, code.top),
        viewportBottom: Math.min(innerHeight, code.top + sourceCode.clientHeight),
        scrollLeft: sourceCode.scrollLeft,
        scrollTop: sourceCode.scrollTop,
        lineHeight: currentSourceView.lineHeight,
        virtualStart: currentSourceView.virtualStart,
        virtualEnd: currentSourceView.virtualEnd,
        lineRect: hit.closest('.source-line').getBoundingClientRect().toJSON(),
        shellRect: sourceCode.querySelector('.source-virtual-shell').getBoundingClientRect().toJSON(),
      };
    })()`);
    const detail = `${viewport}: ${key || 'search'} ${JSON.stringify(result)}`;
    assert.equal(result.virtualized, true, detail);
    assert.equal(result.line, expectedLine, detail);
    assert.equal(result.text, 'needle', detail);
    assert.equal(result.focused, 'source-search-input', detail);
    // Scroll offsets are rounded to CSS pixels while text bounds remain fractional.
    assert.ok(result.left >= result.viewportLeft - 1 && result.right <= result.viewportRight + 1, detail);
    assert.ok(result.top >= result.viewportTop - 1 && result.bottom <= result.viewportBottom + 1, detail);
    if (expectedLine === 250) assert.ok(result.scrollLeft > 0, detail);
  }
  console.log(`PASS ${viewport}: 500-line virtual reader reveals column-401 hits horizontally and vertically, including forward/backward navigation`);
}

async function main() {
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const url = `http://127.0.0.1:${server.address().port}/`;
    for (const [width, height] of [[1280, 900], [390, 844]]) {
      const viewport = `${width}x${height}`;
      await browser('open', url);
      await browser('set', 'viewport', String(width), String(height));
      await browser('wait', '--fn', 'window.readerReady === true');
      assert.deepEqual(await evaluate('({width: innerWidth, height: innerHeight})'), { width, height });
      await checkHorizontalSearch(viewport);
      assert.deepEqual(await evaluate('readerErrors'), [], `${viewport}: browser runtime errors`);
      await browser('open', url);
      await browser('wait', '--fn', 'window.readerReady === true');
      await checkPlainSearch(viewport);
      assert.deepEqual(await evaluate('readerErrors'), [], `${viewport}: plain reader runtime errors`);
    }
  } finally {
    try {
      await browser('close');
    } finally {
      if (server.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
