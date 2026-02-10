import { expect, test } from '@playwright/test';

test('default boot mode preference affects play sessions', async ({ page }) => {
  const romPath = process.env.E2E_ROM_PATH;
  test.skip(!romPath, 'Set E2E_ROM_PATH to a local ROM file path to run this smoke test.');

  await page.goto('/settings');
  await page.getByLabel('Default boot mode').selectOption('cdn');
  await expect(page.getByText('Saved default boot mode: CDN cores only.')).toBeVisible({ timeout: 15_000 });

  await page.goto('/');
  await page.setInputFiles('input[type="file"]', romPath!);
  await page.getByRole('link', { name: 'Play' }).first().click();

  await expect(page.getByText('Status: running')).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText('Boot mode: CDN cores only')).toBeVisible();
  await expect(page.getByText('Renderer: EmulatorJS (CDN core path)')).toBeVisible();
});
