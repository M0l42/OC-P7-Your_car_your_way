import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkAcks, checkConversation, checkQueue, latencyStats, percentile, type ReceivedItem } from './checks.ts';

const t = (seq: number, id = `m${seq}`, type = 'texte'): ReceivedItem => ({ seq, clientMessageId: id, type });

describe('checkConversation', () => {
  const run = (items: ReceivedItem[], sent: string[]) =>
    checkConversation({ conversationId: 1, sent: new Set(sent), received: new Map([['agent', items]]) }).map((r) => r.ok);

  const cases: [string, ReceivedItem[], string[], boolean[]][] = [
    ['ok', [t(1, 'x', 'prise_en_charge'), t(2), t(3)], ['m2', 'm3'], [true, true]],
    ['out of order', [t(1), t(3), t(2)], ['m1', 'm2', 'm3'], [false, true]],
    ['duplicate seq', [t(1), t(1)], ['m1'], [false, false]],
    ['gap', [t(1), t(3)], ['m1', 'm3'], [false, true]],
    ['lost message', [t(1)], ['m1', 'm2'], [true, false]],
    ['unexpected message', [t(1), t(2)], ['m1'], [true, false]],
  ];
  for (const [name, items, sent, expected] of cases) {
    it(name, () => assert.deepEqual(run(items, sent), expected));
  }
});

describe('checkAcks', () => {
  it('passes with duplicate acks carrying the same seq', () => {
    assert.equal(checkAcks(['a', 'b'], new Map([['a', [1, 1]], ['b', [2]]]), new Map([['a', 1], ['b', 2]])).ok, true);
  });
  it('fails on unacked, inconsistent or mismatched seq', () => {
    assert.equal(checkAcks(['a'], new Map(), new Map()).ok, false);
    assert.equal(checkAcks(['a'], new Map([['a', [1, 2]]]), new Map()).ok, false);
    assert.equal(checkAcks(['a'], new Map([['a', [3]]]), new Map([['a', 4]])).ok, false);
  });
});

describe('checkQueue', () => {
  it('compares ids in order and total', () => {
    assert.equal(checkQueue({ ids: [1, 2], total: 7 }, { ids: [1, 2], total: 7 }).ok, true);
    assert.equal(checkQueue({ ids: [2, 1], total: 7 }, { ids: [1, 2], total: 7 }).ok, false);
    assert.equal(checkQueue({ ids: [1, 2], total: 6 }, { ids: [1, 2], total: 7 }).ok, false);
  });
});

describe('latency', () => {
  it('nearest-rank percentiles', () => {
    const s = Array.from({ length: 100 }, (_, i) => i + 1);
    assert.equal(percentile(s, 50), 50);
    assert.equal(percentile(s, 95), 95);
    assert.deepEqual(latencyStats([3, 1, 2]), { n: 3, p50: 2, p95: 3, max: 3 });
  });
});
