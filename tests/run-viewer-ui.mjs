import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { preview } from 'vite';

const execute = promisify(execFile);
const binary = resolve(process.argv[2] ?? 'target/debug/hier-viewer');
const output = resolve('target/frontend-ui');
const bundle = resolve(output, 'bundle');
const fixture = resolve('cpp-hier-exporter/tests/parameterized_cache.sv');
await mkdir(output, { recursive: true });
const exported = await execute(binary, [fixture, '--no-wizard', '--output', bundle, '--', '--top', 'top'], {
  timeout: 60_000,
});
process.stdout.write(exported.stdout);
process.stderr.write(exported.stderr);
const server = await preview({
  configFile: false,
  root: output,
  build: { outDir: bundle },
  preview: { host: '127.0.0.1', port: 0, open: false },
});
try {
  const url = server.resolvedUrls.local[0];
  const result = await execute(process.execPath, [
    'tests/viewer-ui.browser.cjs', url, resolve(output, 'screenshots'),
  ]);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
} finally {
  await server.close();
}
