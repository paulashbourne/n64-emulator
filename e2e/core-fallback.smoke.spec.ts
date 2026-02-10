import { expect, test } from '@playwright/test';

test('falls back to mupen core when parallel core download is unavailable', async ({ page }) => {
  const romPath = process.env.E2E_ROM_PATH;
  test.skip(!romPath, 'Set E2E_ROM_PATH to a local ROM file path to run this smoke test.');

  await page.route('**/parallel_n64*.data', async (route) => route.abort());

  await page.goto('/');
  await page.setInputFiles('input[type="file"]', romPath!);
  await page.getByRole('link', { name: 'Play' }).first().click();

  await expect(page.getByText('Status: running')).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText('Core: mupen64plus_next')).toBeVisible({ timeout: 15_000 });
});
