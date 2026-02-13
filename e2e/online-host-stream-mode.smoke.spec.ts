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

test('host can switch stream quality mode while running online play', async ({ page }) => {
  await page.goto('/');
  await page.setInputFiles('input[type="file"]', [
    {
      name: 'stream-mode.z64',
      mimeType: 'application/octet-stream',
      buffer: buildValidRomBuffer('STREAM MODE', 0x2200),
    },
  ]);

  await expect(page.getByRole('heading', { name: 'STREAM MODE' })).toBeVisible({ timeout: 20_000 });
  await page.goto('/online');
  await page.getByLabel('Host Name').fill('StreamHost');
  await page.getByLabel('ROM (optional)').selectOption({ label: 'STREAM MODE' });
  await page.getByRole('button', { name: 'Start Online Game' }).click();
  await expect(page.getByRole('heading', { name: /Online Session/ })).toBeVisible({ timeout: 15_000 });

  await page.getByRole('button', { name: 'Launch Host ROM' }).click();
  await expect(page.locator('.play-stage')).toBeVisible({ timeout: 20_000 });

  await page.locator('.play-menu-toggle').click();
  await expect(page.locator('.play-side-menu.open')).toBeVisible();

  const modeSelect = page.getByLabel('Stream mode');
  await expect(modeSelect).toBeVisible();
  await expect(modeSelect).toHaveValue('adaptive');
  await expect(page.getByText('Automatically tuned. Current mode:')).toBeVisible();

  await modeSelect.selectOption('quality');
  await expect(modeSelect).toHaveValue('quality');
  await expect(page.getByText('Uses higher bitrate for cleaner frames on stronger networks.')).toBeVisible();
  await expect(page.getByText('Active mode: Quality')).toBeVisible();
  await expect(page.getByText('Health: Idle')).toBeVisible();
  await expect(page.getByText('No connected stream viewers yet.')).toBeVisible();
});
