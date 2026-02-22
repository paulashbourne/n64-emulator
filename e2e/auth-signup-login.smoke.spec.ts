import { expect, test } from '@playwright/test';

test('user can sign up and log out', async ({ page }) => {
  const suffix = Date.now().toString(36);
  const username = `player_${suffix}`;
  const email = `${username}@example.com`;

  await page.goto('/signup');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill('secret123');
  await page.getByRole('button', { name: 'Create Account' }).click();

  await expect(page).toHaveURL(/\/online/);
  await expect(page.getByText(username)).toBeVisible({ timeout: 15_000 });

  await page.getByRole('button', { name: 'Log Out' }).click();
  await expect(page.getByRole('link', { name: 'Log In' })).toBeVisible({ timeout: 15_000 });
});
