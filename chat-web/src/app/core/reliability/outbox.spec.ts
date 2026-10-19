import { OUTBOX_STORAGE_KEY, Outbox } from './outbox';
import { MemoryStorage } from './testing/fakes';

function persisted(storage: MemoryStorage): string[] {
  const raw = storage.getItem(OUTBOX_STORAGE_KEY);
  return raw ? (JSON.parse(raw) as { clientMessageId: string }[]).map((e) => e.clientMessageId) : [];
}

// C2 transition table: each row applies the steps in order to one echo "a".
describe('Outbox — echo transitions (C2)', () => {
  type Step = 'ack' | 'ack-again' | 'fail' | 'resolve';
  it.each<{ steps: Step[]; status: string | null; stored: boolean }>([
    { steps: [], status: 'sending', stored: true },
    { steps: ['ack'], status: 'sent', stored: false },
    { steps: ['ack', 'ack-again'], status: 'sent', stored: false },
    { steps: ['ack', 'resolve'], status: null, stored: false },
    { steps: ['resolve'], status: null, stored: false },
    { steps: ['resolve', 'ack'], status: null, stored: false },
    { steps: ['fail'], status: 'failed', stored: false },
    { steps: ['ack', 'fail'], status: 'sent', stored: false },
    { steps: ['fail', 'ack'], status: 'failed', stored: false },
  ])('$steps → $status', ({ steps, status, stored }) => {
    const storage = new MemoryStorage();
    const o = new Outbox(storage);
    o.add(1, 'a', 'hello', 1);
    for (const s of steps) {
      if (s === 'ack' || s === 'ack-again') o.ack('a', 5);
      if (s === 'fail') o.fail('a', 'CONVERSATION_CLOSED');
      if (s === 'resolve') o.resolve('a');
    }
    expect(o.get('a')?.status ?? null).toBe(status);
    expect(persisted(storage).includes('a')).toBe(stored);
  });

  it('first ack returns the echo, duplicates and unknown ids return null', () => {
    const o = new Outbox(null);
    o.add(1, 'a', 'x', 1);
    expect(o.ack('a', 3)?.seq).toBe(3);
    expect(o.ack('a', 3)).toBeNull();
    expect(o.ack('zzz', 9)).toBeNull();
  });

  it('failed echo keeps its code and can be dismissed', () => {
    const o = new Outbox(null);
    o.add(1, 'a', 'x', 1);
    o.fail('a', 'CONVERSATION_CLOSED');
    expect(o.get('a')?.errorCode).toBe('CONVERSATION_CLOSED');
    o.dismiss('a');
    expect(o.get('a')).toBeUndefined();
  });
});

describe('Outbox — persistence (O11)', () => {
  it('a reload restores unacked entries in send order, as sending', () => {
    const storage = new MemoryStorage();
    const before = new Outbox(storage);
    before.add(1, 'a', 'one', 1);
    before.add(2, 'b', 'two', 2);
    before.add(1, 'c', 'three', 3);
    before.ack('b', 1);
    const after = new Outbox(storage);
    expect(after.unacked().map((e) => [e.clientMessageId, e.conversationId, e.content, e.status])).toEqual([
      ['a', 1, 'one', 'sending'],
      ['c', 1, 'three', 'sending'],
    ]);
  });

  it.each([
    ['garbage', '{not json'],
    ['not an array', '{"a":1}'],
    ['invalid entries', '[{"conversationId":"x"},null,42]'],
  ])('ignores %s in storage', (_name, raw) => {
    const storage = new MemoryStorage();
    storage.setItem(OUTBOX_STORAGE_KEY, raw);
    expect(new Outbox(storage).unacked()).toEqual([]);
  });

  it('works when storage throws (blocked / full)', () => {
    const throwing = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceeded');
      },
      removeItem: () => {
        throw new Error('SecurityError');
      },
    };
    const o = new Outbox(throwing);
    o.add(1, 'a', 'x', 1);
    expect(o.unacked().length).toBe(1);
    expect(o.ack('a', 1)?.status).toBe('sent');
  });

  it('removes the storage key once nothing is unacked', () => {
    const storage = new MemoryStorage();
    const o = new Outbox(storage);
    o.add(1, 'a', 'x', 1);
    o.ack('a', 1);
    expect(storage.getItem(OUTBOX_STORAGE_KEY)).toBeNull();
  });
});
