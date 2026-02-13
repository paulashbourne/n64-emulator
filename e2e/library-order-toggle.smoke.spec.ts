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

test('library order toggle can reverse visible catalog order and persist', async ({ page }) => {
  await page.goto('/');
  await page.setInputFiles('input[type="file"]', [
    {
      name: 'small-order.z64',
      mimeType: 'application/octet-stream',
      buffer: buildValidRomBuffer('SMALL ORDER', 0x200),
    },
    {
      name: 'large-order.z64',
      mimeType: 'application/octet-stream',
      buffer: buildValidRomBuffer('LARGE ORDER', 0x4000),
    },
  ]);

  await expect(page.locator('.rom-row')).toHaveCount(2, { timeout: 20_000 });
  await page.getByLabel('Sort').selectOption('size');
  await page.getByRole('button', { name: 'More Filters' }).click();
  await expect(page.getByRole('button', { name: 'Order: Default' })).toBeVisible();

  const firstDefault = (await page.locator('.rom-row').first().locator('h3').textContent())?.trim();
  expect(firstDefault).toBe('LARGE ORDER');

  await page.getByRole('button', { name: 'Order: Default' }).click();
  await expect(page.getByRole('button', { name: 'Order: Reversed' })).toBeVisible();

  const firstReversed = (await page.locator('.rom-row').first().locator('h3').textContent())?.trim();
  expect(firstReversed).toBe('SMALL ORDER');

  await page.reload();

  await expect(page.locator('.rom-row')).toHaveCount(2, { timeout: 20_000 });
  await page.getByRole('button', { name: 'More Filters' }).click();
  await expect(page.getByRole('button', { name: 'Order: Reversed' })).toBeVisible();
  const firstAfterReload = (await page.locator('.rom-row').first().locator('h3').textContent())?.trim();
  expect(firstAfterReload).toBe('SMALL ORDER');
});
