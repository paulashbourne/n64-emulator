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

test('guest stream remains attached during steady online playback', async ({ page, browser }) => {
  await page.goto('/');
  await page.setInputFiles('input[type="file"]', [
    {
      name: 'stream-stability.z64',
      mimeType: 'application/octet-stream',
      buffer: buildValidRomBuffer('STREAM STABLE', 0x2000),
    },
  ]);

  await expect(page.getByRole('heading', { name: 'STREAM STABLE' })).toBeVisible({ timeout: 20_000 });
  await page.goto('/online');
  await page.getByLabel('Host Name').fill('StableHost');
  await page.getByLabel('ROM (optional)').selectOption({ label: 'STREAM STABLE' });
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
  await guestPage.getByLabel('Your Name').fill('StableGuest');
  await guestPage.getByLabel('Invite Code').fill(inviteCode);
  await guestPage.getByRole('button', { name: 'Join by Invite Code' }).click();

  await expect(guestPage.getByText('You are Player 2')).toBeVisible({ timeout: 15_000 });

  await page.getByRole('button', { name: 'Launch Host ROM' }).click();
  await expect(page.locator('.play-stage')).toBeVisible({ timeout: 20_000 });

  await expect
    .poll(
      async () =>
        guestPage.evaluate(() => {
          const video = document.querySelector('.host-stream-video') as HTMLVideoElement | null;
          const stream = video?.srcObject as MediaStream | null;
          if (!video || !stream) {
            return null;
          }
          return {
            streamId: stream.id,
            currentTime: video.currentTime,
          };
        }),
      { timeout: 30_000 },
    )
    .not.toBeNull();

  const first = await guestPage.evaluate(() => {
    const video = document.querySelector('.host-stream-video') as HTMLVideoElement | null;
    const stream = video?.srcObject as MediaStream | null;
    return {
      streamId: stream?.id ?? '',
    };
  });

  await guestPage.waitForTimeout(3_500);

  const second = await guestPage.evaluate(() => {
    const video = document.querySelector('.host-stream-video') as HTMLVideoElement | null;
    const stream = video?.srcObject as MediaStream | null;
    return {
      streamId: stream?.id ?? '',
    };
  });

  expect(first.streamId).not.toHaveLength(0);
  expect(second.streamId).toBe(first.streamId);
  await expect(guestPage.locator('.host-stream-placeholder')).toHaveCount(0);

  await guestContext.close();
});
