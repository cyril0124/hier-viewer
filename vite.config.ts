import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

const html = fileURLToPath(new URL('./rust-hier-viewer/src/html/', import.meta.url));

export default defineConfig(({ mode }) => {
  if (!['app', 'chart', 'coverage'].includes(mode)) {
    throw new Error('Select the app, chart, or coverage build mode.');
  }
  const chart = mode === 'chart';
  const coverage = mode === 'coverage';
  const entry = coverage ? 'coverage-import' : chart ? 'chart' : 'main';
  const output = coverage ? 'coverage' : chart ? 'chart' : 'app';
  const licenses = coverage ? `/*!\nparse5\n${readFileSync(new URL('./node_modules/parse5/LICENSE', import.meta.url), 'utf8')}\nentities\n${readFileSync(new URL('./node_modules/entities/LICENSE', import.meta.url), 'utf8')}\n*/` : undefined;
  return {
    plugins: coverage ? [{
      name: 'coverage-license-notices',
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
        entry: `${html}/frontend/${entry}.ts`,
        name: coverage ? 'HierarchyCoverage' : chart ? 'HierarchyCharts' : 'HierarchyViewer',
        formats: ['iife'],
        fileName: () => `viewer-${output}.js`,
      },
    },
  };
});
