import { expect, test } from '@playwright/test';

test('library exposes quick resume for last played rom', async ({ page }) => {
  const romPath = process.env.E2E_ROM_PATH;
  test.skip(!romPath, 'Set E2E_ROM_PATH to a local ROM file path to run this smoke test.');

  await page.goto('/');
  await page.setInputFiles('input[type="file"]', romPath!);

  const firstRom = page.locator('.rom-row').first();
  await expect(firstRom).toBeVisible({ timeout: 30_000 });
  const romTitle = (await firstRom.locator('h3').textContent())?.trim() ?? 'ROM';

  await firstRom.getByRole('link', { name: 'Play' }).click();
  await expect(page.getByText('Status: running')).toBeVisible({ timeout: 90_000 });
  await page.getByRole('button', { name: 'Back to Library' }).click();

  const resumeLink = page.getByRole('link', { name: new RegExp(`Resume Last Played: ${romTitle}`) });
  await expect(resumeLink).toBeVisible({ timeout: 20_000 });
  await resumeLink.click();
  await expect(page.getByText('Status: running')).toBeVisible({ timeout: 90_000 });
});
