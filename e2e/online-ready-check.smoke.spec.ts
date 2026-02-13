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

test('host ready lock blocks launch until all connected players mark ready', async ({ page, browser }) => {
  await page.goto('/');
  await page.setInputFiles('input[type="file"]', [
    {
      name: 'ready-lock.z64',
      mimeType: 'application/octet-stream',
      buffer: buildValidRomBuffer('READY LOCK', 0x2200),
    },
  ]);

  await expect(page.getByRole('heading', { name: 'READY LOCK' })).toBeVisible({ timeout: 20_000 });
  await page.goto('/online');
  await page.getByLabel('Host Name').fill('ReadyHost');
  await page.getByLabel('ROM (optional)').selectOption({ label: 'READY LOCK' });
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
  await guestPage.getByLabel('Your Name').fill('ReadyGuest');
  await guestPage.getByLabel('Invite Code').fill(inviteCode);
  await guestPage.getByRole('button', { name: 'Join by Invite Code' }).click();
  await expect(guestPage.getByText('You are Player 2')).toBeVisible({ timeout: 15_000 });

  await expect(page.getByText('Ready: 0/2')).toBeVisible({ timeout: 15_000 });
  await page.getByLabel('Require all connected players ready before launch').check();
  await expect(page.getByRole('heading', { name: 'Launch Readiness' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Ready lock is enabled. Waiting on 2 players.')).toBeVisible({ timeout: 10_000 });

  await page.getByRole('button', { name: 'Send Ready Check' }).click();
  await expect(page.getByText('Ready check: 0/2 ready.', { exact: false })).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: 'Ping Waiting Guests' }).click();
  await expect(page.getByText('Pinged waiting guests in chat.')).toBeVisible({ timeout: 10_000 });

  await page.getByRole('button', { name: 'Launch Host ROM' }).click();
  await expect(page.getByText('Ready lock is enabled. Wait for all connected players to mark ready.')).toBeVisible({
    timeout: 10_000,
  });
  await page.screenshot({ path: 'artifacts/online-pass14-launch-readiness-host.png', fullPage: true });
  await expect(page.getByRole('heading', { name: /Online Session/ })).toBeVisible();

  await guestPage.getByRole('button', { name: 'Mark Ready' }).click();
  await expect(guestPage.getByRole('button', { name: 'Mark Not Ready' })).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: 'Launch Host ROM' }).click();
  await expect(page.getByText('Ready lock is enabled. Wait for all connected players to mark ready.')).toBeVisible({
    timeout: 10_000,
  });

  await page.getByRole('button', { name: 'Mark Ready' }).click();
  await expect(page.getByRole('button', { name: 'Mark Not Ready' })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('Ready check: 2/2 connected players ready')).toBeVisible({ timeout: 10_000 });

  await page.getByRole('button', { name: 'Launch Host ROM' }).click();
  await expect(page.locator('.play-stage')).toBeVisible({ timeout: 20_000 });

  await guestContext.close();
});
