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

test('host can lock room joins and unlock later', async ({ page, browser }) => {
  await page.goto('/');
  await page.setInputFiles('input[type="file"]', [
    {
      name: 'room-lock.z64',
      mimeType: 'application/octet-stream',
      buffer: buildValidRomBuffer('ROOM LOCK', 0x2200),
    },
  ]);

  await expect(page.getByRole('heading', { name: 'ROOM LOCK' })).toBeVisible({ timeout: 20_000 });

  await page.goto('/online');
  await page.getByLabel('Host Name').fill('LockHost');
  await page.getByRole('button', { name: 'Start Online Game' }).click();

  const heading = page.getByRole('heading', { name: /Online Session/ });
  await expect(heading).toBeVisible({ timeout: 15_000 });
  const headingText = (await heading.textContent()) ?? '';
  const inviteCodeMatch = headingText.match(/Online Session ([A-Z0-9]{6})/);
  expect(inviteCodeMatch).toBeTruthy();
  const inviteCode = inviteCodeMatch![1];

  await page.getByRole('button', { name: 'Lock Room Joins' }).click();
  await expect(page.getByText('Join access: Locked to current players.')).toBeVisible({ timeout: 10_000 });

  const guestContext = await browser.newContext();
  const guestPage = await guestContext.newPage();
  await guestPage.goto('/online');
  await guestPage.getByLabel('Your Name').fill('LateGuest');
  await guestPage.getByLabel('Invite Code').fill(inviteCode);
  await guestPage.getByRole('button', { name: 'Join by Invite Code' }).click();
  await expect(guestPage.getByText('room is locked by the host', { exact: false })).toBeVisible({ timeout: 10_000 });

  await page.getByRole('button', { name: 'Unlock Room Joins' }).click();
  await expect(page.getByText('Join access: Open for invited players.')).toBeVisible({ timeout: 10_000 });

  await guestPage.getByRole('button', { name: 'Join by Invite Code' }).click();
  await expect(guestPage.getByText('You are Player 2')).toBeVisible({ timeout: 15_000 });

  await guestContext.close();
});
