import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { I18n } from '../core/i18n';
import { ApiError, destinations } from '../core/reliability';
import { MemoryStorage, flush, item, items } from '../core/reliability/testing/fakes';
import { conversation, sleep, testChat, type TestChat } from '../testing/chat-test-deps';
import { CustomerPage } from './customer-page';

const C = 42;
const TOPIC = destinations.conversationTopic(C);

async function render(t: TestChat): Promise<ComponentFixture<CustomerPage>> {
  TestBed.configureTestingModule({ imports: [CustomerPage], providers: t.providers });
  TestBed.inject(I18n).lang.set('fr');
  const fixture = TestBed.createComponent(CustomerPage);
  await settle(fixture);
  return fixture;
}

async function settle(fixture: ComponentFixture<unknown>): Promise<void> {
  fixture.detectChanges();
  await flush();
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
}

const q = <T extends Element = HTMLElement>(f: ComponentFixture<unknown>, sel: string) => (f.nativeElement as HTMLElement).querySelector<T & HTMLElement>(sel);
const qa = (f: ComponentFixture<unknown>, sel: string) => [...(f.nativeElement as HTMLElement).querySelectorAll<HTMLElement>(sel)];
const text = (f: ComponentFixture<unknown>, sel: string) => q(f, sel)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

/** Opens conversation C through the form and brings the connection to ready with `history` items. */
async function openAndConnect(t: TestChat, f: ComponentFixture<CustomerPage>, history = 0, instance = 'chat-1') {
  q<HTMLButtonElement>(f, '[data-testid="open"]')!.click();
  await settle(f);
  await t.api.answer('openConversation', conversation(C));
  await settle(f);
  t.transport.connected(instance);
  t.transport.receiptAll();
  await flush();
  await t.api.replyMessages({ items: history ? items(C, 1, history) : [], hasMore: false });
  await settle(f);
}

describe('CustomerPage', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('starts the session as customer and shows the labelled open form', async () => {
    const t = testChat();
    const f = await render(t);
    expect(t.roles).toEqual(['customer']);
    const input = q<HTMLInputElement>(f, '#reservation')!;
    expect(q(f, 'label[for="reservation"]')?.textContent).toContain('Référence de réservation');
    expect(input.getAttribute('aria-describedby')).toBe('reservation-hint');
  });

  it('opens with a clientRequestId and the reservation reference, then subscribes with a receipt (A6)', async () => {
    const t = testChat();
    const f = await render(t);
    const input = q<HTMLInputElement>(f, '#reservation')!;
    input.value = ' YCYW-2026-000123 ';
    input.dispatchEvent(new Event('input'));
    q<HTMLButtonElement>(f, '[data-testid="open"]')!.click();
    await settle(f);
    const [requestId, ref] = await t.api.answer('openConversation', conversation(C, { reservationReference: 'YCYW-2026-000123' }));
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(ref).toBe('YCYW-2026-000123');
    await settle(f);
    t.transport.connected();
    expect(t.transport.receiptFor(TOPIC)).toBeTruthy();
    expect(text(f, '[data-testid="conversation-status"]')).toContain('En attente d’un conseiller');
    expect(t.storage.getItem('ycyw.chat.customer.conversation.v1')).toBe(String(C));
  });

  it('a failed open is retried with the SAME clientRequestId (A6)', async () => {
    const t = testChat();
    const f = await render(t);
    q<HTMLButtonElement>(f, '[data-testid="open"]')!.click();
    await settle(f);
    const [first] = await t.api.answer('openConversation', new ApiError(502, 'HTTP_502'), true);
    await settle(f);
    expect(q(f, '[role="alert"]')?.textContent).toContain('n’a pas pu être ouverte');
    q<HTMLButtonElement>(f, '[data-testid="open"]')!.click();
    await settle(f);
    const [second] = await t.api.answer('openConversation', conversation(C));
    expect(second).toBe(first);
  });

  it('message log is role=log aria-live=polite; the status region is a separate role=status', async () => {
    const t = testChat();
    const f = await render(t);
    await openAndConnect(t, f);
    await sleep(350);
    await settle(f);
    const log = q(f, '[data-testid="message-log"]')!;
    expect(log.getAttribute('role')).toBe('log');
    expect(log.getAttribute('aria-live')).toBe('polite');
    const status = q(f, '[data-testid="status-region"]')!;
    expect(status.getAttribute('role')).toBe('status');
    expect(log.contains(status)).toBe(false);
  });

  it('C4: a backfilled batch is inserted with the log live region off, then restored; only the count is announced', async () => {
    const t = testChat();
    const f = await render(t);
    await openAndConnect(t, f, 2);
    await sleep(350);
    await settle(f);
    // instance killed: lost, then reconnect + backfill of 3 missed items
    t.transport.drop();
    await settle(f);
    await sleep(150);
    await settle(f);
    expect(text(f, '[data-testid="status-region"]')).toBe('Connexion perdue. Reconnexion en cours…');
    await t.clock.advance(500); // backoff with real jitter: ≤ 500 ms
    t.transport.connected('chat-2');
    t.transport.receiptAll();
    await flush();
    await t.api.replyMessages({ items: items(C, 3, 5), hasMore: false });
    await settle(f);
    const log = q(f, '[data-testid="message-log"]')!;
    expect(qa(f, '[data-testid="message"]').length).toBe(5);
    expect(log.getAttribute('aria-live')).toBe('off');
    await sleep(350);
    await settle(f);
    expect(log.getAttribute('aria-live')).toBe('polite');
    expect(text(f, '[data-testid="status-region"]')).toBe('Connexion rétablie, 3 messages récupérés');
  });

  it('live items keep the log polite (announced one by one)', async () => {
    const t = testChat();
    const f = await render(t);
    await openAndConnect(t, f);
    await sleep(350);
    await settle(f);
    t.transport.message(TOPIC, item(C, 1, { content: 'Bonjour, je regarde votre dossier.' }));
    await settle(f);
    expect(q(f, '[data-testid="message-log"]')!.getAttribute('aria-live')).toBe('polite');
    expect(text(f, '[data-testid="message"]')).toContain('Conseiller : Bonjour, je regarde votre dossier.');
  });

  it('C2: own message shows envoi… → envoyé → replaced by the stream item', async () => {
    const t = testChat();
    const f = await render(t);
    await openAndConnect(t, f);
    const box = q<HTMLTextAreaElement>(f, '[data-testid="composer"]')!;
    box.value = 'Ma voiture est absente';
    box.dispatchEvent(new Event('input'));
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await settle(f);
    const sent = t.transport.publishes().at(-1)!;
    expect(sent.body.content).toBe('Ma voiture est absente');
    expect(text(f, '[data-testid="echo-status"]')).toBe('envoi…');
    expect(box.value).toBe('');
    t.transport.message(destinations.acks, { conversationId: C, clientMessageId: sent.body.clientMessageId, seq: 1 });
    await settle(f);
    expect(text(f, '[data-testid="echo-status"]')).toBe('envoyé');
    t.transport.message(TOPIC, item(C, 1, { clientMessageId: sent.body.clientMessageId, senderRole: 'client', senderRef: 'customer-1', content: 'Ma voiture est absente' }));
    await settle(f);
    expect(qa(f, '[data-testid="message"]').length).toBe(1);
    expect(q(f, '[data-testid="echo-status"]')).toBeNull();
    expect(text(f, '[data-testid="message"]')).toContain('Vous : Ma voiture est absente');
  });

  it('C2: an error marks the message "non envoyé" and announces it', async () => {
    const t = testChat();
    const f = await render(t);
    await openAndConnect(t, f);
    const box = q<HTMLTextAreaElement>(f, '[data-testid="composer"]')!;
    box.value = 'trop tard';
    box.dispatchEvent(new Event('input'));
    q<HTMLButtonElement>(f, '[data-testid="send"]')!.click();
    await settle(f);
    const id = t.transport.publishes().at(-1)!.body.clientMessageId;
    t.transport.message(destinations.errors, { conversationId: C, clientMessageId: id, code: 'CONVERSATION_CLOSED', reason: 'x' });
    await settle(f);
    expect(text(f, '[data-testid="echo-status"]')).toBe('non envoyé (la conversation est clôturée)');
    await sleep(150);
    await settle(f);
    expect(text(f, '[data-testid="status-region"]')).toBe('Message non envoyé : la conversation est clôturée');
  });

  it('Shift+Enter does not send; empty input shows a linked error', async () => {
    const t = testChat();
    const f = await render(t);
    await openAndConnect(t, f);
    const box = q<HTMLTextAreaElement>(f, '[data-testid="composer"]')!;
    box.value = 'ligne 1';
    box.dispatchEvent(new Event('input'));
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true }));
    await settle(f);
    expect(t.transport.publishes()).toEqual([]);
    box.value = '   ';
    box.dispatchEvent(new Event('input'));
    q<HTMLButtonElement>(f, '[data-testid="send"]')!.click();
    await settle(f);
    const err = q(f, '[data-testid="composer-error"]')!;
    expect(err.textContent).toContain('Le message est vide.');
    expect(box.getAttribute('aria-invalid')).toBe('true');
    expect(box.getAttribute('aria-describedby')).toContain(err.id);
  });

  it('badge shows the instance, "déconnecté" while reconnecting, then the new instance (C5)', async () => {
    const t = testChat();
    const f = await render(t);
    await openAndConnect(t, f, 0, 'chat-1');
    expect(text(f, '[data-testid="instance-badge"]')).toBe('Instance : chat-1');
    t.transport.drop();
    await settle(f);
    expect(text(f, '[data-testid="instance-badge"]')).toBe('Instance : déconnecté');
    expect(text(f, '[data-testid="connection-state"]')).toBe('Connexion perdue, nouvelle tentative…');
    await t.clock.advance(500); // backoff with real jitter: ≤ 500 ms
    t.transport.connected('chat-2');
    await settle(f);
    expect(text(f, '[data-testid="instance-badge"]')).toBe('Instance : chat-2');
    expect(t.transport.connects().map((c) => c.url)).toEqual(['/ws-a', '/ws']);
  });

  it('close appends the cloture event, disables the composer and offers a new conversation', async () => {
    const t = testChat();
    const f = await render(t);
    await openAndConnect(t, f);
    q<HTMLButtonElement>(f, '[data-testid="close"]')!.click();
    await settle(f);
    await t.api.answer('close', conversation(C, { status: 'cloturee' }));
    t.transport.message(TOPIC, item(C, 1, { type: 'cloture', senderRole: 'systeme', senderRef: 'customer-1', content: null }));
    await settle(f);
    expect(text(f, '[data-testid="conversation-status"]')).toContain('Clôturée');
    expect(q(f, '[data-testid="composer"]')).toBeNull();
    expect(text(f, '[data-testid="message"]')).toContain('Conversation clôturée par vous.');
    q<HTMLButtonElement>(f, '[data-testid="new-conversation"]')!.click();
    await settle(f);
    expect(q(f, '#reservation')).not.toBeNull();
    expect(t.storage.getItem('ycyw.chat.customer.conversation.v1')).toBeNull();
  });

  it('reload: restores the conversation and resends unacked messages with the same id, outbox keyed per identity (O11)', async () => {
    const storage = new MemoryStorage();
    const t1 = testChat('customer-1', storage);
    const f1 = await render(t1);
    await openAndConnect(t1, f1);
    const box = q<HTMLTextAreaElement>(f1, '[data-testid="composer"]')!;
    box.value = 'avant reload';
    box.dispatchEvent(new Event('input'));
    q<HTMLButtonElement>(f1, '[data-testid="send"]')!.click();
    await settle(f1);
    const id = t1.transport.publishes().at(-1)!.body.clientMessageId;
    expect([...storage.map.keys()]).toContain('ycyw.chat.outbox.customer.customer-1.v1');
    f1.destroy();
    TestBed.resetTestingModule();

    const t2 = testChat('customer-1', storage);
    const f2 = await render(t2);
    expect(await t2.api.answer('getConversation', conversation(C))).toEqual([C]);
    await settle(f2);
    t2.transport.connected();
    expect(t2.transport.publishes().map((p) => p.body.clientMessageId)).toEqual([id]);
    expect(text(f2, '[data-testid="echo-status"]')).toBe('envoi…');
  });

  it('another identity in the same tab does not see or resend the previous outbox', async () => {
    const storage = new MemoryStorage();
    storage.setItem('ycyw.chat.outbox.customer.customer-1.v1', JSON.stringify([{ conversationId: C, clientMessageId: 'x', content: 'old', createdAt: 0 }]));
    const t = testChat('customer-2', storage);
    await render(t);
    t.transport.connected();
    expect(t.transport.publishes()).toEqual([]);
  });
});
