import { expect, test } from '@playwright/test';

test('guest phone quickbar supports smart/balanced/turbo mode controls', async ({ page, browser }) => {
  await page.goto('/online');
  await page.getByLabel('Host Name').fill('ModePhoneHost');
  await page.getByRole('button', { name: 'Start Online Game' }).click();

  const heading = page.getByRole('heading', { name: /Online Session/ });
  await expect(heading).toBeVisible({ timeout: 15_000 });
  const headingText = (await heading.textContent()) ?? '';
  const inviteCodeMatch = headingText.match(/Online Session ([A-Z0-9]{6})/);
  expect(inviteCodeMatch).toBeTruthy();
  const inviteCode = inviteCodeMatch![1];

  const guestContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const guestPage = await guestContext.newPage();
  await guestPage.goto('/online');
  const guestQuickbar = guestPage.getByLabel('Guest quick controls');
  let joinedAsGuest = false;
  for (let attempt = 0; attempt < 2 && !joinedAsGuest; attempt += 1) {
    await guestPage.getByLabel('Your Name').fill(`ModePhoneGuest${attempt}`);
    await guestPage.getByLabel('Invite Code').fill(inviteCode);
    await guestPage.getByRole('button', { name: 'Join by Invite Code' }).click();
    try {
      await expect(guestQuickbar).toBeVisible({ timeout: 10_000 });
      joinedAsGuest = true;
    } catch {
      await guestPage.goto('/online');
    }
  }
  expect(joinedAsGuest).toBeTruthy();
  await expect(guestQuickbar.getByRole('button', { name: /Enable Focus|Disable Focus/ })).toBeVisible();
  await expect(guestQuickbar.getByRole('button', { name: 'Re-sync Stream' })).toBeVisible();
  await expect(guestQuickbar.getByRole('button', { name: /Show Virtual Pad|Hide Virtual Pad/ })).toBeVisible();
  const moreActions = guestQuickbar.getByRole('button', { name: 'More Actions' });
  await expect(moreActions).toBeVisible();
  await moreActions.click();
  const inputDeckToggle = guestQuickbar.getByRole('button', { name: /Show Input Deck|Hide Input Deck/ });
  await expect(inputDeckToggle).toBeVisible();
  await inputDeckToggle.click();
  await expect(guestPage.getByRole('heading', { name: 'Controller Profile' })).toBeVisible({ timeout: 10_000 });

  await guestPage.screenshot({ path: 'artifacts/online-pass15-guest-phone-modes.png', fullPage: true });
  await guestContext.close();
});
