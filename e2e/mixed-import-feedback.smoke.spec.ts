import { expect, test } from '@playwright/test';

function buildValidRomBuffer(title: string): Buffer {
  const bytes = Buffer.alloc(0x80, 0);
  bytes[0] = 0x80;
  bytes[1] = 0x37;
  bytes[2] = 0x12;
  bytes[3] = 0x40;

  const paddedTitle = title.padEnd(20, ' ').slice(0, 20);
  Buffer.from(paddedTitle, 'ascii').copy(bytes, 0x20);
  return bytes;
}

test('mixed import reports skipped invalid files while keeping valid roms', async ({ page }) => {
  await page.goto('/');
  await page.setInputFiles('input[type="file"]', [
    {
      name: 'valid.z64',
      mimeType: 'application/octet-stream',
      buffer: buildValidRomBuffer('VALID TEST ROM'),
    },
    {
      name: 'broken.z64',
      mimeType: 'application/octet-stream',
      buffer: Buffer.from([1, 2, 3, 4, 5, 6]),
    },
  ]);

  await expect(page.getByText('Imported 1 ROM and skipped 1 invalid or duplicate file.')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.rom-row')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'VALID TEST ROM' })).toBeVisible();
});
