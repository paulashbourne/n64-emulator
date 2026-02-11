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

test('host can start session with selected rom and no pattern errors', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => {
    pageErrors.push(error.message);
  });

  await page.goto('/');
  await page.setInputFiles('input[type="file"]', [
    {
      name: 'banjo-tooie.z64',
      mimeType: 'application/octet-stream',
      buffer: buildValidRomBuffer('BANJO TOOIE', 0x1800),
    },
  ]);

  await expect(page.getByRole('heading', { name: 'BANJO TOOIE' })).toBeVisible({ timeout: 20_000 });

  await page.goto('/online');
  await page.getByLabel('Host Name').fill('Paul');
  await page.getByLabel('ROM (optional)').selectOption({ label: 'BANJO TOOIE' });
  await page.getByRole('button', { name: 'Start Online Game' }).click();

  await expect(page.getByRole('heading', { name: /Online Session/ })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Host ROM: BANJO TOOIE')).toBeVisible({ timeout: 15_000 });
  expect(pageErrors).toEqual([]);
});
