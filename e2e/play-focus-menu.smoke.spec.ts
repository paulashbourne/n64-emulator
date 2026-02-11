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

test('local play shows focus menu and default keyboard profile', async ({ page }) => {
  await page.goto('/');
  await page.setInputFiles('input[type="file"]', [
    {
      name: 'focus-menu-test.z64',
      mimeType: 'application/octet-stream',
      buffer: buildValidRomBuffer('FOCUS MENU', 0x2000),
    },
  ]);

  await page.getByRole('link', { name: 'Play' }).first().click();
  await expect(page.locator('.play-stage')).toBeVisible({ timeout: 15_000 });

  await page.locator('.play-menu-toggle').click();
  await expect(page.locator('.play-side-menu.open')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Game Menu' })).toBeVisible();
  await expect(page.locator('.play-side-menu.open')).toContainText('Keyboard Default');

  await page.locator('.play-side-header').getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.locator('.play-side-menu.open')).toHaveCount(0);
});
