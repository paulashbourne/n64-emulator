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

test('host can set room rom from session page and joiners see it', async ({ page, browser }) => {
  await page.goto('/');
  await page.setInputFiles('input[type="file"]', [
    {
      name: 'room-host.z64',
      mimeType: 'application/octet-stream',
      buffer: buildValidRomBuffer('ROOM HOST ROM', 0x3000),
    },
  ]);
  await expect(page.locator('.rom-row')).toHaveCount(1, { timeout: 20_000 });

  await page.goto('/online');
  await page.getByLabel('Host Name').fill('HostUser');
  await page.getByRole('button', { name: 'Start Online Game' }).click();

  const heading = page.getByRole('heading', { name: /Online Session/ });
  await expect(heading).toBeVisible({ timeout: 15_000 });
  const headingText = (await heading.textContent()) ?? '';
  const inviteCodeMatch = headingText.match(/Online Session ([A-Z0-9]{6})/);
  expect(inviteCodeMatch).toBeTruthy();
  const inviteCode = inviteCodeMatch![1];

  await page.getByLabel('Selected ROM').selectOption({ label: 'ROOM HOST ROM' });
  await page.getByRole('button', { name: 'Set Room ROM' }).click();
  await expect(page.getByText('Host ROM: ROOM HOST ROM')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('link', { name: 'Launch Host ROM' })).toBeVisible({ timeout: 15_000 });

  const guestContext = await browser.newContext();
  const guestPage = await guestContext.newPage();
  await guestPage.goto('/online');
  await guestPage.getByLabel('Your Name').fill('GuestTwo');
  await guestPage.getByLabel('Invite Code').fill(inviteCode);
  await guestPage.getByRole('button', { name: 'Join by Invite Code' }).click();

  await expect(guestPage.getByText('You are Player 2')).toBeVisible({ timeout: 15_000 });
  await expect(guestPage.getByText('Host ROM: ROOM HOST ROM')).toBeVisible({ timeout: 15_000 });

  await guestContext.close();
});
