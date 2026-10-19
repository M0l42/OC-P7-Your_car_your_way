import type { Clock, TimerHandle } from './ports';

/**
 * At most one run in flight; any number of triggers during a run coalesce into exactly one
 * follow-up run (C1). A failed run is retried after `retryMs` unless disposed. The promise returned
 * by `trigger()` settles when the in-flight run and its follow-up (if any) are done.
 */
export class CoalescingRunner {
  private running: Promise<void> | null = null;
  private again = false;
  private retryTimer: TimerHandle | null = null;
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
    this.cancelRetry();
    this.running = this.loop().finally(() => (this.running = null));
    return this.running;
  }

  dispose(): void {
    this.disposed = true;
    this.again = false;
    this.cancelRetry();
  }

  private async loop(): Promise<void> {
    do {
      this.again = false;
      try {
        await this.task();
      } catch (e) {
        this.onError(e);
        if (!this.disposed) {
          this.cancelRetry();
          this.retryTimer = this.clock.setTimeout(() => {
            this.retryTimer = null;
            void this.trigger();
          }, this.retryMs);
        }
        this.again = false;
        return;
      }
    } while (this.again && !this.disposed);
  }

  private cancelRetry(): void {
    if (this.retryTimer !== null) {
      this.clock.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }
}
