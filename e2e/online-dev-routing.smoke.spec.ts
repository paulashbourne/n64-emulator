import { expect, test } from '@playwright/test';

test('dev multiplayer websocket URL routes directly to coordinator', async ({ page }) => {
  await page.goto('/online');

  const wsUrl = await page.evaluate(async () => {
    const apiModule = await import('/src/online/multiplayerApi.ts');
    return apiModule.multiplayerSocketUrl('abc123', 'client-1');
  });

  expect(wsUrl).toContain('ws://127.0.0.1:8787/ws/multiplayer');
  expect(wsUrl).toContain('code=ABC123');
  expect(wsUrl).toContain('clientId=client-1');
});
