import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

const html = fileURLToPath(new URL('./rust-hier-viewer/src/html/', import.meta.url));
const entries: Record<string, { entry: string; name: string }> = {
  app: { entry: 'main', name: 'HierarchyViewer' },
  chart: { entry: 'chart', name: 'HierarchyCharts' },
  coverage: { entry: 'coverage-import', name: 'HierarchyCoverage' },
  schematic: { entry: 'schematic', name: 'HierarchySchematic' },
  'schematic-worker': { entry: 'schematic-worker', name: 'HierarchySchematicWorker' },
};

export default defineConfig(({ mode }) => {
  const selected = entries[mode];
  if (!selected) throw new Error(`Unknown frontend build mode: ${mode}`);
  const readLicense = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
  const licenses = mode === 'schematic-worker'
    ? `/*! elkjs 0.12.0, Eclipse Public License 2.0. Source: https://github.com/kieler/elkjs/tree/0.12.0\n${readLicense('./node_modules/elkjs/LICENSE.md')}\n*/`
    : mode === 'coverage' ? `/*!\nparse5\n${readLicense('./node_modules/parse5/LICENSE')}\nentities\n${readLicense('./node_modules/entities/LICENSE')}\n*/` : undefined;
  return {
    plugins: licenses ? [{
      name: 'dependency-license-notices',
      generateBundle(_options, bundle) {
        for (const output of Object.values(bundle)) {
          if (output.type === 'chunk') output.code = `${licenses}\n${output.code}`;
        }
      },
    }] : [],
    publicDir: false,
    build: {
      target: 'es2022',
      outDir: `${html}/generated`,
      emptyOutDir: false,
      minify: true,
      sourcemap: false,
      lib: {
        entry: `${html}/frontend/${selected.entry}.ts`,
        name: selected.name,
        formats: ['iife'],
        fileName: () => `viewer-${mode}.js`,
      },
    },
  };
});
