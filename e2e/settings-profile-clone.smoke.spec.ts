import { expect, test } from '@playwright/test';

test('settings can clone active profile into a new profile without remapping', async ({ page }) => {
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Controller Profiles' })).toBeVisible({ timeout: 15_000 });

  await page.getByRole('button', { name: 'Clone Active' }).click();
  await expect(page.getByRole('heading', { name: 'Controller Mapping Wizard' })).toBeVisible();

  await page.getByLabel('Profile Name').fill('Keyboard Clone Smoke');
  await page.getByRole('button', { name: 'Save Profile' }).click();

  await expect(page.getByText('Saved controller profile "Keyboard Clone Smoke".')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.profile-list li').filter({ hasText: 'Keyboard Clone Smoke' })).toBeVisible();
  await expect(page.locator('.profile-list li').filter({ hasText: 'Keyboard Default' })).toBeVisible();
});
