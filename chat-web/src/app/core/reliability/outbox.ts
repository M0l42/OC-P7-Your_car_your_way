import type { KeyValueStorage } from './ports';

/**
 * Local echo + outbox (C2, O11).
 *
 *   send() ──▶ 'sending' (echo shown "envoi…", persisted in storage, published)
 *   'sending' ──ack──▶ 'sent' ("envoyé", removed from storage)
 *   'sending' ──error on /user/queue/errors──▶ 'failed' ("non envoyé" + reason, removed from storage)
 *   any state ──stream item with the same clientMessageId──▶ echo removed (item shown at its seq)
 *
 * Only 'sending' entries are persisted: they are restored on page load and resent with the SAME
 * clientMessageId (server dedup makes the resend idempotent).
 */
export type EchoStatus = 'sending' | 'sent' | 'failed';

export interface Echo {
  conversationId: number;
  clientMessageId: string;
  content: string;
  status: EchoStatus;
  createdAt: number;
  seq?: number;
  errorCode?: string;
}

interface PersistedEntry {
  conversationId: number;
  clientMessageId: string;
  content: string;
  createdAt: number;
}

export const OUTBOX_STORAGE_KEY = 'ycyw.chat.outbox.v1';

export class Outbox {
  private readonly echoes = new Map<string, Echo>();

  constructor(
    private readonly storage: KeyValueStorage | null,
    private readonly storageKey = OUTBOX_STORAGE_KEY,
  ) {
    for (const e of this.load()) this.echoes.set(e.clientMessageId, { ...e, status: 'sending' });
  }

  add(conversationId: number, clientMessageId: string, content: string, createdAt: number): Echo {
    const echo: Echo = { conversationId, clientMessageId, content, status: 'sending', createdAt };
    this.echoes.set(clientMessageId, echo);
    this.persist();
    return echo;
  }

  get(clientMessageId: string): Echo | undefined {
    return this.echoes.get(clientMessageId);
  }

  /** Entries still waiting for an ack, in send order (Map insertion order, kept across reloads). */
  unacked(): Echo[] {
    return [...this.echoes.values()].filter((e) => e.status === 'sending');
  }

  forConversation(conversationId: number): Echo[] {
    return [...this.echoes.values()].filter((e) => e.conversationId === conversationId);
  }

  /** Returns the echo if this ack changed it (first ack); duplicate or unknown acks return null. */
  ack(clientMessageId: string, seq: number): Echo | null {
    const echo = this.echoes.get(clientMessageId);
    if (!echo || echo.status !== 'sending') return null;
    echo.status = 'sent';
    echo.seq = seq;
    this.persist();
    return echo;
  }

  fail(clientMessageId: string, code: string): Echo | null {
    const echo = this.echoes.get(clientMessageId);
    if (!echo || echo.status !== 'sending') return null;
    echo.status = 'failed';
    echo.errorCode = code;
    this.persist();
    return echo;
  }

  /** The stream item arrived: the echo is replaced by it. */
  resolve(clientMessageId: string): Echo | null {
    const echo = this.echoes.get(clientMessageId);
    if (!echo) return null;
    this.echoes.delete(clientMessageId);
    if (echo.status === 'sending') this.persist();
    return echo;
  }

  dismiss(clientMessageId: string): void {
    if (this.echoes.get(clientMessageId)?.status === 'failed') this.echoes.delete(clientMessageId);
  }

  private load(): PersistedEntry[] {
    try {
      const raw = this.storage?.getItem(this.storageKey);
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (e): e is PersistedEntry =>
          typeof e === 'object' &&
          e !== null &&
          typeof e.conversationId === 'number' &&
          typeof e.clientMessageId === 'string' &&
          typeof e.content === 'string',
      ).map((e) => ({ ...e, createdAt: typeof e.createdAt === 'number' ? e.createdAt : 0 }));
    } catch {
      return [];
    }
  }

  private persist(): void {
    if (!this.storage) return;
    try {
      const entries: PersistedEntry[] = this.unacked().map(({ conversationId, clientMessageId, content, createdAt }) => ({
        conversationId,
        clientMessageId,
        content,
        createdAt,
      }));
      if (entries.length) this.storage.setItem(this.storageKey, JSON.stringify(entries));
      else this.storage.removeItem(this.storageKey);
    } catch {
      // Storage full or blocked (private mode): the outbox still works for this page lifetime.
    }
  }
}
