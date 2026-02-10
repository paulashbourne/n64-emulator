import { expect, test } from '@playwright/test';

test('play screen keyboard shortcuts work', async ({ page }) => {
  const romPath = process.env.E2E_ROM_PATH;
  test.skip(!romPath, 'Set E2E_ROM_PATH to a local ROM file path to run this smoke test.');

  await page.goto('/');
  await page.setInputFiles('input[type="file"]', romPath!);
  await page.getByRole('link', { name: 'Play' }).first().click();

  await expect(page.getByText('Status: running')).toBeVisible({ timeout: 90_000 });

  await page.keyboard.press('Space');
  await expect(page.getByText('Status: paused')).toBeVisible({ timeout: 15_000 });

  await page.keyboard.press('Space');
  await expect(page.getByText('Status: running')).toBeVisible({ timeout: 15_000 });

  await page.keyboard.press('KeyM');
  await expect(page.getByRole('heading', { name: 'Controller Mapping Wizard' })).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: 'Controller Mapping Wizard' })).toHaveCount(0);
});
