import { expect, test } from '@playwright/test';

test('guest can enable focus mode to maximize stream area and hide secondary panels', async ({ page, browser }) => {
  await page.goto('/online');
  await page.getByLabel('Host Name').fill('FocusHost');
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
  await guestPage.getByLabel('Your Name').fill('FocusGuest');
  await guestPage.getByLabel('Invite Code').fill(inviteCode);
  await guestPage.getByRole('button', { name: 'Join by Invite Code' }).click();

  await expect(guestPage.getByText('You are Player 2')).toBeVisible({ timeout: 15_000 });
  await expect(guestPage.getByRole('heading', { name: 'Players' })).toBeVisible();
  await expect(guestPage.getByRole('heading', { name: 'Session Chat' })).toBeVisible();
  await expect(guestPage.getByRole('button', { name: 'Fullscreen' })).toBeVisible();
  await expect(guestPage.getByText('Use R for re-sync.')).toBeVisible();
  await expect(guestPage.getByLabel('Guest quick controls').getByRole('button', { name: /Enable Focus|Disable Focus/ })).toBeVisible();
  await expect(guestPage.getByLabel('Guest quick controls').getByRole('button', { name: /Show Virtual Controller|Hide Virtual Controller/ })).toBeVisible();
  await expect(guestPage.getByRole('heading', { name: 'Controller Profile' })).toBeVisible();

  await guestPage.keyboard.press('KeyF');
  await expect(guestPage.locator('.online-session-page.online-session-guest-focus')).toBeVisible();
  await expect(guestPage.getByRole('heading', { name: 'Players' })).toHaveCount(0);
  await expect(guestPage.getByRole('heading', { name: 'Session Chat' })).toHaveCount(0);
  await expect(guestPage.getByRole('heading', { name: 'Host Stream' })).toBeVisible();

  await guestPage.keyboard.press('KeyI');
  await expect(guestPage.getByRole('heading', { name: 'Controller Profile' })).toHaveCount(0);
  await expect(guestPage.getByText('Input deck is hidden for stream focus.')).toBeVisible();
  await guestPage.keyboard.press('KeyI');
  await expect(guestPage.getByRole('heading', { name: 'Controller Profile' })).toBeVisible();

  await guestPage.keyboard.press('KeyF');
  await expect(guestPage.locator('.online-session-page.online-session-guest-focus')).toHaveCount(0);
  await expect(guestPage.getByRole('heading', { name: 'Players' })).toBeVisible();
  await expect(guestPage.getByRole('heading', { name: 'Session Chat' })).toBeVisible();
  await guestPage.screenshot({ path: 'artifacts/online-pass15-guest-modes.png', fullPage: true });

  await guestContext.close();
});
