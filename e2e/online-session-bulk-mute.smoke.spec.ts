import { expect, test } from '@playwright/test';

test('host can mute and unmute all guest input from online session lobby', async ({ page, browser }) => {
  await page.goto('/online');
  await page.getByLabel('Host Name').fill('BulkMuteHost');
  await page.getByRole('button', { name: 'Start Online Game' }).click();

  const heading = page.getByRole('heading', { name: /Online Session/ });
  await expect(heading).toBeVisible({ timeout: 15_000 });
  const headingText = (await heading.textContent()) ?? '';
  const inviteCodeMatch = headingText.match(/Online Session ([A-Z0-9]{6})/);
  expect(inviteCodeMatch).toBeTruthy();
  const inviteCode = inviteCodeMatch![1];

  const guestOneContext = await browser.newContext();
  const guestOnePage = await guestOneContext.newPage();
  await guestOnePage.goto('/online');
  await guestOnePage.getByLabel('Your Name').fill('BulkMuteGuestOne');
  await guestOnePage.getByLabel('Invite Code').fill(inviteCode);
  await guestOnePage.getByRole('button', { name: 'Join by Invite Code' }).click();
  await expect(guestOnePage.getByText('You are Player 2')).toBeVisible({ timeout: 15_000 });

  const guestTwoContext = await browser.newContext();
  const guestTwoPage = await guestTwoContext.newPage();
  await guestTwoPage.goto('/online');
  await guestTwoPage.getByLabel('Your Name').fill('BulkMuteGuestTwo');
  await guestTwoPage.getByLabel('Invite Code').fill(inviteCode);
  await guestTwoPage.getByRole('button', { name: 'Join by Invite Code' }).click();
  await expect(guestTwoPage.getByText('You are Player 3')).toBeVisible({ timeout: 15_000 });

  const bulkMuteButton = page.getByRole('button', { name: 'Mute All Guests', exact: true });
  const bulkUnmuteButton = page.getByRole('button', { name: 'Unmute All Guests', exact: true });
  const guestOneQuickAButton = guestOnePage
    .locator('.online-guest-stream-panel .online-input-grid')
    .first()
    .getByRole('button', { name: /^A$/, exact: true });
  const guestTwoQuickAButton = guestTwoPage
    .locator('.online-guest-stream-panel .online-input-grid')
    .first()
    .getByRole('button', { name: /^A$/, exact: true });

  await expect(bulkMuteButton).toBeVisible({ timeout: 15_000 });
  await bulkMuteButton.click();

  await expect(guestOnePage.getByText('Your controller input is currently muted by the host.')).toBeVisible({ timeout: 10_000 });
  await expect(guestTwoPage.getByText('Your controller input is currently muted by the host.')).toBeVisible({ timeout: 10_000 });

  await expect(guestOneQuickAButton).toBeDisabled();
  await expect(guestTwoQuickAButton).toBeDisabled();

  await bulkUnmuteButton.click();

  await expect(guestOnePage.getByText('Your controller input is currently muted by the host.')).toHaveCount(0);
  await expect(guestTwoPage.getByText('Your controller input is currently muted by the host.')).toHaveCount(0);
  await expect(guestOneQuickAButton).toBeEnabled();
  await expect(guestTwoQuickAButton).toBeEnabled();

  await guestOneContext.close();
  await guestTwoContext.close();
});
