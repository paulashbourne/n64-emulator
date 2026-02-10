import { expect, test } from '@playwright/test';

test('imports a ROM and reaches running state', async ({ page }) => {
  const romPath = process.env.E2E_ROM_PATH;
  test.skip(!romPath, 'Set E2E_ROM_PATH to a local ROM file path to run this smoke test.');

  await page.goto('/');
  await page.setInputFiles('input[type="file"]', romPath!);

  await expect(page.getByRole('link', { name: 'Play' }).first()).toBeVisible({ timeout: 30_000 });
  await page.getByRole('link', { name: 'Play' }).first().click();

  await expect(page.getByText('Status: running')).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText('Error loading EmulatorJS runtime')).toHaveCount(0);
});
