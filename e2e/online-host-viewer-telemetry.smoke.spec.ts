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

test('host play menu shows per-viewer stream telemetry for connected guests', async ({ page, browser }) => {
  await page.goto('/');
  await page.setInputFiles('input[type="file"]', [
    {
      name: 'viewer-telemetry.z64',
      mimeType: 'application/octet-stream',
      buffer: buildValidRomBuffer('VIEWER TELEMETRY', 0x2400),
    },
  ]);

  await expect(page.getByRole('heading', { name: 'VIEWER TELEMETRY' })).toBeVisible({ timeout: 20_000 });
  await page.goto('/online');
  await page.getByLabel('Host Name').fill('ViewerTelemetryHost');
  await page.getByLabel('ROM (optional)').selectOption({ label: 'VIEWER TELEMETRY' });
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
  await guestPage.getByLabel('Your Name').fill('ViewerTelemetryGuest');
  await guestPage.getByLabel('Invite Code').fill(inviteCode);
  await guestPage.getByRole('button', { name: 'Join by Invite Code' }).click();
  await expect(guestPage.getByText('You are Player 2')).toBeVisible({ timeout: 15_000 });

  await page.getByRole('button', { name: 'Launch Host ROM' }).click();
  await expect(page.locator('.play-stage')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Y stabilize viewers')).toBeVisible({ timeout: 15_000 });

  await page.locator('.play-menu-toggle').click();
  await expect(page.locator('.play-side-menu.open')).toBeVisible();
  await expect(page.getByText('Viewer Stream Links')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Viewer Pressure:')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Connected viewers: 1')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Stabilize Degraded Viewers' })).toBeVisible();
  const autoStabilizeToggle = page.getByLabel('Auto-stabilize high viewer pressure');
  await expect(autoStabilizeToggle).toBeChecked();
  await autoStabilizeToggle.uncheck();
  await expect(page.getByText('Auto-stabilize: disabled.')).toBeVisible();
  await autoStabilizeToggle.check();
  await expect(page.getByText('Auto-stabilize: enabled.')).toBeVisible();

  const viewerRow = page.locator('.viewer-stream-list li').filter({ hasText: 'Player 2: ViewerTelemetryGuest' });
  await expect(viewerRow).toBeVisible({ timeout: 20_000 });
  await expect(viewerRow).toContainText('RTT:');
  await expect(viewerRow).toContainText('Bitrate:');
  await expect(viewerRow).toContainText('Last resync: Never');

  await viewerRow.getByRole('button', { name: 'Re-sync Player' }).click();
  await expect(viewerRow).toContainText('Last resync:');
  await expect(viewerRow).not.toContainText('Last resync: Never');

  await guestContext.close();
});
