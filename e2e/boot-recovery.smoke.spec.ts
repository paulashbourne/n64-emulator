import { expect, test } from '@playwright/test';

test('shows recovery controls after boot failure and can recover on retry', async ({ page }) => {
  const romPath = process.env.E2E_ROM_PATH;
  test.skip(!romPath, 'Set E2E_ROM_PATH to a local ROM file path to run this smoke test.');

  const localLoaderPattern = '**/emulatorjs/data/loader.js';
  const cdnLoaderPattern = 'https://cdn.emulatorjs.org/**/loader.js';

  await page.route(localLoaderPattern, async (route) => route.abort());
  await page.route(cdnLoaderPattern, async (route) => route.abort());

  await page.goto('/');
  await page.setInputFiles('input[type="file"]', romPath!);
  await page.getByRole('link', { name: 'Play' }).first().click();

  await expect(page.getByText('Status: error')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Retry (Auto)' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry (Local Only)' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry (CDN Only)' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Clear Emulator Cache & Retry' })).toBeVisible();

  await page.unroute(localLoaderPattern);
  await page.unroute(cdnLoaderPattern);

  await page.getByRole('button', { name: 'Retry (Auto)' }).click();
  await expect(page.getByText('Status: running')).toBeVisible({ timeout: 90_000 });
});
