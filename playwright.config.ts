import { defineConfig } from '@playwright/test';

const fixedBaseUrl = process.env.E2E_BASE_URL;
const baseUrl = fixedBaseUrl ?? 'http://127.0.0.1:5173';

export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: baseUrl,
    headless: true,
    launchOptions: {
      args: ['--use-angle=swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'],
    },
  },
  webServer: fixedBaseUrl
    ? undefined
    : {
        command: 'npm run dev -- --host 127.0.0.1 --port 5173 --strictPort',
        url: baseUrl,
        reuseExistingServer: true,
        timeout: 120_000,
      },
});
