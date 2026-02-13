import { expect, test } from '@playwright/test';

test('reopening an expired host session creates a fresh host room', async ({ page, request }) => {
  await page.goto('/online');
  await page.getByLabel('Host Name').fill('FallbackHost');
  await page.getByRole('button', { name: 'Start Online Game' }).click();

  const heading = page.getByRole('heading', { name: /Online Session/ });
  await expect(heading).toBeVisible({ timeout: 15_000 });

  const headingText = (await heading.textContent()) ?? '';
  const inviteCodeMatch = headingText.match(/Online Session ([A-Z0-9]{6})/);
  expect(inviteCodeMatch).toBeTruthy();
  const oldCode = inviteCodeMatch![1];

  const currentUrl = new URL(page.url());
  const hostClientId = currentUrl.searchParams.get('clientId');
  expect(hostClientId).toBeTruthy();

  const closeResponse = await request.post(
    `http://127.0.0.1:8787/api/multiplayer/sessions/${oldCode}/close`,
    {
      data: {
        clientId: hostClientId,
      },
    },
  );
  expect(closeResponse.ok()).toBeTruthy();

  await page.getByRole('link', { name: 'Back to Online' }).click();
  await expect(page.getByRole('heading', { name: 'Recent Sessions' })).toBeVisible({ timeout: 15_000 });

  await page
    .locator('.recent-session-list li')
    .filter({ hasText: oldCode })
    .getByRole('button', { name: 'Reopen' })
    .click();

  const reopenedHeading = page.getByRole('heading', { name: /Online Session/ });
  await expect(reopenedHeading).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('You are Player 1 (Host)')).toBeVisible({ timeout: 15_000 });

  const reopenedHeadingText = (await reopenedHeading.textContent()) ?? '';
  const reopenedCodeMatch = reopenedHeadingText.match(/Online Session ([A-Z0-9]{6})/);
  expect(reopenedCodeMatch).toBeTruthy();
  expect(reopenedCodeMatch![1]).not.toBe(oldCode);
});
