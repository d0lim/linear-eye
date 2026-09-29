import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  base: '/app/',
  build: { outDir: '../dist/client', emptyOutDir: true },
  server: { proxy: { '/api': 'http://localhost:8787' } },
});
