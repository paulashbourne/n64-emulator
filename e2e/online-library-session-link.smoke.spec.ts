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

test('host can pick rom later and keep session params through library play link', async ({ page }) => {
  await page.goto('/');
  await page.setInputFiles('input[type="file"]', [
    {
      name: 'host-test.z64',
      mimeType: 'application/octet-stream',
      buffer: buildValidRomBuffer('HOST TEST ROM', 0x2000),
    },
  ]);

  await expect(page.locator('.rom-row')).toHaveCount(1, { timeout: 20_000 });

  await page.goto('/online');
  await page.getByRole('button', { name: 'Start Online Game' }).click();

  const heading = page.getByRole('heading', { name: /Online Session/ });
  await expect(heading).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('No ROM selected for host yet.')).toBeVisible({ timeout: 20_000 });

  const sessionUrl = new URL(page.url());
  const clientId = sessionUrl.searchParams.get('clientId');
  expect(clientId).toBeTruthy();

  const headingText = (await heading.textContent()) ?? '';
  const inviteCodeMatch = headingText.match(/Online Session ([A-Z0-9]{6})/);
  expect(inviteCodeMatch).toBeTruthy();
  const inviteCode = inviteCodeMatch![1];

  await page.getByRole('link', { name: 'Choose ROM in Library' }).click();
  await expect(page.getByRole('heading', { name: 'N64 ROM Library' })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(`session ${inviteCode}`, { exact: false })).toBeVisible({ timeout: 20_000 });

  await page.getByRole('link', { name: 'Play' }).first().click();
  await expect(page).toHaveURL(new RegExp(`/play/.+onlineCode=${inviteCode}&onlineClientId=${clientId}`), {
    timeout: 20_000,
  });
});
