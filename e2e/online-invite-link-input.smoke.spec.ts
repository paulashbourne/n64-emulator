import { expect, test } from '@playwright/test';

test('join invite input accepts raw codes and full invite links', async ({ page }) => {
  await page.goto('/online');

  const inviteInput = page.getByLabel('Invite Code');
  await inviteInput.fill('https://example.com/online?code=aB12cD');
  await expect(inviteInput).toHaveValue('AB12CD');
  await expect(page.getByRole('button', { name: 'Join by Invite Code' })).toBeEnabled();

  await inviteInput.fill('https://example.com/online/session/z9x8c7');
  await expect(inviteInput).toHaveValue('Z9X8C7');

  await inviteInput.fill('A1');
  await expect(page.getByRole('button', { name: 'Join by Invite Code' })).toBeDisabled();
});
