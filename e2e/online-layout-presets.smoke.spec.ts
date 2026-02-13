import { expect, test } from '@playwright/test';

test('compact online layout presets and unread chat indicator work on phone', async ({ page, browser }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/online');
  await page.getByLabel('Host Name').fill('LayoutHost');
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
  await guestPage.getByLabel('Your Name').fill('LayoutGuest');
  await guestPage.getByLabel('Invite Code').fill(inviteCode);
  await guestPage.getByRole('button', { name: 'Join by Invite Code' }).click();
  await expect(guestPage.getByText(/Player 2/)).toBeVisible({ timeout: 15_000 });
  await expect(guestPage.locator('.online-panel-toggle-strip')).toHaveCount(0);
  await guestPage.getByRole('button', { name: 'Show Session Details' }).click();
  await expect(guestPage.getByText('Invite code:')).toBeVisible();
  await guestPage.getByRole('button', { name: 'Hide Session Details' }).click();

  await guestPage.locator('.online-guest-quickbar').getByRole('button', { name: 'Disable Focus' }).click();
  await guestPage.locator('.online-guest-quickbar').getByRole('button', { name: 'More Actions' }).click();
  await guestPage.locator('.online-guest-quickbar').getByRole('button', { name: /^Show Chat/ }).click();
  await guestPage.getByRole('button', { name: 'Ready?' }).click();
  const guestChatMessage = `phone-layout-${Date.now()}`;
  const guestChatInput = guestPage.getByPlaceholder('Type a message for everyone in this room…');
  await expect(guestChatInput).toBeVisible({ timeout: 15_000 });
  await guestChatInput.fill(guestChatMessage);
  await guestPage.getByRole('button', { name: 'Send' }).click();
  await guestPage.locator('.online-guest-quickbar').getByRole('button', { name: 'More Actions' }).click();
  await expect(guestPage.locator('.online-guest-quickbar').getByRole('button', { name: 'Turbo Latency' })).toBeVisible();
  await guestPage.screenshot({ path: 'artifacts/online-pass13-guest-phone-quickbar.png', fullPage: true });
  await guestPage.locator('.online-guest-quickbar').getByRole('button', { name: 'Less Actions' }).click();

  const hostQuickbar = page.locator('.online-host-quickbar');
  const hostChatToggle = hostQuickbar.getByRole('button', { name: /Show Chat/ }).first();
  if (!(await hostChatToggle.isVisible())) {
    const hostMoreActionsButton = hostQuickbar.getByRole('button', { name: 'More Actions' });
    if (await hostMoreActionsButton.isVisible()) {
      await hostMoreActionsButton.click();
    }
  }
  await expect(hostChatToggle).toBeVisible({ timeout: 15_000 });
  await hostChatToggle.click();
  await expect(page.locator('.chat-list li').filter({ hasText: 'Ready?' }).first()).toBeVisible({ timeout: 15_000 });

  await hostQuickbar.getByRole('button', { name: 'Focus Controls' }).click();
  await expect(page.getByText('Players panel collapsed to keep host controls in focus.')).toBeVisible({
    timeout: 15_000,
  });
  const hostMoreActionsButton = hostQuickbar.getByRole('button', { name: 'More Actions' });
  if (await hostMoreActionsButton.isVisible()) {
    await hostMoreActionsButton.click();
  }
  await expect(hostQuickbar.getByRole('button', { name: /^Show Host Controls|Hide Host Controls$/ })).toBeVisible();
  await expect(hostQuickbar.getByRole('button', { name: 'Jump Launch' })).toBeVisible();
  await expect(hostQuickbar.getByRole('button', { name: /^Quick Lock Room|Quick Unlock Room$/ })).toBeVisible();
  await expect(hostQuickbar.getByRole('button', { name: /^Pause Feed|Resume Feed/ })).toBeVisible();
  await hostQuickbar.getByRole('button', { name: 'Pause Feed' }).click();
  await expect(
    hostQuickbar.locator('.session-status-row .status-pill').filter({ hasText: 'Feed Paused' }).first(),
  ).toBeVisible({ timeout: 15_000 });
  await hostQuickbar.getByRole('button', { name: 'Resume Feed' }).click();
  await hostQuickbar.getByRole('button', { name: /^Quick Lock Room|Quick Unlock Room$/ }).click();
  await expect(page.getByText(/Join access: Locked/)).toBeVisible({ timeout: 15_000 });
  await hostQuickbar.getByRole('button', { name: /^Quick Lock Room|Quick Unlock Room$/ }).click();
  await hostQuickbar.getByRole('button', { name: 'Show All' }).click();
  await expect(page.getByRole('button', { name: 'Copy Feed' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Copy Diagnostics' })).toBeVisible({ timeout: 15_000 });
  const hostControlsPanel = page.locator('.online-session-host-controls-panel');
  await expect(hostControlsPanel.getByLabel('Type')).toHaveValue('all');
  await expect(hostControlsPanel.getByLabel('Slot')).toHaveValue('all');
  await hostQuickbar.getByRole('button', { name: 'Ready Check' }).click();
  await expect(page.getByText(/Ready check: .*ready\./).first()).toBeVisible({ timeout: 15_000 });
  await hostQuickbar.getByRole('button', { name: 'Jump Launch' }).click();
  await expect(page.getByRole('heading', { name: 'Launch Readiness' })).toBeVisible({ timeout: 15_000 });
  const lessActionsButton = hostQuickbar.getByRole('button', { name: 'Less Actions' });
  if (await lessActionsButton.isVisible()) {
    await lessActionsButton.click();
  }

  await expect(page.getByText('Share code', { exact: false })).toBeVisible({ timeout: 15_000 });

  await page.screenshot({ path: 'artifacts/online-pass13-host-phone-layout.png', fullPage: true });
  await guestContext.close();
});
