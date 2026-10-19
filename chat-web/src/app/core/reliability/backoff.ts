export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = { baseMs: 500, maxMs: 15_000 };

/**
 * Exponential backoff with jitter: the ceiling doubles per attempt (capped at maxMs) and the actual
 * delay is drawn uniformly in [ceiling/2, ceiling], so clients cut off by the same kill spread out
 * instead of reconnecting in lockstep. `attempt` starts at 0; `random` returns [0, 1).
 */
export function backoffDelay(attempt: number, random: () => number, opts: BackoffOptions = DEFAULT_BACKOFF): number {
  const ceiling = Math.min(opts.maxMs, opts.baseMs * 2 ** Math.max(0, attempt));
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}
