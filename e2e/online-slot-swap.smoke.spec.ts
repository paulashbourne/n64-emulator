import { expect, test } from '@playwright/test';

test('host can swap two guests between occupied slots', async ({ page, browser }) => {
  await page.goto('/online');
  await page.getByLabel('Host Name').fill('SwapHost');
  await page.getByRole('button', { name: 'Start Online Game' }).click();

  const heading = page.getByRole('heading', { name: /Online Session/ });
  await expect(heading).toBeVisible({ timeout: 15_000 });
  const headingText = (await heading.textContent()) ?? '';
  const inviteCodeMatch = headingText.match(/Online Session ([A-Z0-9]{6})/);
  expect(inviteCodeMatch).toBeTruthy();
  const inviteCode = inviteCodeMatch![1];

  const guestContextA = await browser.newContext();
  const guestPageA = await guestContextA.newPage();
  await guestPageA.goto('/online');
  await guestPageA.getByLabel('Your Name').fill('SwapGuestA');
  await guestPageA.getByLabel('Invite Code').fill(inviteCode);
  await guestPageA.getByRole('button', { name: 'Join by Invite Code' }).click();
  await expect(guestPageA.getByText('You are Player 2')).toBeVisible({ timeout: 15_000 });

  const guestContextB = await browser.newContext();
  const guestPageB = await guestContextB.newPage();
  await guestPageB.goto('/online');
  await guestPageB.getByLabel('Your Name').fill('SwapGuestB');
  await guestPageB.getByLabel('Invite Code').fill(inviteCode);
  await guestPageB.getByRole('button', { name: 'Join by Invite Code' }).click();
  await expect(guestPageB.getByText('You are Player 3')).toBeVisible({ timeout: 15_000 });

  const guestRow = page
    .locator('.room-player-list li')
    .filter({ hasText: 'SwapGuestA' });
  await expect(guestRow).toBeVisible({ timeout: 15_000 });
  await guestRow.getByRole('button', { name: 'Swap P3' }).click();

  await expect(guestPageA.getByText('You are Player 3')).toBeVisible({ timeout: 15_000 });
  await expect(guestPageB.getByText('You are Player 2')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Player 2: SwapGuestB')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Player 3: SwapGuestA')).toBeVisible({ timeout: 15_000 });

  await guestContextA.close();
  await guestContextB.close();
});
