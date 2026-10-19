import { ChatClient, type ChatClientOptions, type ChatEvent } from './chat-client';
import { OUTBOX_STORAGE_KEY } from './outbox';
import { destinations } from './protocol';
import { FakeApi, FakeClock, FakeTokens, FakeTransport, MemoryStorage, flush, idSequence, item, items } from './testing/fakes';

const C = 42;
const TOPIC = destinations.conversationTopic(C);

function setup(over: Partial<ChatClientOptions> = {}) {
  const transport = new FakeTransport();
  const api = new FakeApi();
  const clock = new FakeClock();
  const tokens = new FakeTokens();
  const storage = (over.storage as MemoryStorage | undefined) ?? new MemoryStorage();
  const client = new ChatClient({
    transport,
    api,
    tokens,
    clock,
    storage,
    urls: { first: '/ws-a', reconnect: '/ws' },
    random: () => 0, // backoff = ceiling / 2: 250, 500, 1000 … ms
    newId: idSequence('cm'),
    wallClock: () => 0,
    ...over,
  });
  const events: ChatEvent[] = [];
  client.on((e) => events.push(e));
  const of = <T extends ChatEvent['type']>(type: T) => events.filter((e): e is Extract<ChatEvent, { type: T }> => e.type === type);
  return { transport, api, clock, tokens, storage, client, events, of };
}

/** start + CONNECTED on the given instance (no receipts answered yet). */
async function connect(s: ReturnType<typeof setup>, instance = 'chat-1') {
  if (s.client.state === 'idle') s.client.start();
  await flush();
  s.transport.connected(instance);
}

/** start, CONNECTED, all receipts, and answer the post-receipt backfill with `history`. */
async function connectReady(s: ReturnType<typeof setup>, history = 0, instance = 'chat-1') {
  await connect(s, instance);
  s.transport.receiptAll();
  await flush();
  while (s.api.messageCalls.length) {
    await s.api.replyMessages({ items: history ? items(C, s.client.lastSeq(C) + 1, history) : [], hasMore: false });
  }
  while (s.api.queueCalls.length) await s.api.replyQueue({ items: [], total: 0 });
}

describe('ChatClient — connect, subscribe, receipt (A1/O7)', () => {
  it('subscribes acks/errors without receipt and the topic with one, then goes ready on RECEIPT', async () => {
    const s = setup();
    s.client.watchConversation(C);
    await connect(s);
    const subs = s.transport.sinceConnect().filter((c) => c.op === 'subscribe');
    expect(subs.map((c) => (c.op === 'subscribe' ? [c.destination, !!c.receiptId] : null))).toEqual([
      ['/user/queue/acks', false],
      ['/user/queue/errors', false],
      [TOPIC, true],
    ]);
    expect(s.client.state).toBe('subscribing');
    s.transport.receipt(s.transport.receiptFor(TOPIC));
    expect(s.client.state).toBe('ready');
    expect(s.client.instanceId).toBe('chat-1');
  });

  it('backfill starts only after the RECEIPT, from lastSeq', async () => {
    const s = setup();
    s.client.watchConversation(C);
    await connect(s);
    expect(s.api.messageCalls.length).toBe(0);
    s.transport.receiptAll();
    await flush();
    expect(s.api.messageCalls.map((c) => [c.conversationId, c.afterSeq])).toEqual([[C, 0]]);
  });

  it('no RECEIPT within 5 s → closes and reconnects', async () => {
    const s = setup();
    s.client.watchConversation(C);
    await connect(s);
    await s.clock.advance(4999);
    expect(s.transport.connects().length).toBe(1);
    await s.clock.advance(1);
    expect(s.transport.calls.at(-1)).toEqual({ op: 'close' });
    expect(s.client.state).toBe('waiting');
    await s.clock.advance(250);
    expect(s.transport.connects().length).toBe(2);
  });

  it('a RECEIPT just in time cancels the timeout', async () => {
    const s = setup();
    s.client.watchConversation(C);
    await connect(s);
    await s.clock.advance(4999);
    s.transport.receiptAll();
    await s.clock.advance(10_000);
    expect(s.transport.connects().length).toBe(1);
    expect(s.client.state).toBe('ready');
  });

  it('safety-net backfill 2 s after every (re)subscribe', async () => {
    const s = setup();
    s.client.watchConversation(C);
    await connectReady(s);
    await s.clock.advance(1999);
    expect(s.api.messageCalls.length).toBe(0);
    await s.clock.advance(1);
    expect(s.api.messageCalls.length).toBe(1);
    await s.api.replyMessages({ items: [], hasMore: false });
    // re-armed after a reconnect
    s.transport.drop();
    await s.clock.advance(250);
    await connectReady(s, 0, 'chat-2');
    await s.clock.advance(2000);
    expect(s.api.messageCalls.length).toBe(1);
  });

  it('safety net can be disabled (test 4e-style runs)', async () => {
    const s = setup({ safetyNet: false });
    s.client.watchConversation(C);
    await connectReady(s);
    await s.clock.advance(10_000);
    expect(s.api.messageCalls.length).toBe(0);
  });

  it('watching a conversation while connected subscribes with receipt, then backfills', async () => {
    const s = setup();
    await connectReady(s);
    s.client.watchConversation(C);
    expect(s.client.state).toBe('ready');
    s.transport.receipt(s.transport.receiptFor(TOPIC));
    await flush();
    expect(s.api.messageCalls.length).toBe(1);
  });

  it('SUBSCRIBE refused (NOT_FOUND with receipt-id) → conversation unwatched, no reconnect loop', async () => {
    const s = setup();
    s.client.watchConversation(C);
    await connect(s);
    s.transport.error('NOT_FOUND', s.transport.receiptFor(TOPIC));
    s.transport.drop();
    await s.clock.advance(250);
    await connect(s);
    expect(s.transport.sinceConnect().some((c) => c.op === 'subscribe' && c.destination === TOPIC)).toBe(false);
    expect(s.of('subscriptionRefused')).toEqual([{ type: 'subscriptionRefused', conversationId: C, code: 'NOT_FOUND' }]);
  });
});

describe('ChatClient — reconnect (C5, backoff, A5)', () => {
  it('first connection uses the pinned URL, every reconnect uses /ws', async () => {
    const s = setup();
    await connectReady(s);
    for (let i = 0; i < 3; i++) {
      s.transport.drop();
      await s.clock.advance(250); // backoff resets after each ready
      await connectReady(s);
    }
    expect(s.transport.connects().map((c) => c.url)).toEqual(['/ws-a', '/ws', '/ws', '/ws']);
  });

  it('a failed first attempt still moves on to /ws', async () => {
    const s = setup();
    s.client.start();
    await flush();
    s.transport.drop(); // handshake failed
    await s.clock.advance(250);
    expect(s.transport.connects().map((c) => c.url)).toEqual(['/ws-a', '/ws']);
  });

  it('exponential backoff while failing, reset after ready', async () => {
    const s = setup();
    s.client.start();
    await flush();
    const gaps: number[] = [];
    for (let i = 0; i < 4; i++) {
      const before = s.clock.now();
      const n = s.transport.connects().length;
      s.transport.drop();
      while (s.transport.connects().length === n) await s.clock.advance(1);
      gaps.push(s.clock.now() - before);
    }
    expect(gaps).toEqual([250, 500, 1000, 2000]);
    s.transport.connected();
    s.transport.drop();
    const before = s.clock.now();
    await s.clock.advance(250);
    expect(s.clock.now() - before).toBe(250);
    expect(s.transport.connects().length).toBe(6);
  });

  it('TOKEN_EXPIRED → renews via the token provider and reconnects immediately with the new token', async () => {
    const s = setup();
    s.client.start();
    await flush();
    s.transport.error('TOKEN_EXPIRED');
    s.transport.drop();
    expect(s.client.state).toBe('renewing');
    await s.clock.advance(0);
    expect(s.tokens.renewCalls).toBe(1);
    expect(s.transport.connects().map((c) => c.token)).toEqual(['token-1', 'token-2']);
  });

  it('repeated TOKEN_EXPIRED falls back to backoff (no hot loop)', async () => {
    const s = setup();
    s.client.start();
    await flush();
    s.transport.error('TOKEN_EXPIRED');
    s.transport.drop();
    await s.clock.advance(0);
    s.transport.error('TOKEN_EXPIRED');
    s.transport.drop();
    await s.clock.advance(0);
    expect(s.transport.connects().length).toBe(2);
    await s.clock.advance(250);
    expect(s.transport.connects().length).toBe(3);
    expect(s.tokens.renewCalls).toBe(2);
  });

  it('no CONNECTED within 10 s → closes the socket and reconnects', async () => {
    const s = setup();
    s.client.start();
    await flush();
    await s.clock.advance(9999);
    expect(s.transport.connects().length).toBe(1);
    await s.clock.advance(1);
    expect(s.transport.calls.at(-1)).toEqual({ op: 'close' });
    await s.clock.advance(250);
    expect(s.transport.connects().length).toBe(2);
  });

  it('CONNECTED in time cancels the connect timeout', async () => {
    const s = setup();
    await connectReady(s);
    await s.clock.advance(60_000);
    expect(s.transport.connects().length).toBe(1);
  });

  it('instance id is cleared while disconnected, then shows the new instance (badge, C5)', async () => {
    const s = setup();
    await connectReady(s, 0, 'chat-1');
    s.transport.drop();
    expect(s.client.instanceId).toBeNull();
    expect(s.of('state').at(-1)).toEqual({ type: 'state', state: 'waiting', instanceId: null });
    await s.clock.advance(250);
    await connectReady(s, 0, 'chat-2');
    expect(s.of('state').at(-1)).toEqual({ type: 'state', state: 'ready', instanceId: 'chat-2' });
  });

  it('UNAUTHORIZED → one renewal per outage, a second one is surfaced and backs off', async () => {
    const s = setup();
    s.client.start();
    await flush();
    s.transport.error('UNAUTHORIZED');
    s.transport.drop();
    await s.clock.advance(0);
    expect(s.tokens.renewCalls).toBe(1);
    expect(s.transport.connects().map((c) => c.token)).toEqual(['token-1', 'token-2']);
    s.transport.error('UNAUTHORIZED');
    s.transport.drop();
    expect(s.of('serverError')).toEqual([{ type: 'serverError', code: 'UNAUTHORIZED', detail: undefined }]);
    expect(s.client.state).toBe('waiting');
    await s.clock.advance(500);
    expect(s.transport.connects().length).toBe(3);
    expect(s.tokens.renewCalls).toBe(1);
  });

  it('late callbacks of a superseded connection are ignored', async () => {
    const s = setup();
    s.client.watchConversation(C);
    await connect(s);
    const staleReceipt = s.transport.receiptFor(TOPIC);
    await s.clock.advance(5000); // receipt timeout → reconnect
    await s.clock.advance(250);
    s.transport.connected('chat-2');
    s.transport.receipt(staleReceipt);
    expect(s.client.state).toBe('subscribing');
  });

  it('stop() closes and never reconnects', async () => {
    const s = setup();
    await connectReady(s);
    s.client.stop();
    await s.clock.advance(60_000);
    expect(s.transport.connects().length).toBe(1);
    expect(s.client.state).toBe('stopped');
  });
});

describe('ChatClient — recovery announcement (C4 count)', () => {
  it('lost once per outage, then restored with the number of backfilled items', async () => {
    const s = setup();
    s.client.watchConversation(C);
    await connectReady(s, 3);
    expect(s.of('connectionRestored')).toEqual([]); // first connection: nothing to announce
    s.transport.drop();
    await s.clock.advance(250);
    s.transport.drop(); // second failure in the same outage
    await s.clock.advance(500);
    expect(s.of('connectionLost').length).toBe(1);
    await connect(s, 'chat-2');
    // Live item before the RECEIPT: buffered (gap) and a gap fetch starts right away.
    s.transport.message(TOPIC, item(C, 6));
    expect(s.api.messageCalls.map((c) => c.afterSeq)).toEqual([3]);
    // The RECEIPT coalesces into ONE follow-up, so a snapshot is still taken after registration (A1).
    s.transport.receiptAll();
    await flush();
    await s.api.replyMessages({ items: items(C, 4, 6), hasMore: false });
    expect(s.of('connectionRestored')).toEqual([]);
    expect(s.api.messageCalls.map((c) => c.afterSeq)).toEqual([6]);
    await s.api.replyMessages({ items: [], hasMore: false });
    expect(s.of('connectionRestored')).toEqual([{ type: 'connectionRestored', recovered: 3 }]);
    expect(s.client.items(C).map((i) => i.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    const batches = s.of('items').map((e) => [e.items.map((i) => i.seq), e.source]);
    expect(batches.at(-1)).toEqual([[4, 5, 6], 'backfill']);
    expect(s.client.instanceId).toBe('chat-2');
  });

  it('emits synced after each post-RECEIPT backfill, also when it returned nothing', async () => {
    const s = setup();
    s.client.watchConversation(C);
    await connectReady(s);
    expect(s.of('synced')).toEqual([{ type: 'synced', conversationId: C }]);
    s.transport.drop();
    await s.clock.advance(250);
    await connectReady(s, 3);
    expect(s.of('synced').length).toBe(2);
  });

  it('restored is announced only after the backfill actually succeeded (REST failing → retried)', async () => {
    const s = setup();
    s.client.watchConversation(C);
    await connectReady(s, 2);
    s.transport.drop();
    await s.clock.advance(250);
    await connect(s, 'chat-2');
    s.transport.receiptAll();
    await flush();
    await s.api.failMessages();
    expect(s.client.state).toBe('ready');
    expect(s.of('connectionRestored')).toEqual([]);
    await s.clock.advance(1000);
    await s.api.replyMessages({ items: items(C, 3, 3), hasMore: false });
    expect(s.of('connectionRestored')).toEqual([{ type: 'connectionRestored', recovered: 1 }]);
  });

  it('restored with 0 when nothing was missed', async () => {
    const s = setup();
    s.client.watchConversation(C);
    await connectReady(s, 2);
    s.transport.drop();
    await s.clock.advance(250);
    await connectReady(s, 2);
    expect(s.of('connectionRestored')).toEqual([{ type: 'connectionRestored', recovered: 0 }]);
  });
});

describe('ChatClient — outbox and local echo (C2)', () => {
  it('echo → ack (envoyé) → stream item replaces the echo', async () => {
    const s = setup();
    s.client.watchConversation(C);
    await connectReady(s);
    const r = s.client.send(C, '  Bonjour  ');
    expect(r).toEqual({ ok: true, clientMessageId: 'cm-1' });
    expect(s.transport.publishes()).toEqual([{ destination: '/app/conversations/42/messages', body: { clientMessageId: 'cm-1', content: 'Bonjour' } }]);
    expect(s.client.echoes(C).map((e) => e.status)).toEqual(['sending']);
    s.transport.message(destinations.acks, { conversationId: C, clientMessageId: 'cm-1', seq: 1 });
    expect(s.client.echoes(C).map((e) => [e.status, e.seq])).toEqual([['sent', 1]]);
    s.transport.message(TOPIC, item(C, 1, { clientMessageId: 'cm-1', senderRole: 'client', content: 'Bonjour' }));
    expect(s.client.echoes(C)).toEqual([]);
    expect(s.client.items(C).map((i) => i.clientMessageId)).toEqual(['cm-1']);
  });

  it('stream item before the ack also replaces the echo; the late ack is a no-op', async () => {
    const s = setup();
    s.client.watchConversation(C);
    await connectReady(s);
    s.client.send(C, 'x');
    s.transport.message(TOPIC, item(C, 1, { clientMessageId: 'cm-1' }));
    s.transport.message(destinations.acks, { conversationId: C, clientMessageId: 'cm-1', seq: 1 });
    expect(s.client.echoes(C)).toEqual([]);
    expect(s.of('ack').map((e) => e.first)).toEqual([false]);
  });

  it('error → non envoyé with its code, announced, not resent', async () => {
    const s = setup();
    s.client.watchConversation(C);
    await connectReady(s);
    s.client.send(C, 'x');
    s.transport.message(destinations.errors, { conversationId: C, clientMessageId: 'cm-1', code: 'CONVERSATION_CLOSED', reason: 'closed' });
    expect(s.client.echoes(C).map((e) => [e.status, e.errorCode])).toEqual([['failed', 'CONVERSATION_CLOSED']]);
    expect(s.of('sendFailed')).toEqual([{ type: 'sendFailed', conversationId: C, clientMessageId: 'cm-1', code: 'CONVERSATION_CLOSED' }]);
    await s.clock.advance(10_000);
    expect(s.transport.publishes().length).toBe(1);
  });

  it.each([
    ['', 'EMPTY'],
    ['x'.repeat(2001), 'TOO_LONG'],
  ])('invalid content %# is rejected client-side, nothing sent', async (raw, code) => {
    const s = setup();
    await connectReady(s);
    expect(s.client.send(C, raw)).toEqual({ ok: false, code });
    expect(s.transport.publishes()).toEqual([]);
  });

  it('no ack within 5 s on a live connection → resent with the same clientMessageId', async () => {
    const s = setup();
    await connectReady(s);
    s.client.send(C, 'x');
    await s.clock.advance(5000);
    await s.clock.advance(5000);
    expect(s.transport.publishes().map((p) => p.body.clientMessageId)).toEqual(['cm-1', 'cm-1', 'cm-1']);
    s.transport.message(destinations.acks, { conversationId: C, clientMessageId: 'cm-1', seq: 1 });
    await s.clock.advance(20_000);
    expect(s.transport.publishes().length).toBe(3);
  });

  it('sent while disconnected → stays envoi…, published after the reconnect', async () => {
    const s = setup();
    await connectReady(s);
    s.transport.drop();
    s.client.send(C, 'pendant la coupure');
    expect(s.transport.publishes()).toEqual([]);
    expect(s.client.echoes(C).map((e) => e.status)).toEqual(['sending']);
    await s.clock.advance(250);
    await connect(s, 'chat-2');
    expect(s.transport.publishes().map((p) => p.body)).toEqual([{ clientMessageId: 'cm-1', content: 'pendant la coupure' }]);
  });

  it('unacked entries are resent after every reconnect, acks/errors subscribed first', async () => {
    const s = setup();
    await connectReady(s);
    s.client.send(C, 'a');
    s.client.send(C, 'b');
    s.transport.message(destinations.acks, { conversationId: C, clientMessageId: 'cm-1', seq: 1 });
    s.transport.drop();
    await s.clock.advance(250);
    await connect(s);
    const after = s.transport.sinceConnect();
    const firstPublish = after.findIndex((c) => c.op === 'publish');
    const acksSub = after.findIndex((c) => c.op === 'subscribe' && c.destination === destinations.acks);
    expect(acksSub).toBeLessThan(firstPublish);
    expect(after.filter((c) => c.op === 'publish').length).toBe(1);
    expect(s.transport.publishes().at(-1)?.body.clientMessageId).toBe('cm-2');
  });

  it('duplicate acks carry the same seq and are reported (chaos assertion input)', async () => {
    const s = setup();
    await connectReady(s);
    s.client.send(C, 'a');
    s.transport.message(destinations.acks, { conversationId: C, clientMessageId: 'cm-1', seq: 4 });
    s.transport.message(destinations.acks, { conversationId: C, clientMessageId: 'cm-1', seq: 4 });
    expect(s.of('ack').map((e) => [e.ack.seq, e.first])).toEqual([
      [4, true],
      [4, false],
    ]);
  });
});

describe('ChatClient — outbox survives a reload (O11)', () => {
  it('restores unacked entries from storage and resends them with the same clientMessageId on load', async () => {
    const storage = new MemoryStorage();
    const first = setup({ storage });
    await connectReady(first);
    first.client.send(C, 'un');
    first.client.send(C, 'deux');
    first.transport.message(destinations.acks, { conversationId: C, clientMessageId: 'cm-1', seq: 1 });
    first.client.stop(); // tab reload

    const second = setup({ storage, newId: idSequence('new') });
    expect(second.client.outboxConversationIds()).toEqual([C]);
    expect(second.client.echoes(C).map((e) => [e.clientMessageId, e.status])).toEqual([['cm-2', 'sending']]);
    await connect(second);
    expect(second.transport.publishes().map((p) => p.body)).toEqual([{ clientMessageId: 'cm-2', content: 'deux' }]);
    second.transport.message(destinations.acks, { conversationId: C, clientMessageId: 'cm-2', seq: 2 });
    expect(storage.getItem(OUTBOX_STORAGE_KEY)).toBeNull();
  });
});

describe('ChatClient — agent queue', () => {
  const conv = (id: number) => ({
    id,
    status: 'en_attente' as const,
    customerRef: 'c',
    reservationReference: null,
    agentRef: null,
    lastSeq: 0,
    createdAt: '2026-10-19T10:00:00.000Z',
  });

  it('SUBSCRIBE /topic/queue with receipt → GET queue after RECEIPT → replaces local state', async () => {
    const s = setup();
    s.client.watchQueue();
    await connect(s);
    expect(s.api.queueCalls.length).toBe(0);
    s.transport.receipt(s.transport.receiptFor(destinations.queueTopic));
    await flush();
    await s.api.replyQueue({ items: [conv(1), conv(2)], total: 73 });
    expect(s.client.queueSnapshot()).toEqual({ items: [conv(1), conv(2)], total: 73 });
    // reconnect: snapshot replaces, never merges
    s.transport.drop();
    await s.clock.advance(250);
    await connect(s);
    s.transport.receiptAll();
    await flush();
    await s.api.replyQueue({ items: [conv(3)], total: 1 });
    expect(s.client.queueSnapshot()).toEqual({ items: [conv(3)], total: 1 });
  });

  it('queue events coalesce into one refetch in flight + one follow-up', async () => {
    const s = setup();
    s.client.watchQueue();
    await connect(s);
    s.transport.receiptAll();
    await flush();
    for (let i = 0; i < 5; i++) s.transport.message(destinations.queueTopic, { t: 'opened', conversationId: i });
    expect(s.api.queueCalls.length).toBe(1);
    await s.api.replyQueue({ items: [], total: 0 });
    expect(s.api.queueCalls.length).toBe(1);
    await s.api.replyQueue({ items: [conv(9)], total: 1 });
    expect(s.api.queueCalls.length).toBe(0);
  });

  it('removeFromQueue drops a claimed / 409 item locally', async () => {
    const s = setup();
    s.client.watchQueue();
    await connect(s);
    s.transport.receiptAll();
    await flush();
    await s.api.replyQueue({ items: [conv(1), conv(2)], total: 2 });
    s.client.removeFromQueue(1);
    expect(s.client.queueSnapshot()).toEqual({ items: [conv(2)], total: 1 });
  });
});
