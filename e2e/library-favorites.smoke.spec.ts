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

test('favorites can be toggled, filtered, and persisted across reload', async ({ page }) => {
  await page.goto('/');
  await page.setInputFiles('input[type="file"]', [
    {
      name: 'alpha.z64',
      mimeType: 'application/octet-stream',
      buffer: buildValidRomBuffer('ALPHA FAV', 0x1200),
    },
    {
      name: 'beta.z64',
      mimeType: 'application/octet-stream',
      buffer: buildValidRomBuffer('BETA BASE', 0x1300),
    },
  ]);

  await expect(page.locator('.rom-row')).toHaveCount(2, { timeout: 20_000 });

  const alphaRow = page.locator('.rom-row').filter({ has: page.getByRole('heading', { name: 'ALPHA FAV' }) });
  await alphaRow.getByRole('button', { name: 'Favorite' }).click();
  await expect(alphaRow.getByRole('button', { name: 'Unfavorite' })).toBeVisible();

  await page.getByLabel('Favorites only').check();
  await expect(page.locator('.rom-row')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'ALPHA FAV' })).toBeVisible();

  await page.reload();
  await expect(page.locator('.rom-row')).toHaveCount(1, { timeout: 20_000 });
  await expect(page.getByRole('heading', { name: 'ALPHA FAV' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Unfavorite' })).toBeVisible();
});
