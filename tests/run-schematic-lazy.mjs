import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { chromium } from 'playwright';

const execute = promisify(execFile);
const binary = resolve(process.argv[2] || 'target/debug/hier-viewer');
const root = await mkdtemp(join(tmpdir(), 'hier-viewer-lazy-test-'));
const rtl = join(root, 'design.sv');
const bundle = join(root, 'lazy');
const eager = join(root, 'static');
const dbBundle = join(root, 'db');
const source = await readFile('cpp-hier-exporter/tests/semantic_schematic.sv', 'utf8');
await writeFile(rtl, source);
let preview;
let browser;

async function startServer(directory) {
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  // The user's remote-preview configuration must support scoped builds too.
  const child = spawn(binary, ['serve', directory, '--host', '0.0.0.0', '--port', String(port)], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server startup timed out: ${logs}`)), 30_000);
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${logs}`)); });
    function collect(chunk) {
      logs += chunk;
      const match = logs.match(/Serving .* on .*:(\d+) at /);
      if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}/`); }
    }
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
  });
  try { return { child, url: await ready, logs: () => logs }; }
  catch (error) { child.kill('SIGINT'); throw error; }
}

async function stopServer() {
  if (!preview) return;
  const { child } = preview;
  preview = null;
  if (child.exitCode !== null) return;
  const exit = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGINT');
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  await exit;
  clearTimeout(timer);
}

async function generate(output, extra = []) {
  await execute(binary, [rtl, '--no-wizard', '--output', output, ...extra, '--', '--top', 'semantic_top'], { timeout: 90_000 });
}

async function cacheFiles(directory) {
  const cache = join(directory, '.hier-viewer-cache', 'schematic-lazy');
  const versions = await readdir(cache).catch(() => []);
  const files = [];
  for (const version of versions) {
    for (const file of await readdir(join(cache, version))) {
      if (/^\d+\.json$/.test(file)) files.push(join(cache, version, file));
    }
  }
  return files;
}

async function readyScope(url, id) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${url}api/schematic/scopes/${id}`, { method: 'POST', headers: { 'X-Hier-Schematic': '1' } });
    const body = await response.json();
    if (response.status === 200) return body;
    assert.equal(response.status, 202, JSON.stringify(body));
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Scope build timed out');
}

try {
  await generate(bundle);
  const meta = JSON.parse(await readFile(join(bundle, 'viewer-meta.json'), 'utf8'));
  assert.equal(meta.schematic.mode, 'lazy');
  assert.equal((await cacheFiles(bundle)).length, 0);
  const recipe = JSON.parse(await readFile(join(bundle, '.hier-viewer-cache/schematic-recipe.json'), 'utf8'));
  const rootId = recipe.scopes.findIndex(scope => scope.path === 'semantic_top');
  const childId = recipe.scopes.findIndex(scope => scope.path === 'semantic_top.first');
  const tables = await execute('python3', ['-c', 'import sqlite3,sys; c=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True); print(c.execute("select count(*) from sqlite_master where name like \'schematic_%\'").fetchone()[0])', recipe.database]);
  assert.equal(tables.stdout.trim(), '0', 'Default export has no schematic tables');
  preview = await startServer(bundle);
  assert.equal((await fetch(`${preview.url}.hier-viewer-cache/schematic-recipe.json`)).status, 403);
  assert.equal((await fetch(`${preview.url}api/schematic/scopes/${rootId}`, { method: 'POST' })).status, 403);
  assert.equal((await fetch(`${preview.url}api/schematic/scopes/${rootId}`, { method: 'POST', headers: { 'X-Hier-Schematic': '1', Origin: 'http://elsewhere.invalid' } })).status, 403);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  const requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => requests.push(request.url()));
  await page.goto(preview.url);
  await page.locator('#loading-overlay').waitFor({ state: 'hidden' });
  assert(!requests.some(url => url.includes('/api/schematic/')), 'Treemap never triggers schematic generation');
  await page.locator('#view-schematic-btn').click();
  await page.waitForFunction(() => {
    const view = window.hierarchySchematic?.inspect();
    return view?.scene && !view.loading && view.scopePath === 'semantic_top';
  }, null, { timeout: 60_000 });
  assert.equal((await cacheFiles(bundle)).length, 1, 'Only selected scope is cached');
  await page.locator('[data-node-id="semantic_top.first"]').dblclick();
  await page.waitForFunction(() => {
    const view = window.hierarchySchematic?.inspect();
    return view?.scene && !view.loading && view.scopePath === 'semantic_top.first';
  }, null, { timeout: 60_000 });
  assert.equal((await cacheFiles(bundle)).length, 2, 'Child scope generated on navigation');
  assert.equal((preview.logs().match(/Slang worker ready/g) || []).length, 1, 'Both uncached scopes reuse one Slang compilation');
  assert.deepEqual(errors, []);
  await browser.close(); browser = null;
  const workerMatch = preview.logs().match(/Slang worker ready[^\n]*\(pid (\d+)\)/);
  assert(workerMatch, 'Persistent worker PID is reported');
  process.kill(Number(workerMatch[1]), 'SIGKILL');
  const retryId = recipe.scopes.findIndex((scope, id) => scope.electrical && id !== rootId && id !== childId);
  assert(retryId >= 0);
  let failed = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await fetch(`${preview.url}api/schematic/scopes/${retryId}`, { method: 'POST', headers: { 'X-Hier-Schematic': '1' } });
    if (response.status === 422) { failed = true; break; }
    assert.equal(response.status, 202);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(failed, 'A dead compiler reports a build error');
  await readyScope(preview.url, retryId);
  assert.equal((preview.logs().match(/Slang worker ready/g) || []).length, 2, 'Explicit retry starts a new compiler');
  const files = await cacheFiles(bundle);
  const stamps = await Promise.all(files.map(async file => [file, (await stat(file)).mtimeMs]));
  await stopServer();
  preview = await startServer(bundle);
  const cached = await fetch(`${preview.url}api/schematic/scopes/${rootId}`, { method: 'POST', headers: { 'X-Hier-Schematic': '1' } });
  assert.equal(cached.status, 200, 'Cache reused immediately after serve restart in another cwd');
  assert(!preview.logs().includes('Slang worker ready'), 'Disk cache hits do not start an elaborator');
  for (const [file, stamp] of stamps) assert.equal((await stat(file)).mtimeMs, stamp);
  const lazyRoot = await (await fetch(`${preview.url}api/schematic/scopes/${rootId}`)).json();
  await writeFile(rtl, `${source}\n// changed dependency\n`);
  assert.equal((await fetch(`${preview.url}api/schematic/scopes/${rootId}`, { method: 'POST', headers: { 'X-Hier-Schematic': '1' } })).status, 409);
  assert.equal((await fetch(`${preview.url}api/schematic/scopes/${rootId}`)).status, 409);
  await stopServer();
  await writeFile(rtl, source);
  await generate(eager, ['--schematic']);
  const eagerMeta = JSON.parse(await readFile(join(eager, 'viewer-meta.json'), 'utf8'));
  assert.notEqual(eagerMeta.schematic.mode, 'lazy');
  assert.deepEqual(JSON.parse(await readFile(join(eager, 'schematic', `${rootId}.json`), 'utf8')), lazyRoot, 'Scoped RTL export equals full static export');
  const db = (await readdir(join(eager, '.hier-viewer-cache'))).find(file => file.endsWith('.sqlite'));
  await execute(binary, ['--db', join(eager, '.hier-viewer-cache', db), '--output', dbBundle], { timeout: 60_000 });
  assert.equal((await cacheFiles(dbBundle)).length, 0);
  preview = await startServer(dbBundle);
  await readyScope(preview.url, childId);
  const fromDb = await (await fetch(`${preview.url}api/schematic/scopes/${childId}`)).json();
  assert.deepEqual(fromDb, JSON.parse(await readFile(join(eager, 'schematic', `${childId}.json`), 'utf8')));
  assert.equal((await cacheFiles(dbBundle)).length, 1, '--db extracts just the requested scope');
  assert(!preview.logs().includes('Slang worker ready'), '--db extraction never starts Slang');
  console.log('PASS lazy Schematic: default skips tables, one compiler serves root/child, crash retry restarts compiler, remote preview, cache restart without compiler, source invalidation, static parity, scoped --db, private recipe and origin checks.');
} finally {
  if (browser) await browser.close();
  await stopServer();
  await rm(root, { recursive: true, force: true });
}
