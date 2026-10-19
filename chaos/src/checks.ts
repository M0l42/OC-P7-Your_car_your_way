// Pure correctness checks of a chaos run (unit-tested in checks.test.ts).

export interface ReceivedItem {
  seq: number;
  clientMessageId: string;
  type: string;
}

export interface ConversationRecord {
  conversationId: number;
  /** clientMessageIds of texte messages sent by our clients in this conversation. */
  sent: Set<string>;
  /** Items in the order each participant's client emitted them, by participant name. */
  received: Map<string, ReceivedItem[]>;
}

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export function latencyStats(samples: number[]): { n: number; p50: number; p95: number; max: number } {
  const s = [...samples].sort((a, b) => a - b);
  return { n: s.length, p50: percentile(s, 50), p95: percentile(s, 95), max: s.length ? s[s.length - 1] : NaN };
}

/** Per participant: strictly increasing, gap-free from 1, no duplicates; received texte set == sent set. */
export function checkConversation(c: ConversationRecord): CheckResult[] {
  const out: CheckResult[] = [];
  for (const [who, items] of c.received) {
    const label = `conversation ${c.conversationId} / ${who}`;
    let prev = 0;
    const bad: string[] = [];
    for (const it of items) {
      if (it.seq <= prev) bad.push(`seq ${it.seq} after ${prev}`);
      else if (it.seq !== prev + 1) bad.push(`gap ${prev + 1}..${it.seq - 1}`);
      prev = Math.max(prev, it.seq);
    }
    out.push({ name: `${label}: strictly increasing, gap-free seq`, ok: bad.length === 0, detail: bad.length ? bad.slice(0, 5).join(', ') : `${items.length} items, last seq ${prev}` });

    const texts = items.filter((i) => i.type === 'texte').map((i) => i.clientMessageId);
    const textSet = new Set(texts);
    const dupes = texts.length - textSet.size;
    const missing = [...c.sent].filter((id) => !textSet.has(id));
    const extra = [...textSet].filter((id) => !c.sent.has(id));
    out.push({
      name: `${label}: received == sent`,
      ok: dupes === 0 && missing.length === 0 && extra.length === 0,
      detail: `sent ${c.sent.size}, received ${textSet.size}, lost ${missing.length}, duplicated ${dupes}, unexpected ${extra.length}`,
    });
  }
  return out;
}

/** Every sent message acked at least once; all acks of one clientMessageId carry the same seq, equal to the stream seq. */
export function checkAcks(sent: Iterable<string>, acks: Map<string, number[]>, streamSeq: Map<string, number>): CheckResult {
  let unacked = 0;
  let inconsistent = 0;
  let mismatched = 0;
  let total = 0;
  let duplicates = 0;
  for (const id of sent) {
    total++;
    const seqs = acks.get(id) ?? [];
    if (seqs.length === 0) unacked++;
    else {
      duplicates += seqs.length - 1;
      if (new Set(seqs).size > 1) inconsistent++;
      const s = streamSeq.get(id);
      if (s !== undefined && seqs[0] !== s) mismatched++;
    }
  }
  return {
    name: 'acks: ≥1 per clientMessageId, one seq each, equal to the stream seq',
    ok: unacked === 0 && inconsistent === 0 && mismatched === 0,
    detail: `${total} sent, unacked ${unacked}, inconsistent ${inconsistent}, ack≠stream ${mismatched}, duplicate acks (legit retries) ${duplicates}`,
  };
}

export function checkQueue(client: { ids: number[]; total: number }, db: { ids: number[]; total: number }): CheckResult {
  const ok = client.total === db.total && client.ids.length === db.ids.length && client.ids.every((id, i) => id === db.ids[i]);
  return {
    name: 'agent queue == DB (oldest 50 en_attente + total)',
    ok,
    detail: `client ${client.ids.length} items / total ${client.total}; DB ${db.ids.length} items / total ${db.total}`,
  };
}
