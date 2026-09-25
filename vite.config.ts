import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  optimizeDeps: { exclude: ['@thorvg/webcanvas'] },
  build: { target: 'es2022' },
});
