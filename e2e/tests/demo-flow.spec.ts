import { expect, test, type Browser, type Page } from '@playwright/test';
import { compose, expectNoSeriousA11yViolations, waitHealthy } from './support.ts';

// T2: the README demo, end to end on the real stack (make up):
// customer pinned to chat-1 (?node=a), agent to chat-2 (?node=b); they exchange a message; chat-1 is
// killed; the customer reconnects through /ws (badge changes), sends again and the agent receives it.
// axe runs on both views in every state it reaches (fail on serious/critical).

test.describe.configure({ mode: 'serial' });

async function newPage(browser: Browser): Promise<Page> {
  // Separate contexts = separate sessionStorage = separate identities (customer vs agent).
  const context = await browser.newContext({ locale: 'fr-FR' });
  return context.newPage();
}

test.afterAll(async () => {
  // Leave the stack as we found it for the next specs / the chaos job.
  compose('start', 'chat-1');
  await waitHealthy('chat-1');
});

test('customer ↔ agent across instances, kill chat-1, nothing lost', async ({ browser }) => {
  test.setTimeout(180_000);
  await waitHealthy('chat-1');
  await waitHealthy('chat-2');

  const customer = await newPage(browser);
  const agent = await newPage(browser);
  const customerBadge = customer.getByTestId('instance-badge');
  const agentBadge = agent.getByTestId('instance-badge');

  // --- customer opens a conversation on chat-1
  await customer.goto('/?node=a&lang=fr');
  await expect(customer.getByRole('heading', { level: 1 })).toHaveText('Contacter le support');
  await expectNoSeriousA11yViolations(customer, 'customer / open form');
  await customer.getByLabel('Référence de réservation (facultatif)').fill('YCYW-2026-000123');
  await customer.getByRole('button', { name: 'Démarrer la conversation' }).click();
  const title = customer.getByRole('heading', { level: 2, name: /^Conversation n° \d+$/ });
  await expect(title).toBeVisible();
  const conversationId = Number((await title.textContent())!.match(/\d+/)![0]);
  await expect(customerBadge).toHaveText('Instance : chat-1');
  await expect(customer.getByTestId('composer')).toBeFocused();

  // --- agent claims it from the queue on chat-2
  await agent.goto('/agent?node=b&lang=fr');
  await expect(agentBadge).toHaveText('Instance : chat-2');
  const claim = agent.getByRole('button', { name: `Prendre en charge la conversation n° ${conversationId}` });
  await expect(claim).toBeVisible();
  await expectNoSeriousA11yViolations(agent, 'agent / queue');
  await claim.click();
  await expect(agent.getByTestId('conversation-status')).toContainText('Prise en charge par un conseiller');
  await expect(customer.getByTestId('conversation-status')).toContainText('Prise en charge par un conseiller');

  // --- message crosses instances (chat-1 → chat-2), and back
  await customer.getByTestId('composer').fill('Bonjour, ma voiture est absente.');
  await customer.getByTestId('composer').press('Enter');
  await expect(agent.getByTestId('message-log')).toContainText('Client : Bonjour, ma voiture est absente.');
  await agent.getByTestId('composer').fill('Je regarde votre dossier.');
  await agent.getByTestId('composer').press('Enter');
  await expect(customer.getByTestId('message-log')).toContainText('Conseiller : Je regarde votre dossier.');
  await expect(customer.getByTestId('echo-status')).toHaveCount(0); // echo replaced by the stream item
  await expectNoSeriousA11yViolations(customer, 'customer / conversation');
  await expectNoSeriousA11yViolations(agent, 'agent / conversation');

  // --- kill the customer's instance
  compose('kill', 'chat-1');
  await expect(customerBadge).not.toHaveText('Instance : chat-1', { timeout: 15_000 });
  await expect(customerBadge).toHaveText('Instance : chat-2', { timeout: 30_000 });
  await expect(customer.getByTestId('status-region')).toHaveText(/^Connexion rétablie/, { timeout: 30_000 });

  // --- customer sends again; the agent (never disconnected, on chat-2) receives it
  await customer.getByTestId('composer').fill('Toujours là ?');
  await customer.getByTestId('composer').press('Enter');
  await expect(agent.getByTestId('message-log')).toContainText('Client : Toujours là ?');
  await expect(customer.getByTestId('echo-status')).toHaveCount(0);

  // --- no loss, no duplicate, order kept on both sides
  const texts = async (p: Page) => (await p.getByTestId('message').allTextContents()).map((t) => t.replace(/\s+/g, ' ').trim());
  for (const [p, own, other] of [
    [customer, 'Vous', 'Conseiller'],
    [agent, 'Client', 'Vous'],
  ] as const) {
    const list = await texts(p);
    const i1 = list.findIndex((t) => t.startsWith(`${own} : Bonjour, ma voiture est absente.`));
    const i2 = list.findIndex((t) => t.startsWith(`${other} : Je regarde votre dossier.`));
    const i3 = list.findIndex((t) => t.startsWith(`${own} : Toujours là ?`));
    expect([i1 >= 0, i1 < i2, i2 < i3], `order on ${own === 'Vous' ? 'customer' : 'agent'}: ${list.join(' | ')}`).toEqual([true, true, true]);
    expect(new Set(list).size, 'no duplicate entries').toBe(list.length);
  }
  await expect(agentBadge).toHaveText('Instance : chat-2');
  await expectNoSeriousA11yViolations(customer, 'customer / after reconnect');
});
