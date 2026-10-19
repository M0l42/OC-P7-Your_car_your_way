import { expect, test } from '@playwright/test';

// Scaffold smoke tests: both views are served through nginx and load without console errors.
// Frontend adds the axe scans and the kill/reconnect E2E (T2); keep the console-error guard.
for (const path of ['/', '/?node=a', '/agent', '/agent?node=b']) {
  test(`${path} loads without console errors`, async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto(path);
    await expect(page.locator('h1')).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(errors).toEqual([]);
  });
}
