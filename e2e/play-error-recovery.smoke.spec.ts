import { expect, test } from '@playwright/test';

test('play page exposes clear recovery actions when ROM boot fails', async ({ page, browser }) => {
  await page.goto('/play/rom-missing-e2e');
  await expect(page.getByRole('heading', { name: 'Unable to start this ROM' })).toBeVisible({ timeout: 20_000 });
  const errorPanel = page.locator('.play-error-panel');
  await expect(errorPanel.getByRole('button', { name: 'Retry Auto' })).toHaveCount(0);
  await expect(errorPanel.getByRole('button', { name: 'Back to Library' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Virtual Pad Unavailable' })).toBeVisible();

  await page.screenshot({ path: 'artifacts/play-pass7-error-desktop.png' });

  await page.getByRole('button', { name: 'Open Recovery Menu' }).click();
  await expect(page.locator('.play-side-menu.open')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Recovery' })).toBeVisible();

  await page.keyboard.press('t');
  await expect(page.getByRole('heading', { name: 'Unable to start this ROM' })).toHaveCount(0);

  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const phonePage = await phoneContext.newPage();
  await phonePage.goto('/play/rom-missing-e2e');
  await expect(phonePage.getByRole('heading', { name: 'Unable to start this ROM' })).toBeVisible({ timeout: 20_000 });
  const phoneErrorPanel = phonePage.locator('.play-error-panel');
  await expect(phoneErrorPanel.getByRole('button', { name: 'Retry Auto' })).toHaveCount(0);
  await expect(phoneErrorPanel.getByRole('button', { name: 'Back to Library' })).toBeVisible();
  await phoneErrorPanel.getByRole('button', { name: 'Open Recovery Menu' }).click();
  const phoneSideMenu = phonePage.locator('.play-side-menu.open');
  await expect(phoneSideMenu).toBeVisible();
  await expect(phoneSideMenu.getByRole('heading', { name: 'Game Menu' })).toBeVisible();
  await expect(phonePage.getByRole('heading', { name: 'Game Menu' })).toHaveCount(1);
  const phoneViewport = phonePage.viewportSize();
  expect(phoneViewport).not.toBeNull();
  await expect
    .poll(async () => (await phoneSideMenu.boundingBox())?.x ?? Number.POSITIVE_INFINITY, {
      timeout: 4_000,
    })
    .toBeLessThanOrEqual(2);
  await expect
    .poll(async () => (await phoneSideMenu.boundingBox())?.y ?? Number.POSITIVE_INFINITY, {
      timeout: 4_000,
    })
    .toBeLessThanOrEqual(2);
  await expect
    .poll(async () => (await phoneSideMenu.boundingBox())?.width ?? 0, {
      timeout: 4_000,
    })
    .toBeGreaterThanOrEqual((phoneViewport?.width ?? 390) - 4);
  await expect
    .poll(async () => (await phoneSideMenu.boundingBox())?.height ?? 0, {
      timeout: 4_000,
    })
    .toBeGreaterThanOrEqual((phoneViewport?.height ?? 844) - 24);
  await phonePage.screenshot({ path: 'artifacts/play-pass7-error-phone.png' });
  await phoneContext.close();
});
