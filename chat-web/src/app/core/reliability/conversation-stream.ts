import { CoalescingRunner } from './coalescing-runner';
import type { ChatApi, Clock } from './ports';
import type { StreamItem } from './protocol';

export type ItemSource = 'live' | 'backfill';

/**
 * Ordered view of one conversation's sequenced stream (C1 + P1).
 *
 *   live item ──▶ seq <= lastSeq or already pending ──▶ drop (duplicate)
 *             ──▶ seq == lastSeq + 1 ───────────────────▶ append, then drain pending prefix
 *             ──▶ seq >  lastSeq + 1 ───────────────────▶ pending[seq], request a backfill (gap)
 *
 *   backfill  ──▶ one REST fetch in flight; triggers during it coalesce into ONE follow-up;
 *                 each pass pages afterSeq=lastSeq until hasMore=false; page items are merged
 *                 through the same pending buffer, so only the contiguous prefix is rendered.
 *
 * Invariant: `items` is exactly seq 1..lastSeq, strictly increasing, each seq once.
 */
export class ConversationStream {
  private readonly items: StreamItem[] = [];
  private readonly pending = new Map<number, StreamItem>();
  private readonly runner: CoalescingRunner;
  private lastSeqValue: number;

  constructor(
    readonly conversationId: number,
    private readonly api: ChatApi,
    clock: Clock,
    private readonly onAppend: (items: StreamItem[], source: ItemSource) => void,
    initialLastSeq = 0,
    onFetchError: (e: unknown) => void = () => undefined,
  ) {
    this.lastSeqValue = initialLastSeq;
    this.runner = new CoalescingRunner(() => this.fetchAllPages(), clock, 1000, onFetchError);
  }

  get lastSeq(): number {
    return this.lastSeqValue;
  }

  get fetchInFlight(): boolean {
    return this.runner.inFlight;
  }

  get pendingSeqs(): number[] {
    return [...this.pending.keys()].sort((a, b) => a - b);
  }

  snapshot(): readonly StreamItem[] {
    return this.items;
  }

  /** Item pushed on the conversation topic. */
  receiveLive(item: StreamItem): void {
    if (!this.accept(item)) return;
    const appended = this.drain();
    if (appended.length) this.onAppend(appended, 'live');
    if (this.pending.size > 0) void this.backfill();
  }

  /** Fetch everything after lastSeq (paging until hasMore=false). Coalesces with a running fetch. */
  backfill(): Promise<void> {
    return this.runner.trigger();
  }

  dispose(): void {
    this.runner.dispose();
  }

  private async fetchAllPages(): Promise<void> {
    for (;;) {
      const afterSeq = this.lastSeqValue;
      const page = await this.api.fetchMessages(this.conversationId, afterSeq);
      for (const item of page.items) this.accept(item);
      const appended = this.drain();
      if (appended.length) this.onAppend(appended, 'backfill');
      // Stop on the last page, or if a page did not advance (defensive: never loop forever).
      if (!page.hasMore || this.lastSeqValue === afterSeq) return;
    }
  }

  private accept(item: StreamItem): boolean {
    if (item.conversationId !== this.conversationId) return false;
    if (item.seq <= this.lastSeqValue || this.pending.has(item.seq)) return false;
    this.pending.set(item.seq, item);
    return true;
  }

  private drain(): StreamItem[] {
    const out: StreamItem[] = [];
    let next = this.pending.get(this.lastSeqValue + 1);
    while (next) {
      this.pending.delete(next.seq);
      this.items.push(next);
      out.push(next);
      this.lastSeqValue = next.seq;
      next = this.pending.get(this.lastSeqValue + 1);
    }
    return out;
  }
}
