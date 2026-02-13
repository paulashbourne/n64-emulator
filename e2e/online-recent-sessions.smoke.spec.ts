import { expect, test } from '@playwright/test';

test('recent sessions appear after creating a host session and can be reopened', async ({ page }) => {
  await page.goto('/online');
  await page.getByLabel('Host Name').fill('HostUser');
  await page.getByRole('button', { name: 'Start Online Game' }).click();

  const heading = page.getByRole('heading', { name: /Online Session/ });
  await expect(heading).toBeVisible({ timeout: 15_000 });

  const headingText = (await heading.textContent()) ?? '';
  const inviteCodeMatch = headingText.match(/Online Session ([A-Z0-9]{6})/);
  expect(inviteCodeMatch).toBeTruthy();
  const inviteCode = inviteCodeMatch![1];

  await page.getByRole('link', { name: 'Back to Online' }).click();
  await expect(page.getByRole('heading', { name: 'Recent Sessions' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(inviteCode)).toBeVisible({ timeout: 15_000 });

  await page
    .locator('.recent-session-list li')
    .filter({ hasText: inviteCode })
    .getByRole('button', { name: 'Reopen' })
    .click();

  await expect(page.getByRole('heading', { name: `Online Session ${inviteCode}` })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('You are Player 1 (Host)')).toBeVisible({ timeout: 15_000 });
});
