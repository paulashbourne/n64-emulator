import { expect, test } from '@playwright/test';

test('host can create an invite code and a second player can join', async ({ page, browser }) => {
  await page.goto('/online');
  await page.getByLabel('Host Name').fill('HostUser');
  await page.getByRole('button', { name: 'Start Online Game' }).click();

  const heading = page.getByRole('heading', { name: /Online Session/ });
  await expect(heading).toBeVisible({ timeout: 15_000 });

  const headingText = (await heading.textContent()) ?? '';
  const inviteCodeMatch = headingText.match(/Online Session ([A-Z0-9]{6})/);
  expect(inviteCodeMatch).toBeTruthy();
  const inviteCode = inviteCodeMatch![1];

  const guestContext = await browser.newContext();
  const guestPage = await guestContext.newPage();
  await guestPage.goto('/online');
  await guestPage.getByLabel('Your Name').fill('GuestTwo');
  await guestPage.getByLabel('Invite Code').fill(inviteCode);
  await guestPage.getByRole('button', { name: 'Join by Invite Code' }).click();

  await expect(guestPage.getByText('You are Player 2')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Player 2:\s*GuestTwo/)).toBeVisible({ timeout: 15_000 });

  await guestPage.getByRole('button', { name: 'A', exact: true }).click();
  await expect(page.getByText('Player 2 (GuestTwo)')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('"control":"a"')).toBeVisible({ timeout: 15_000 });

  await guestContext.close();
});
