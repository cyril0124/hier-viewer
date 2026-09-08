import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const binary = resolve(process.argv[2] ?? 'target/debug/hier-viewer');
await mkdir('target', { recursive: true });
const workspace = await mkdtemp(resolve('target/coverage-vdb-'));
const children = [];
try {
  const tools = join(workspace, 'tools');
  const input = join(workspace, 'input.vdb');
  const output = join(workspace, 'viewer bundle');
  await mkdir(tools);
  await mkdir(input);
  await writeFile(join(input, 'data'), 'initial VDB contents');
  const rtl = join(workspace, 'design.sv');
  await writeFile(rtl, 'module Child; wire value; endmodule\nmodule Top; Child u_child(); endmodule\n');
  await writeFile(join(workspace, 'report.xml'), '<session version="1.1" release="test"><old_coverage><scope type="instance" name="tb"><scope type="instance" name="dut"><metric name="Line" value="1/2" excl="0"/><scope type="instance" name="u_child"><metric name="Line" value="1/2" excl="0"/></scope></scope></scope></old_coverage></session>');
  await writeFile(join(tools, 'urg'), `#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const args = process.argv.slice(2);
const base = dirname(args[args.indexOf('-dir') + 1]);
const report = args[args.indexOf('-report') + 1];
appendFileSync(join(base, 'calls'), 'x');
if (existsSync(join(base, 'fail'))) process.exit(1);
writeFileSync(join(base, 'started'), String(process.pid));
setTimeout(() => {
  mkdirSync(report, {recursive:true});
  writeFileSync(join(report, 'session.xml'), readFileSync(join(base, 'report.xml')));
}, existsSync(join(base, 'slow')) ? 60000 : 0);
`, { mode: 0o700 });
  const env = { ...process.env, PATH: tools + ':' + process.env.PATH };
  const common = [rtl, '--no-wizard', '--output', output, '--coverage-vdb', input];
  const args = extras => [...common, ...extras, '--', '--top', 'Top'];
  const run = extras => execute(binary, args(extras), { env, timeout: 60_000 });
  const calls = async () => (await readFile(join(workspace, 'calls'))).length;

  assert.match((await run([])).stderr, /VDB cache miss/);
  assert.equal(await calls(), 1);
  assert.match((await run([])).stderr, /VDB cache hit/);
  await run(['--coverage-root', 'tb.dut']);
  assert.equal(await calls(), 1, 'Mapping changes do not rerun URG');
  await writeFile(join(input, 'data'), 'updated and longer VDB contents');
  await run([]);
  assert.equal(await calls(), 2);
  await run(['--rebuild-coverage']);
  assert.equal(await calls(), 3);

  const cache = join(output, '.hier-viewer-cache/coverage');
  const [key] = await readdir(cache);
  const pointerPath = join(cache, key, 'current.json');
  const pointer = await readFile(pointerPath);
  await writeFile(join(workspace, 'fail'), '');
  await assert.rejects(run(['--rebuild-coverage']), /URG exited/);
  assert.deepEqual(await readFile(pointerPath), pointer);
  await rm(join(workspace, 'fail'));
  await run([]);
  assert.equal(await calls(), 4, 'A failed forced conversion leaves the old cache usable');

  function launch(extras) {
    const child = spawn(binary, args(extras), { env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    const exited = new Promise(resolveExit => child.once('exit', (code, signal) => resolveExit({ code, signal })));
    return { child, exited };
  }
  async function finish(exited) {
    let timer;
    try {
      return await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('CLI did not stop after cancellation')), 5000); })]);
    } finally { clearTimeout(timer); }
  }

  const preview = launch(['--preview', '--preview-port', '18972']);
  await new Promise((ready, reject) => {
    const timer = setTimeout(() => reject(new Error('Preview did not start')), 15000);
    let log = '';
    for (const stream of [preview.child.stdout, preview.child.stderr]) stream.on('data', chunk => {
      log += chunk;
      if (log.includes('on 127.0.0.1:')) { clearTimeout(timer); ready(); }
    });
    preview.exited.then(() => { clearTimeout(timer); reject(new Error('Preview exited before readiness: ' + log)); });
  });
  preview.child.kill('SIGINT');
  assert.equal((await finish(preview.exited)).code, 0, 'Conversion and preview share the Ctrl-C handler');
  assert.equal(await calls(), 4);

  await rm(join(workspace, 'started'));
  await writeFile(join(workspace, 'slow'), '');
  let watcher;
  let timer;
  const started = new Promise((ready, reject) => {
    timer = setTimeout(() => reject(new Error('URG did not start')), 15000);
    watcher = watch(workspace, (_event, filename) => { if (filename === 'started') ready(); });
  });
  const cancelled = launch(['--rebuild-coverage']);
  try { await started; } finally { watcher.close(); clearTimeout(timer); }
  const urgPid = Number(await readFile(join(workspace, 'started'), 'utf8'));
  cancelled.child.kill('SIGINT');
  assert.notEqual((await finish(cancelled.exited)).code, 0);
  assert.throws(() => process.kill(urgPid, 0), { code: 'ESRCH' });
  assert.deepEqual(await readFile(pointerPath), pointer, 'Cancellation never publishes a partial report');
  await access(join(output, 'index.html'));
  console.log('CLI VDB cache passed: reuse, input changes, forced rebuild, failed rebuild, preview and conversion cancellation.');
} finally {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }
  await rm(workspace, { recursive: true, force: true });
}
