import { execFileSync } from 'node:child_process';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

/** docker compose on the stack under test (COMPOSE_FILE / COMPOSE_PROJECT_NAME come from the Makefile). */
export function compose(...args: string[]): string {
  const base = ['compose'];
  if (process.env.COMPOSE_FILE) base.push('-f', process.env.COMPOSE_FILE);
  return execFileSync('docker', [...base, ...args], { encoding: 'utf8' });
}

export function health(service: string): string {
  for (const line of compose('ps', '--all', '--format', 'json', service).split('\n').filter(Boolean)) {
    const row = JSON.parse(line) as { Service?: string; Health?: string; State?: string };
    if (row.Service === service) return row.Health || row.State || 'unknown';
  }
  return 'missing';
}

export async function waitHealthy(service: string, timeoutMs = 120_000): Promise<void> {
  const t0 = Date.now();
  while (health(service) !== 'healthy') {
    if (Date.now() - t0 > timeoutMs) throw new Error(`${service} not healthy after ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** T2: fail on serious/critical axe violations (WCAG 2.x A/AA rules). */
export async function expectNoSeriousA11yViolations(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(
    serious.map((v) => `${v.impact} ${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
    `axe serious/critical violations on ${label}`,
  ).toEqual([]);
}

/** Collects console errors and uncaught exceptions of a page. */
export function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}
