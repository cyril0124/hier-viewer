import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const generated = join(root, 'rust-hier-viewer/src/html/generated');
const expectedFiles = ['viewer-app.js', 'viewer-chart.js'];
const temporary = await mkdtemp(join(tmpdir(), 'hier-viewer-assets-'));
try {
  for (const mode of ['app', 'chart']) {
    await build({ root, configFile: join(root, 'vite.config.ts'), mode,
      build: { outDir: temporary },
    });
  }
  assert.deepEqual((await readdir(temporary)).sort(), expectedFiles, 'Unexpected build assets');
  assert.deepEqual((await readdir(generated)).sort(), expectedFiles, 'Unexpected generated files');
  for (const name of expectedFiles) {
    const actual = await readFile(join(generated, name));
    const rebuilt = await readFile(join(temporary, name));
    assert.ok(actual.equals(rebuilt), `${name} is stale. Run npm run build.`);
  }
  console.log('Generated frontend assets match the source.');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
