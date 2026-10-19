import type { Clock, TimerHandle } from './ports';

/**
 * At most one run in flight; any number of triggers during a run coalesce into exactly one
 * follow-up run (C1). A failed run is retried every `retryMs` until it succeeds or the runner is
 * disposed, and the promise returned by `trigger()` settles only then: a caller awaiting a backfill
 * (e.g. the "connection restored, N recovered" announcement) never reports a sync that did not happen.
 */
export class CoalescingRunner {
  private running: Promise<void> | null = null;
  private again = false;
  private retryTimer: TimerHandle | null = null;
  private wakeRetry: (() => void) | null = null;
  private disposed = false;

  constructor(
    private readonly task: () => Promise<void>,
    private readonly clock: Clock,
    private readonly retryMs = 1000,
    private readonly onError: (e: unknown) => void = () => undefined,
  ) {}

  get inFlight(): boolean {
    return this.running !== null;
  }

  trigger(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.loop().finally(() => (this.running = null));
    return this.running;
  }

  dispose(): void {
    this.disposed = true;
    this.again = false;
    if (this.retryTimer !== null) this.clock.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.wakeRetry?.(); // lets a waiting loop end
  }

  private async loop(): Promise<void> {
    do {
      this.again = false;
      try {
        await this.task();
      } catch (e) {
        this.onError(e);
        if (this.disposed) return;
        await this.waitRetry();
        this.again = true; // retry (and absorb any trigger that arrived meanwhile)
      }
    } while (this.again && !this.disposed);
  }

  private waitRetry(): Promise<void> {
    return new Promise((resolve) => {
      this.wakeRetry = resolve;
      this.retryTimer = this.clock.setTimeout(() => {
        this.retryTimer = null;
        this.wakeRetry = null;
        resolve();
      }, this.retryMs);
    });
  }
}
