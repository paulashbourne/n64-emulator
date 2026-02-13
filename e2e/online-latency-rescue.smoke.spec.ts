import { expect, test } from '@playwright/test';

test('guest latency rescue toggles low-latency profile and focused layout', async ({ page, browser }) => {
  await page.goto('/online');
  await page.getByLabel('Host Name').fill('RescueHost');
  await page.getByRole('button', { name: 'Start Online Game' }).click();

  const heading = page.getByRole('heading', { name: /Online Session/ });
  await expect(heading).toBeVisible({ timeout: 15_000 });
  const headingText = (await heading.textContent()) ?? '';
  const inviteCodeMatch = headingText.match(/Online Session ([A-Z0-9]{6})/);
  expect(inviteCodeMatch).toBeTruthy();
  const inviteCode = inviteCodeMatch![1];

  const guestContext = await browser.newContext();
  const guestPage = await guestContext.newPage();
  await guestPage.goto('/online');
  await guestPage.getByLabel('Your Name').fill('RescueGuest');
  await guestPage.getByLabel('Invite Code').fill(inviteCode);
  await guestPage.getByRole('button', { name: 'Join by Invite Code' }).click();
  await expect(guestPage.getByText('You are Player 2')).toBeVisible({ timeout: 15_000 });

  await guestPage.getByRole('button', { name: 'Latency Rescue' }).click();
  await expect(guestPage.getByText('Latency rescue engaged:')).toBeVisible({ timeout: 10_000 });
  await expect(guestPage.getByRole('button', { name: 'Disable Focus Mode' })).toBeVisible();
  await expect(guestPage.getByRole('button', { name: 'Show Input Deck' })).toBeVisible();

  await guestPage.getByRole('button', { name: 'Show Input Deck' }).click();
  await expect(guestPage.getByLabel('Input relay mode')).toHaveValue('responsive');
  await expect(guestPage.getByLabel('Auto-request host stream mode when network degrades')).toBeChecked();

  await guestContext.close();
});
