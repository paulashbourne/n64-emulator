import { expect, test } from '@playwright/test';

test('settings supports section presets, filters, and sort on desktop and phone', async ({ page, browser }) => {
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible({ timeout: 15_000 });
  const desktopShowLayoutTools = page.getByRole('button', { name: 'Show Layout Tools' });
  if (await desktopShowLayoutTools.count()) {
    await desktopShowLayoutTools.click();
  }
  const desktopBootJump = page.getByRole('button', { name: /Focus Boot|Boot Mode/ }).first();
  await expect(desktopBootJump).toBeVisible();
  await desktopBootJump.click();
  await expect(page.locator('#settings-boot-mode').getByLabel('Default boot mode')).toBeVisible();

  const desktopShowAllSections = page.getByRole('button', { name: 'Show All Sections' });
  if (await desktopShowAllSections.count()) {
    await desktopShowAllSections.click();
  }
  await expect(page.locator('#settings-profiles').getByRole('button', { name: 'Create Profile' })).toBeVisible();

  await page.locator('#settings-profiles .settings-sort-controls select').selectOption('name');
  await page.locator('#settings-profiles .settings-sort-controls button').click();
  const activeOnlyFilter = page.getByLabel('Active only');
  if (await activeOnlyFilter.count()) {
    await activeOnlyFilter.check();
  }
  await expect(page.locator('#settings-profiles').getByText(/by name\./i)).toBeVisible();

  await page.screenshot({ path: 'artifacts/settings-pass9-desktop-layout.png', fullPage: true });

  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const phonePage = await phoneContext.newPage();
  await phonePage.goto('/settings');
  await expect(phonePage.getByRole('heading', { name: 'Settings' })).toBeVisible({ timeout: 15_000 });
  const phoneShowLayoutTools = phonePage.getByRole('button', { name: 'Show Layout Tools' });
  if (await phoneShowLayoutTools.count()) {
    await phoneShowLayoutTools.click();
  }
  const phoneFocusSave = phonePage.getByRole('button', { name: /Focus Save|Save Experience/ }).first();
  await expect(phoneFocusSave).toBeVisible();

  await phoneFocusSave.click();
  await expect(phonePage.locator('#settings-save-experience').getByText('Default mode is console-like autosave/resume.')).toBeVisible();
  const collapsedNote = phonePage.locator('#settings-profiles .settings-collapsed-note');
  if (await collapsedNote.count()) {
    await expect(collapsedNote).toBeVisible();
  }

  await phonePage.keyboard.press('1');
  await expect(phonePage.locator('#settings-profiles').getByRole('button', { name: 'Create Profile' })).toBeVisible();
  await phonePage.screenshot({ path: 'artifacts/settings-pass9-phone-layout.png', fullPage: true });

  await phoneContext.close();
});
