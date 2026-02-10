import { expect, test } from '@playwright/test';

test('controller wizard can save and reload a ROM profile', async ({ page }) => {
  const romPath = process.env.E2E_ROM_PATH;
  test.skip(!romPath, 'Set E2E_ROM_PATH to a local ROM file path to run this smoke test.');

  await page.goto('/');
  await page.setInputFiles('input[type="file"]', romPath!);

  const firstRom = page.locator('.rom-row').first();
  await expect(firstRom).toBeVisible({ timeout: 30_000 });

  const romTitle = (await firstRom.locator('h3').textContent())?.trim();
  expect(romTitle).toBeTruthy();

  await firstRom.getByRole('link', { name: 'Play' }).click();
  await expect(page.getByText('Status: running')).toBeVisible({ timeout: 90_000 });

  await page.getByRole('button', { name: 'Map Controller' }).click();
  await expect(page.getByRole('heading', { name: 'Controller Mapping Wizard' })).toBeVisible();

  for (let i = 0; i < 24; i += 1) {
    if (await page.getByRole('heading', { name: 'All controls reviewed' }).isVisible()) {
      break;
    }
    await page.getByRole('button', { name: 'Skip' }).click();
  }

  await expect(page.getByRole('heading', { name: 'All controls reviewed' })).toBeVisible();

  const profileName = `E2E Wizard ${Date.now()}`;
  await page.getByLabel('Profile Name').fill(profileName);
  await page.getByRole('button', { name: 'Save Profile' }).click();

  await expect(page.getByText(`Input profile: ${profileName}`)).toBeVisible({ timeout: 15_000 });

  await page.getByRole('button', { name: 'Back to Library' }).click();
  await expect(page.getByRole('heading', { name: 'N64 ROM Library' })).toBeVisible();

  if (romTitle) {
    await page.getByLabel('Search').fill(romTitle);
  }
  await page.getByRole('link', { name: 'Play' }).first().click();

  await expect(page.getByText('Status: running')).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText(`Input profile: ${profileName}`)).toBeVisible({ timeout: 15_000 });
});
