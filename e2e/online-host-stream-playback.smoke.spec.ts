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

test('guest receives host stream playback after host launches rom', async ({ page, browser }) => {
  await page.goto('/');
  await page.setInputFiles('input[type="file"]', [
    {
      name: 'stream-smoke.z64',
      mimeType: 'application/octet-stream',
      buffer: buildValidRomBuffer('STREAM SMOKE', 0x2000),
    },
  ]);

  await expect(page.getByRole('heading', { name: 'STREAM SMOKE' })).toBeVisible({ timeout: 20_000 });
  await page.goto('/online');
  await page.getByLabel('Host Name').fill('ReviewerHost');
  await page.getByLabel('ROM (optional)').selectOption({ label: 'STREAM SMOKE' });
  await page.getByRole('button', { name: 'Start Online Game' }).click();

  const hostHeading = page.getByRole('heading', { name: /Online Session/ });
  await expect(hostHeading).toBeVisible({ timeout: 15_000 });
  const headingText = (await hostHeading.textContent()) ?? '';
  const inviteCodeMatch = headingText.match(/Online Session ([A-Z0-9]{6})/);
  expect(inviteCodeMatch).toBeTruthy();
  const inviteCode = inviteCodeMatch![1];

  const guestContext = await browser.newContext();
  const guestPage = await guestContext.newPage();
  await guestPage.goto('/online');
  await guestPage.getByLabel('Your Name').fill('ReviewerGuest');
  await guestPage.getByLabel('Invite Code').fill(inviteCode);
  await guestPage.getByRole('button', { name: 'Join by Invite Code' }).click();

  await expect(guestPage.getByText('You are Player 2')).toBeVisible({ timeout: 15_000 });
  await expect(
    guestPage.getByText(/Host ROM is selected\. Waiting for launch stream\.|Waiting for host to launch a game stream\./),
  ).toBeVisible();

  const showVirtualControllerButton = guestPage.getByRole('button', { name: /Show Virtual (Controller|Pad)/ });
  if (await showVirtualControllerButton.count()) {
    await showVirtualControllerButton.first().click();
    await expect(guestPage.locator('.online-session-virtual-controller-dock .virtual-controller.compact')).toBeVisible();
    await guestPage.getByRole('button', { name: /Expand Controller|Expand Pad Layout/ }).click();
    await expect(guestPage.locator('.online-session-virtual-controller-dock .virtual-controller.compact')).toHaveCount(0);
  }

  await page.getByRole('button', { name: 'Launch Host ROM' }).click();
  await expect(page.locator('.play-stage')).toBeVisible({ timeout: 20_000 });

  await expect
    .poll(
      async () =>
        guestPage.evaluate(() => {
          const video = document.querySelector('.host-stream-video') as HTMLVideoElement | null;
          return video && video.srcObject ? 'ready' : 'pending';
        }),
      { timeout: 30_000 },
    )
    .toBe('ready');
  await expect(guestPage.getByText(/Live host stream connected.|Connecting to host stream/)).toBeVisible({
    timeout: 15_000,
  });

  await guestPage.getByRole('button', { name: 'Re-sync Stream' }).click();
  await expect(
    guestPage.getByText(/Requested host stream resync.|Resync is cooling down. Try again in a moment./),
  ).toBeVisible({ timeout: 10_000 });
  await expect(guestPage.getByText(/Live host stream connected.|Connecting to host stream/)).toBeVisible({
    timeout: 15_000,
  });

  await guestContext.close();
});
