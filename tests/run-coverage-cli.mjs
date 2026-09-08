import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { promisify } from 'node:util';
import { preview } from 'vite';
import { chromium } from 'playwright';

const execute = promisify(execFile);
const binary = resolve(process.argv[2] ?? 'target/debug/hier-viewer');
await mkdir('target', { recursive: true });
const workspace = await mkdtemp(resolve('target/coverage-cli-'));
let server;
let browser;
try {
  const report = join(workspace, 'urg report');
  const output = join(workspace, 'bundle');
  const rtl = join(workspace, 'design.sv');
  await mkdir(report);
  await writeFile(rtl, 'module Child; wire value; endmodule\nmodule Top; Child u_child(); endmodule\n');
  const designScope = '<scope type="instance" name="u_dut"><metric name="Line" value="1/2" excl="0"/><scope type="instance" name="u_child"><metric name="Line" value="1/2" excl="0"/></scope></scope>';
  const session = scopes => `<session version="1.1" release="test"><old_coverage><scope type="instance" name="tb_top">${scopes}</scope></old_coverage></session>`;
  const xml = session(designScope);
  await writeFile(join(report, 'session.xml'), xml);
  await writeFile(join(report, 'extra page.html'), '<p>Report text</p>');
  const common = [rtl, '--no-wizard', '--output', output];
  async function generateCoverage(root) {
    const rootArgs = root === undefined ? [] : ['--coverage-root', root];
    await execute(binary, [...common, '--coverage-report', report, ...rootArgs, '--', '--top', 'Top'], { timeout: 60_000 });
  }
  await generateCoverage();

  const html = await readFile(join(output, 'index.html'), 'utf8');
  const manifestPath = /data-coverage-manifest="([^"]+)"/.exec(html)?.[1];
  assert.ok(manifestPath, 'Generated HTML must enable automatic coverage loading');
  const manifest = JSON.parse(await readFile(resolve(output, manifestPath), 'utf8'));
  assert.equal(Object.hasOwn(manifest, 'root'), false, 'Absent CLI root requests automatic matching');
  assert.deepEqual(manifest.files, ['extra page.html', 'session.xml']);
  assert.equal(await readFile(join(report, 'session.xml'), 'utf8'), xml);

  server = await preview({ configFile: false, root: workspace, build: { outDir: output }, preview: { host: '127.0.0.1', port: 0, open: false } });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const failures = [];
  const apiRequests = [];
  page.on('pageerror', error => failures.push(error.message));
  page.on('request', request => { if (request.url().includes('/api/coverage/')) apiRequests.push(request.url()); });
  await page.goto(server.resolvedUrls.local[0]);
  for (let load = 0; load < 2; load++) {
    if (load) await page.reload();
    await page.waitForFunction(() => !document.querySelector('#coverage-metric-select').disabled);
    assert.equal(await page.locator('#coverage-metric-select').inputValue(), 'line');
    assert.equal(await page.locator('#coverage-import-dialog').evaluate(dialog => dialog.open), false);
  }
  const ambiguous = session(designScope + designScope.replace('u_dut', 'u_second'));
  await writeFile(join(report, 'session.xml'), ambiguous);
  await generateCoverage();
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#status-right').textContent.includes('Multiple coverage roots match'));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.match(await page.locator('#status-right').textContent(), /tb_top.u_dut, tb_top.u_second.*--coverage-root/, 'Root diagnostics survive layout redraws');
  assert.equal(await page.locator('#coverage-metric-select').isDisabled(), true);

  await generateCoverage('tb_top.u_second');
  await page.reload();
  await page.waitForFunction(() => !document.querySelector('#coverage-metric-select').disabled);
  const explicitHtml = await readFile(join(output, 'index.html'), 'utf8');
  const explicitManifest = /data-coverage-manifest="([^"]+)"/.exec(explicitHtml)[1];
  assert.equal(JSON.parse(await readFile(resolve(output, explicitManifest), 'utf8')).root, 'tb_top.u_second');

  await generateCoverage('tb_top.invalid');
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#status-right').textContent.includes('root does not exist: tb_top.invalid'));
  assert.equal(await page.locator('#coverage-metric-select').isDisabled(), true, 'Invalid explicit roots must not fall back to auto matching');

  await writeFile(join(report, 'session.xml'), xml.replace('u_child', 'different_child'));
  await generateCoverage();
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#status-right').textContent.includes('No coverage root matches'));
  assert.match(await page.locator('#status-right').textContent(), /Report paths to inspect.*tb_top.u_dut/);
  assert.equal(await page.locator('#coverage-metric-select').isDisabled(), true);

  assert.deepEqual(apiRequests, [], 'Static preload must not use the local import service');
  assert.deepEqual(failures, []);

  await execute(binary, [...common, '--', '--top', 'Top'], { timeout: 60_000 });
  assert.ok(!(await readFile(join(output, 'index.html'), 'utf8')).includes('data-coverage-manifest'));
  await access(resolve(output, manifestPath));
  await assert.rejects(execute(binary, [rtl, '--output', join(report, 'blocked'), '--coverage-report', report, '--coverage-root', 'tb_top.u_dut', '--', '--top', 'Top'], { timeout: 60_000 }), /outside the input report/);
  await assert.rejects(access(join(report, 'blocked')));
  console.log('CLI preload passed: unique automatic root, ambiguity/no-match diagnostics, explicit override, static reload, regeneration, and input protection.');
} finally {
  await browser?.close();
  await server?.close();
  await rm(workspace, { recursive: true, force: true });
}
