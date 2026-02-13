import { expect, test } from '@playwright/test';

test('guest quick relay presets update playback profile and survive reload', async ({ page, browser }) => {
  await page.goto('/online');
  await page.getByLabel('Host Name').fill('RelayModeHost');
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
  await guestPage.getByLabel('Your Name').fill('RelayModeGuest');
  await guestPage.getByLabel('Invite Code').fill(inviteCode);
  await guestPage.getByRole('button', { name: 'Join by Invite Code' }).click();
  await expect(guestPage.getByText('You are Player 2')).toBeVisible({ timeout: 15_000 });
  const enableAdvancedTools = guestPage.getByRole('button', { name: 'Enable Advanced Tools' });
  if (await enableAdvancedTools.count()) {
    await enableAdvancedTools.click();
  }

  await guestPage.keyboard.press('Shift+KeyB');
  await expect(
    guestPage.getByText(/Balanced play mode enabled\.|Balanced play mode configured locally\./),
  ).toBeVisible({ timeout: 10_000 });
  await expect(guestPage.getByText(/Input relay: Balanced|Relay Balanced/)).toBeVisible({ timeout: 10_000 });

  await guestPage.keyboard.press('Shift+KeyA');
  await expect(guestPage.getByText(/Smart auto mode synced with host stream suggestion\.|Smart auto mode enabled\./)).toBeVisible({
    timeout: 10_000,
  });
  await expect(guestPage.getByText(/Input relay:/)).toBeVisible({ timeout: 10_000 });

  await guestPage.reload();
  await expect(guestPage.getByText('You are Player 2')).toBeVisible({ timeout: 15_000 });
  await expect(guestPage.getByText(/Input relay:/)).toBeVisible({ timeout: 10_000 });

  await guestContext.close();
});
