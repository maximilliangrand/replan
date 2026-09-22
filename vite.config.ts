import { defineConfig } from 'vite';
export default defineConfig({
  root: 'web',
  build: { outDir: '../dist', emptyOutDir: true },
  server: {
    host: '127.0.0.1',
    port: 4317,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:4310' },
  },
});
