import { expect, test } from '@playwright/test';

test('settings can import a controller profile JSON and activate it', async ({ page }) => {
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Controller Profiles' })).toBeVisible({ timeout: 15_000 });

  const profilePayload = {
    version: 1,
    profile: {
      profileId: 'profile:import-smoke',
      name: 'Import Smoke',
      deviceId: 'keyboard-import',
      deadzone: 0.22,
      bindings: {
        a: {
          source: 'keyboard',
          code: 'KeyX',
        },
        b: {
          source: 'keyboard',
          code: 'KeyC',
        },
      },
      updatedAt: Date.now(),
    },
  };

  await page.locator('input[type="file"]').setInputFiles({
    name: 'profile-import.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(profilePayload)),
  });

  await expect(page.getByText('Imported 1 profile.')).toBeVisible({ timeout: 10_000 });
  const importedRow = page.locator('.profile-list li').filter({ hasText: 'Import Smoke' });
  await expect(importedRow).toBeVisible({ timeout: 10_000 });
  await importedRow.getByRole('button', { name: 'Active' }).waitFor({ timeout: 10_000 });
});
