import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { I18n } from '../core/i18n';
import { ApiError, destinations } from '../core/reliability';
import { flush, item } from '../core/reliability/testing/fakes';
import { conversation, sleep, testChat, type TestChat } from '../testing/chat-test-deps';
import { AgentPage } from './agent-page';

async function settle(f: ComponentFixture<unknown>): Promise<void> {
  f.detectChanges();
  await flush();
  f.detectChanges();
  await f.whenStable();
  f.detectChanges();
}
const q = (f: ComponentFixture<unknown>, sel: string) => (f.nativeElement as HTMLElement).querySelector<HTMLElement>(sel);
const qa = (f: ComponentFixture<unknown>, sel: string) => [...(f.nativeElement as HTMLElement).querySelectorAll<HTMLElement>(sel)];
const text = (f: ComponentFixture<unknown>, sel: string) => q(f, sel)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

/** Renders the agent page, answers "my conversations", connects and loads the queue. */
async function ready(t: TestChat, queue = [conversation(1), conversation(2, { reservationReference: 'YCYW-9' })], total = queue.length, mine: ReturnType<typeof conversation>[] = []) {
  TestBed.configureTestingModule({ imports: [AgentPage], providers: t.providers });
  TestBed.inject(I18n).lang.set('fr');
  const f = TestBed.createComponent(AgentPage);
  await settle(f);
  await t.api.answer('myConversations', { items: mine, total: mine.length });
  t.transport.connected('chat-2');
  t.transport.receiptAll();
  await flush();
  while (t.api.queueCalls.length) await t.api.replyQueue({ items: queue, total });
  while (t.api.messageCalls.length) await t.api.replyMessages({ items: [], hasMore: false });
  await settle(f);
  return f;
}

describe('AgentPage', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('starts as agent, subscribes /topic/queue with a receipt and shows the oldest items + total', async () => {
    const t = testChat('agent-1');
    const f = await ready(t, [conversation(1), conversation(2, { reservationReference: 'YCYW-9' })], 73);
    expect(t.roles).toEqual(['agent']);
    expect(t.transport.receiptFor(destinations.queueTopic)).toBeTruthy();
    expect(text(f, '[data-testid="queue-count"]')).toBe('2 affichées sur 73 en attente');
    expect(qa(f, '[data-testid="queue-item"]').map((li) => li.querySelector('span')!.textContent)).toEqual([
      'Conversation n° 1',
      'Conversation n° 2, réservation YCYW-9',
    ]);
    const btn = q(f, '[data-testid="queue-item"] button')!;
    expect(btn.getAttribute('aria-label')).toBe('Prendre en charge la conversation n° 1');
    expect(btn.textContent!.trim()).toBe('Prendre en charge');
  });

  it('queue events trigger a refetch that replaces the list', async () => {
    const t = testChat('agent-1');
    const f = await ready(t);
    t.transport.message(destinations.queueTopic, { t: 'claimed', conversationId: 1 });
    await t.api.replyQueue({ items: [conversation(2)], total: 1 });
    await settle(f);
    expect(qa(f, '[data-testid="queue-item"]').length).toBe(1);
    expect(text(f, '[data-testid="queue-count"]')).toBe('1 en attente');
  });

  it('claim 200 → leaves the queue, opens the conversation, subscribes with receipt, announces', async () => {
    const t = testChat('agent-1');
    const f = await ready(t);
    q(f, '[data-testid="queue-item"] button')!.click();
    await settle(f);
    expect(await t.api.answer('claim', conversation(1, { status: 'en_cours', agentRef: 'agent-1' }))).toEqual([1]);
    await settle(f);
    expect(qa(f, '[data-testid="queue-item"]').length).toBe(1);
    expect(text(f, '[data-testid="mine-item"]')).toBe('Conversation n° 1 — Prise en charge par un conseiller');
    expect(q(f, '[data-testid="mine-item"]')!.getAttribute('aria-current')).toBe('true');
    expect(t.transport.receiptFor(destinations.conversationTopic(1))).toBeTruthy();
    await sleep(150);
    await settle(f);
    expect(text(f, '[data-testid="status-region"]')).toBe('Conversation n° 1 prise en charge');
  });

  it('claim + history load in the same moment are announced together, not overwritten', async () => {
    const t = testChat('agent-1');
    const f = await ready(t);
    q(f, '[data-testid="queue-item"] button')!.click();
    await settle(f);
    await t.api.answer('claim', conversation(1, { status: 'en_cours', agentRef: 'agent-1' }));
    t.transport.receipt(t.transport.receiptFor(destinations.conversationTopic(1)));
    await flush();
    await t.api.replyMessages({ items: [item(1, 1, { type: 'prise_en_charge', senderRole: 'systeme', content: null })], hasMore: false });
    await sleep(150);
    await settle(f);
    expect(text(f, '[data-testid="status-region"]')).toBe('Conversation n° 1 prise en charge. 1 message chargé');
  });

  it('claim 409 ALREADY_CLAIMED → removed from the queue, announced, queue refetched', async () => {
    const t = testChat('agent-1');
    const f = await ready(t);
    q(f, '[data-testid="queue-item"] button')!.click();
    await settle(f);
    await t.api.answer('claim', new ApiError(409, 'ALREADY_CLAIMED'), true);
    await settle(f);
    expect(qa(f, '[data-testid="queue-item"]').length).toBe(1);
    expect(q(f, '[data-testid="mine-item"]')).toBeNull();
    expect(t.api.queueCalls.length).toBe(1);
    await sleep(150);
    await settle(f);
    expect(text(f, '[data-testid="status-region"]')).toBe('Conversation n° 1 déjà prise en charge par un autre conseiller');
  });

  it('agent messages are "Vous", customer messages "Client"; customer close shows the event', async () => {
    const t = testChat('agent-1');
    const held = conversation(5, { status: 'en_cours', agentRef: 'agent-1' });
    const f = await ready(t, [], 0, [held]);
    const topic = destinations.conversationTopic(5);
    t.transport.message(topic, item(5, 1, { type: 'prise_en_charge', senderRole: 'systeme', senderRef: 'agent-1', content: null }));
    t.transport.message(topic, item(5, 2, { senderRole: 'client', senderRef: 'customer-1', content: 'Bonjour' }));
    t.transport.message(topic, item(5, 3, { senderRole: 'agent', senderRef: 'agent-1', content: 'Je regarde' }));
    t.transport.message(topic, item(5, 4, { type: 'cloture', senderRole: 'systeme', senderRef: 'customer-1', content: null }));
    await settle(f);
    expect(qa(f, '[data-testid="message"]').map((m) => m.textContent!.replace(/\s+/g, ' ').trim().replace(/ ?\d\d:\d\d$/, ''))).toEqual([
      'Un conseiller a pris en charge la conversation.',
      'Client : Bonjour',
      'Vous : Je regarde',
      'Conversation clôturée par client.',
    ]);
    expect(text(f, '[data-testid="conversation-status"]')).toContain('Clôturée');
    expect(q(f, '[data-testid="composer"]')).toBeNull();
  });

  it('restores held conversations on load (reload) and selects the first', async () => {
    const t = testChat('agent-1');
    const f = await ready(t, [], 0, [conversation(7, { status: 'en_cours', agentRef: 'agent-1' })]);
    expect(text(f, '[data-testid="mine-item"]')).toContain('Conversation n° 7');
    expect(text(f, '[data-testid="conversation-status"]')).toContain('Prise en charge');
    expect(text(f, '[data-testid="queue-count"]')).toBe('Aucune conversation en attente');
  });
});
