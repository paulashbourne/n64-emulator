import { expect, test } from '@playwright/test';

test('host can mute and unmute guest input directly from online session lobby', async ({ page, browser }) => {
  await page.goto('/online');
  await page.getByLabel('Host Name').fill('LobbyMuteHost');
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
  await guestPage.getByLabel('Your Name').fill('LobbyMuteGuest');
  await guestPage.getByLabel('Invite Code').fill(inviteCode);
  await guestPage.getByRole('button', { name: 'Join by Invite Code' }).click();
  await expect(guestPage.getByText('You are Player 2')).toBeVisible({ timeout: 15_000 });

  const guestRow = page
    .locator('.room-player-list li')
    .filter({ hasText: 'LobbyMuteGuest' });
  await expect(guestRow).toBeVisible({ timeout: 15_000 });

  await guestRow.getByRole('button', { name: 'Mute Input' }).click();
  await expect(guestPage.getByText('Your controller input is currently muted by the host.')).toBeVisible({
    timeout: 10_000,
  });
  await expect(guestRow).toContainText('input muted');

  await guestRow.getByRole('button', { name: 'Unmute Input' }).click();
  await expect(guestPage.getByText('Your controller input is currently muted by the host.')).toHaveCount(0);
  await expect(guestRow).not.toContainText('input muted');

  await guestContext.close();
});
