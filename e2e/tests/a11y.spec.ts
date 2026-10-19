import { expect, test } from '@playwright/test';
import { expectNoSeriousA11yViolations } from './support.ts';

// T2: axe on both views as first rendered, in both languages (stateful screens are scanned in
// demo-flow.spec.ts). Plus the structural a11y contract a scan cannot check by itself.
for (const lang of ['fr', 'en'] as const) {
  test(`customer view (${lang}): axe + labelled form`, async ({ page }) => {
    await page.goto(`/?lang=${lang}`);
    await expect(page.locator('html')).toHaveAttribute('lang', lang);
    await expect(page.getByTestId('instance-badge')).toBeVisible();
    await expect(page.locator('#reservation')).toBeVisible();
    await expectNoSeriousA11yViolations(page, `customer (${lang})`);
    await expect(page.getByRole('status')).toHaveCount(1);
  });

  test(`agent view (${lang}): axe + queue`, async ({ page }) => {
    await page.goto(`/agent?lang=${lang}`);
    await expect(page.getByTestId('queue-count')).toBeVisible();
    await expectNoSeriousA11yViolations(page, `agent (${lang})`);
  });
}

test('keyboard: the first Tab stops are the language switch then the reservation field', async ({ page }) => {
  await page.goto('/?lang=fr');
  await expect(page.locator('#reservation')).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Switch to English' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('#reservation')).toBeFocused();
});
