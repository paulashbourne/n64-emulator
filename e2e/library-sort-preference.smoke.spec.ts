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

test('library sort mode persists across reload', async ({ page }) => {
  await page.goto('/');
  await page.setInputFiles('input[type="file"]', [
    {
      name: 'tiny.z64',
      mimeType: 'application/octet-stream',
      buffer: buildValidRomBuffer('TINY SORT ROM', 0x200),
    },
    {
      name: 'huge.z64',
      mimeType: 'application/octet-stream',
      buffer: buildValidRomBuffer('HUGE SORT ROM', 0x4000),
    },
  ]);

  await expect(page.locator('.rom-row')).toHaveCount(2, { timeout: 20_000 });
  await page.getByLabel('Sort').selectOption('size');

  const firstBeforeReload = (await page.locator('.rom-row').first().locator('h3').textContent())?.trim();
  expect(firstBeforeReload).toBe('HUGE SORT ROM');

  await page.reload();

  await expect(page.locator('.rom-row')).toHaveCount(2, { timeout: 20_000 });
  await expect(page.getByLabel('Sort')).toHaveValue('size');
  const firstAfterReload = (await page.locator('.rom-row').first().locator('h3').textContent())?.trim();
  expect(firstAfterReload).toBe('HUGE SORT ROM');
});
