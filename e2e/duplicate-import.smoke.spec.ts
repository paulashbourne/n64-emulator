import { expect, test } from '@playwright/test';

function buildValidRomBuffer(title: string): Buffer {
  const bytes = Buffer.alloc(0x80, 0);
  bytes[0] = 0x80;
  bytes[1] = 0x37;
  bytes[2] = 0x12;
  bytes[3] = 0x40;
  Buffer.from(title.padEnd(20, ' ').slice(0, 20), 'ascii').copy(bytes, 0x20);
  return bytes;
}

test('duplicate ROM imports collapse to one catalog entry', async ({ page }) => {
  const duplicateBuffer = buildValidRomBuffer('DUPLICATE TEST ROM');

  await page.goto('/');
  await page.setInputFiles('input[type="file"]', [
    {
      name: 'duplicate-a.z64',
      mimeType: 'application/octet-stream',
      buffer: duplicateBuffer,
    },
    {
      name: 'duplicate-b.z64',
      mimeType: 'application/octet-stream',
      buffer: duplicateBuffer,
    },
  ]);

  await expect(page.getByText('Imported 1 ROM and skipped 1 invalid or duplicate file.')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.rom-row')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'DUPLICATE TEST ROM' })).toBeVisible();
});
