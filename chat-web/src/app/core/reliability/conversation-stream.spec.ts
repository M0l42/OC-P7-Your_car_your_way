import { ConversationStream, type ItemSource } from './conversation-stream';
import type { StreamItem } from './protocol';
import { FakeApi, FakeClock, flush, item, items } from './testing/fakes';

const C = 7;

function setup() {
  const api = new FakeApi();
  const clock = new FakeClock();
  const appended: { seqs: number[]; source: ItemSource }[] = [];
  const stream = new ConversationStream(C, api, clock, (its: StreamItem[], source) =>
    appended.push({ seqs: its.map((i) => i.seq), source }),
  );
  const rendered = () => stream.snapshot().map((i) => i.seq);
  return { api, clock, stream, appended, rendered };
}

// C1 table: live arrivals only (no fetch answered), checks rendered prefix, pending buffer and fetches.
describe('ConversationStream — live arrivals (C1)', () => {
  it.each([
    { name: 'in order', live: [1, 2, 3], rendered: [1, 2, 3], pending: [], fetches: 0 },
    { name: 'duplicate of a rendered seq is dropped', live: [1, 2, 2, 1], rendered: [1, 2], pending: [], fetches: 0 },
    { name: 'gap buffers the early item and fetches once', live: [1, 3], rendered: [1], pending: [3], fetches: 1 },
    { name: 'duplicate of a pending seq is dropped', live: [1, 4, 4], rendered: [1], pending: [4], fetches: 1 },
    { name: 'gap filled live drains the buffer', live: [1, 3, 4, 2], rendered: [1, 2, 3, 4], pending: [], fetches: 1 },
    { name: 'several gaps during one fetch coalesce', live: [2, 5, 9], rendered: [], pending: [2, 5, 9], fetches: 1 },
    { name: 'item from another conversation is ignored', live: [], foreign: true, rendered: [], pending: [], fetches: 0 },
  ])('$name', async ({ live, rendered, pending, fetches, foreign }) => {
    const s = setup();
    for (const seq of live) s.stream.receiveLive(item(C, seq));
    if (foreign) s.stream.receiveLive(item(C + 1, 1));
    await flush();
    expect(s.rendered()).toEqual(rendered);
    expect(s.stream.pendingSeqs).toEqual(pending);
    expect(s.api.messageCalls.length).toBe(fetches);
  });
});

describe('ConversationStream — fetches (C1 + P1)', () => {
  it('fetches afterSeq=lastSeq and merges the page with buffered live items', async () => {
    const s = setup();
    s.stream.receiveLive(item(C, 1));
    s.stream.receiveLive(item(C, 4));
    expect(s.api.messageCalls[0].afterSeq).toBe(1);
    await s.api.replyMessages({ items: items(C, 2, 4), hasMore: false });
    expect(s.rendered()).toEqual([1, 2, 3, 4]);
    expect(s.appended).toEqual([
      { seqs: [1], source: 'live' },
      { seqs: [2, 3, 4], source: 'backfill' },
    ]);
    expect(s.api.messageCalls.length).toBe(0);
  });

  it('item arriving during a fetch: contiguous one is rendered at once, the page dedups it', async () => {
    const s = setup();
    void s.stream.backfill();
    s.stream.receiveLive(item(C, 1));
    expect(s.rendered()).toEqual([1]);
    await s.api.replyMessages({ items: items(C, 1, 2), hasMore: false });
    expect(s.rendered()).toEqual([1, 2]);
  });

  it('two triggers during one fetch → exactly one follow-up fetch, from the new lastSeq', async () => {
    const s = setup();
    void s.stream.backfill();
    void s.stream.backfill();
    void s.stream.backfill();
    expect(s.api.messageCalls.length).toBe(1);
    await s.api.replyMessages({ items: items(C, 1, 3), hasMore: false });
    expect(s.api.messageCalls.length).toBe(1);
    expect(s.api.messageCalls[0].afterSeq).toBe(3);
    await s.api.replyMessages({ items: [], hasMore: false });
    expect(s.api.messageCalls.length).toBe(0);
    expect(s.stream.fetchInFlight).toBe(false);
  });

  it('the trigger promise settles only after the coalesced follow-up', async () => {
    const s = setup();
    let done = false;
    void s.stream.backfill().then(() => (done = true));
    void s.stream.backfill();
    await s.api.replyMessages({ items: [], hasMore: false });
    expect(done).toBe(false);
    await s.api.replyMessages({ items: [], hasMore: false });
    expect(done).toBe(true);
  });

  it('pages until hasMore=false: 450 items arrive in 3 contiguous pages (P1)', async () => {
    const s = setup();
    void s.stream.backfill();
    const calls: number[] = [];
    calls.push((await s.api.replyMessages({ items: items(C, 1, 200), hasMore: true })).afterSeq);
    calls.push((await s.api.replyMessages({ items: items(C, 201, 400), hasMore: true })).afterSeq);
    calls.push((await s.api.replyMessages({ items: items(C, 401, 450), hasMore: false })).afterSeq);
    expect(calls).toEqual([0, 200, 400]);
    expect(s.rendered()).toEqual(items(C, 1, 450).map((i) => i.seq));
    expect(s.api.messageCalls.length).toBe(0);
  });

  it('stops paging if a page does not advance lastSeq (no infinite loop)', async () => {
    const s = setup();
    void s.stream.backfill();
    await s.api.replyMessages({ items: [], hasMore: true });
    expect(s.api.messageCalls.length).toBe(0);
  });

  it('failed fetch is retried after 1 s', async () => {
    const s = setup();
    void s.stream.backfill();
    await s.api.failMessages();
    expect(s.api.messageCalls.length).toBe(0);
    await s.clock.advance(999);
    expect(s.api.messageCalls.length).toBe(0);
    await s.clock.advance(1);
    expect(s.api.messageCalls.length).toBe(1);
  });

  it('the backfill promise settles only once a retry succeeds', async () => {
    const s = setup();
    let done = false;
    void s.stream.backfill().then(() => (done = true));
    await s.api.failMessages();
    expect(done).toBe(false);
    void s.stream.backfill(); // coalesces into the pending retry, no extra fetch
    await s.clock.advance(1000);
    expect(s.api.messageCalls.length).toBe(1);
    await s.api.replyMessages({ items: items(C, 1, 2), hasMore: false });
    expect(done).toBe(true);
    expect(s.rendered()).toEqual([1, 2]);
  });

  it('dispose cancels the retry', async () => {
    const s = setup();
    void s.stream.backfill();
    await s.api.failMessages();
    s.stream.dispose();
    await s.clock.advance(5000);
    expect(s.api.messageCalls.length).toBe(0);
    expect(s.stream.fetchInFlight).toBe(false);
  });
});
