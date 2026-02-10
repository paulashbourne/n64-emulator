import { expect, test } from '@playwright/test';

test('invalid rom file shows helpful error and does not pollute catalog', async ({ page }) => {
  await page.goto('/');
  await page.setInputFiles('input[type="file"]', {
    name: 'corrupt.z64',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9]),
  });

  await expect(page.getByText('No valid N64 ROM files were found in your selection.')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.rom-row')).toHaveCount(0);
});
