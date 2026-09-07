import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const html = fileURLToPath(new URL('./rust-hier-viewer/src/html/', import.meta.url));

export default defineConfig(({ mode }) => {
  if (mode !== 'app' && mode !== 'chart') {
    throw new Error('Select the app or chart build with --mode.');
  }
  const chart = mode === 'chart';
  return {
    publicDir: false,
    build: {
      target: 'es2022',
      outDir: `${html}/generated`,
      emptyOutDir: false,
      minify: true,
      sourcemap: false,
      lib: {
        entry: `${html}/frontend/${chart ? 'chart' : 'main'}.ts`,
        name: chart ? 'HierarchyCharts' : 'HierarchyViewer',
        formats: ['iife'],
        fileName: () => chart ? 'viewer-chart.js' : 'viewer-app.js',
      },
    },
  };
});
