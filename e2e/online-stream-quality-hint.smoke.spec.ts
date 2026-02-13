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

test('guest can request host stream mode changes during online play', async ({ page, browser }) => {
  await page.goto('/');
  await page.setInputFiles('input[type="file"]', [
    {
      name: 'quality-hint.z64',
      mimeType: 'application/octet-stream',
      buffer: buildValidRomBuffer('QUALITY HINT', 0x2000),
    },
  ]);

  await expect(page.getByRole('heading', { name: 'QUALITY HINT' })).toBeVisible({ timeout: 20_000 });
  await page.goto('/online');
  await page.getByLabel('Host Name').fill('QualityHost');
  await page.getByLabel('ROM (optional)').selectOption({ label: 'QUALITY HINT' });
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
  await guestPage.getByLabel('Your Name').fill('QualityGuest');
  await guestPage.getByLabel('Invite Code').fill(inviteCode);
  await guestPage.getByRole('button', { name: 'Join by Invite Code' }).click();
  await expect(guestPage.getByText('You are Player 2')).toBeVisible({ timeout: 15_000 });

  await page.getByRole('button', { name: 'Launch Host ROM' }).click();
  await expect(page.locator('.play-stage')).toBeVisible({ timeout: 20_000 });

  const requestQualityButton = guestPage.getByRole('button', {
    name: /Request (Ultra Low Latency|Balanced|Quality)/,
  });
  await expect(requestQualityButton).toBeEnabled({ timeout: 20_000 });
  await requestQualityButton.click();

  await expect
    .poll(
      async () => {
        const warning = await page.locator('.warning-text').first().textContent();
        return warning ?? '';
      },
      { timeout: 20_000 },
    )
    .toMatch(/requested/i);

  await guestContext.close();
});
