import { expect, test } from '@playwright/test';

test('controller wizard keyboard preset can be applied and saved', async ({ page }) => {
  const romPath = process.env.E2E_ROM_PATH;
  test.skip(!romPath, 'Set E2E_ROM_PATH to a local ROM file path to run this smoke test.');

  await page.goto('/');
  await page.setInputFiles('input[type="file"]', romPath!);

  await page.getByRole('link', { name: 'Play' }).first().click();
  await expect(page.getByText('Status: running')).toBeVisible({ timeout: 90_000 });

  await page.getByRole('button', { name: 'Map Controller' }).click();
  await expect(page.getByRole('heading', { name: 'Controller Mapping Wizard' })).toBeVisible();

  await page.getByRole('button', { name: 'Use Keyboard Preset' }).click();
  await expect(page.getByRole('heading', { name: 'All controls reviewed' })).toBeVisible({ timeout: 15_000 });

  const profileName = `Preset ${Date.now()}`;
  await page.getByLabel('Profile Name').fill(profileName);
  await page.getByRole('button', { name: 'Save Profile' }).click();

  await expect(page.getByText(`Input profile: ${profileName}`)).toBeVisible({ timeout: 15_000 });
});
