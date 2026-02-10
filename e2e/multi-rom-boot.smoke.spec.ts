import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

const ROM_EXTENSIONS = new Set(['.z64', '.n64', '.v64']);

function listRomFiles(directory: string): string[] {
  const output: string[] = [];
  const stack = [directory];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const resolved = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(resolved);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const extension = path.extname(entry.name).toLowerCase();
      if (ROM_EXTENSIONS.has(extension)) {
        output.push(resolved);
      }
    }
  }

  return output.sort((left, right) => left.localeCompare(right));
}

test('boots multiple roms sequentially from the library', async ({ page }) => {
  const romDirectory = process.env.E2E_ROM_DIR;
  test.skip(!romDirectory, 'Set E2E_ROM_DIR to a local ROM directory path to run this smoke test.');

  const parsedCount = Number(process.env.E2E_MULTI_ROM_COUNT ?? '3');
  const romCount = Number.isFinite(parsedCount) ? Math.max(1, Math.min(10, Math.floor(parsedCount))) : 3;

  const romFiles = listRomFiles(romDirectory!).slice(0, romCount);
  test.skip(romFiles.length === 0, 'No ROM files were found in E2E_ROM_DIR.');

  await page.goto('/');
  await page.setInputFiles('input[type="file"]', romFiles);
  await page.getByLabel('Sort').selectOption('title');

  const romRows = page.locator('.rom-row');
  await expect(romRows).toHaveCount(romFiles.length, { timeout: 30_000 });

  const titles: string[] = [];
  for (let index = 0; index < romFiles.length; index += 1) {
    const title = (await romRows.nth(index).locator('h3').textContent())?.trim() ?? `ROM ${index + 1}`;
    titles.push(title);
  }

  for (let index = 0; index < romFiles.length; index += 1) {
    const title = titles[index];
    await test.step(`boot ${title}`, async () => {
      await romRows.nth(index).getByRole('link', { name: 'Play' }).click();
      await expect(page.getByText('Status: running')).toBeVisible({ timeout: 90_000 });
      await expect(page.getByText('Error loading EmulatorJS runtime')).toHaveCount(0);
      await page.getByRole('button', { name: 'Back to Library' }).click();
      await expect(page.getByRole('heading', { name: 'N64 ROM Library' })).toBeVisible({ timeout: 15_000 });
    });
  }
});
