import { configDefaults, defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api/multiplayer': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
      '/ws/multiplayer': {
        target: 'ws://127.0.0.1:8787',
        ws: true,
      },
    },
  },
  worker: {
    format: 'es',
  },
  test: {
    environment: 'happy-dom',
    globals: true,
    setupFiles: './src/test/setup.ts',
    exclude: [...configDefaults.exclude, 'e2e/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: ['src/main.tsx'],
    },
  },
});
