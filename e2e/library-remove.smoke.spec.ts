import { expect, test } from '@playwright/test';

test('removes a rom from the catalog', async ({ page }) => {
  const romPath = process.env.E2E_ROM_PATH;
  test.skip(!romPath, 'Set E2E_ROM_PATH to a local ROM file path to run this smoke test.');

  page.on('dialog', async (dialog) => {
    await dialog.accept();
  });

  await page.goto('/');
  await page.setInputFiles('input[type="file"]', romPath!);

  const firstRom = page.locator('.rom-row').first();
  await expect(firstRom).toBeVisible({ timeout: 30_000 });
  const romTitle = (await firstRom.locator('h3').textContent())?.trim() ?? 'ROM';

  await firstRom.getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByText(`Removed "${romTitle}" from the catalog.`)).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.rom-row')).toHaveCount(0);
});
