import { expect, test } from '@playwright/test';

test('host can reassign a guest to another open player slot', async ({ page, browser }) => {
  await page.goto('/online');
  await page.getByLabel('Host Name').fill('SlotHost');
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
  await guestPage.getByLabel('Your Name').fill('SlotGuest');
  await guestPage.getByLabel('Invite Code').fill(inviteCode);
  await guestPage.getByRole('button', { name: 'Join by Invite Code' }).click();
  await expect(guestPage.getByText('You are Player 2')).toBeVisible({ timeout: 15_000 });

  const guestRow = page
    .locator('.room-player-list li')
    .filter({ hasText: 'SlotGuest' });
  await expect(guestRow).toBeVisible({ timeout: 15_000 });
  await guestRow.getByRole('button', { name: 'Move to P3' }).click();

  await expect(guestPage.getByText('You are Player 3')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Player 3: SlotGuest')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Player 2: Open slot')).toBeVisible({ timeout: 15_000 });

  await guestContext.close();
});
