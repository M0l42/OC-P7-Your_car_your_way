import { expect, test } from '@playwright/test';

// Scaffold smoke test: the SPA is served through nginx. Frontend adds the axe scans and the kill/reconnect E2E (T2).
test('chat-web is served through nginx', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('h1')).toBeVisible();
});
