import { CoalescingRunner } from './coalescing-runner';
import type { ChatApi, Clock } from './ports';
import type { Conversation, QueuePage } from './protocol';

/**
 * Agent queue (oldest 50 en_attente + total, P1). /topic/queue events are unsequenced, so they are
 * only refetch triggers; the REST snapshot always REPLACES local state (recovery after reconnect).
 * Same single-in-flight + one coalesced follow-up rule as conversation backfills (C1).
 */
export class QueueTracker {
  private state: QueuePage = { items: [], total: 0 };
  private readonly runner: CoalescingRunner;
  private loadedOnce = false;

  constructor(
    private readonly api: ChatApi,
    clock: Clock,
    private readonly onChange: (page: QueuePage) => void,
    onFetchError: (e: unknown) => void = () => undefined,
  ) {
    this.runner = new CoalescingRunner(
      async () => {
        this.state = await this.api.fetchQueue();
        this.loadedOnce = true;
        this.onChange(this.state);
      },
      clock,
      1000,
      onFetchError,
    );
  }

  get snapshot(): QueuePage {
    return this.state;
  }

  get loaded(): boolean {
    return this.loadedOnce;
  }

  refetch(): Promise<void> {
    return this.runner.trigger();
  }

  /** Optimistic local removal (claim won, or 409 lost race); the next refetch is authoritative. */
  remove(conversationId: number): void {
    const items = this.state.items.filter((c: Conversation) => c.id !== conversationId);
    if (items.length === this.state.items.length) return;
    this.state = { items, total: Math.max(0, this.state.total - 1) };
    this.onChange(this.state);
  }

  dispose(): void {
    this.runner.dispose();
  }
}
