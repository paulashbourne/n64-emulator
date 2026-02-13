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

test('play screen supports immersive HUD toggle and keyboard shortcut', async ({ page }) => {
  await page.goto('/');
  await page.setInputFiles('input[type="file"]', [
    {
      name: 'immersive-hud-test.z64',
      mimeType: 'application/octet-stream',
      buffer: buildValidRomBuffer('IMMERSIVE HUD', 0x2200),
    },
  ]);

  await page.getByRole('link', { name: 'Play' }).first().click();
  await expect(page.locator('.play-stage')).toBeVisible({ timeout: 15_000 });

  await page.locator('.play-overlay-top').getByRole('button', { name: 'Hide HUD' }).click();
  await expect(page.locator('.play-hud-reveal')).toBeVisible();
  await expect(page.locator('.play-overlay-top')).toHaveCount(0);

  await page.locator('.play-stage').click({ position: { x: 240, y: 240 } });
  await page.keyboard.press('h');
  await expect(page.locator('.play-overlay-top')).toBeVisible();
  await expect(page.locator('.play-overlay-top').getByRole('button', { name: 'Hide HUD' })).toBeVisible();
});
