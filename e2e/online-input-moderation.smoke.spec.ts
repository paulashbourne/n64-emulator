import { expect, test } from '@playwright/test';

function buildValidRomBuffer(title: string, totalBytes: number): Buffer {
  const size = Math.max(0x80, totalBytes);
  const bytes = Buffer.alloc(size, 0);
  bytes[0] = 0x80;
  bytes[1] = 0x37;
  bytes[2] = 0x12;
  bytes[3] = 0x40;
  Buffer.from(title.padEnd(20, ' ').slice(0, 20), 'ascii').copy(bytes, 0x20);
  return bytes;
}

test('host can mute and unmute guest controller input controls during online play', async ({ page, browser }) => {
  await page.goto('/');
  await page.setInputFiles('input[type="file"]', [
    {
      name: 'input-moderation.z64',
      mimeType: 'application/octet-stream',
      buffer: buildValidRomBuffer('INPUT MODERATION', 0x2000),
    },
  ]);

  await expect(page.getByRole('heading', { name: 'INPUT MODERATION' })).toBeVisible({ timeout: 20_000 });
  await page.goto('/online');
  await page.getByLabel('Host Name').fill('ModerationHost');
  await page.getByLabel('ROM (optional)').selectOption({ label: 'INPUT MODERATION' });
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
  await guestPage.getByLabel('Your Name').fill('ModerationGuest');
  await guestPage.getByLabel('Invite Code').fill(inviteCode);
  await guestPage.getByRole('button', { name: 'Join by Invite Code' }).click();
  await expect(guestPage.getByText('You are Player 2')).toBeVisible({ timeout: 15_000 });

  await page.getByRole('button', { name: 'Launch Host ROM' }).click();
  await expect(page.locator('.play-stage')).toBeVisible({ timeout: 20_000 });

  await page.locator('.play-menu-toggle').click();
  const moderationRow = page.locator('.input-moderation-list li').filter({ hasText: 'ModerationGuest' });
  const guestQuickAButton = guestPage
    .locator('.online-guest-stream-panel .online-input-grid')
    .first()
    .getByRole('button', { name: /^A$/, exact: true });
  await expect(moderationRow).toBeVisible({ timeout: 20_000 });
  const remoteEventsBadge = page.getByText(/Remote events: \d+/);
  await expect(remoteEventsBadge).toContainText('Remote events: 0');
  await moderationRow.getByRole('button', { name: 'Mute Input' }).click();
  await expect(moderationRow.getByRole('button', { name: 'Unmute Input' })).toBeVisible({ timeout: 10_000 });
  await expect(guestQuickAButton).toBeDisabled();
  await expect(guestPage.getByText('Your controller input is currently muted by the host.')).toBeVisible({
    timeout: 10_000,
  });
  await expect(remoteEventsBadge).toContainText('Remote events: 0');

  await moderationRow.getByRole('button', { name: 'Unmute Input' }).click();
  await expect(moderationRow.getByRole('button', { name: 'Mute Input' })).toBeVisible({ timeout: 10_000 });
  await expect(guestPage.getByText('Your controller input is currently muted by the host.')).toHaveCount(0);
  await expect(guestQuickAButton).toBeEnabled();

  await guestContext.close();
});
