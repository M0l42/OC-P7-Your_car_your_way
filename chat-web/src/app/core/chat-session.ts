import { DestroyRef, Injectable, InjectionToken, inject, signal } from '@angular/core';
import { Client } from '@stomp/stompjs';
import {
  ChatClient,
  DevTokenProvider,
  HttpChatApi,
  StompJsTransport,
  type ChatEvent,
  type ChatRestApi,
  type Clock,
  type ConnectionState,
  type Echo,
  type KeyValueStorage,
  type QueuePage,
  type StompClientLike,
  type StreamItem,
  type TokenProvider,
  type TokenRole,
  type Transport,
} from './reliability';
import { I18n } from './i18n';

/** Everything the session needs from the outside world; tests replace it with fakes. */
export interface ChatDeps {
  transport: Transport;
  api: ChatRestApi;
  /** Token provider that knows the identity (`subject`) once a token was issued. */
  tokens: TokenProvider & { readonly subject: string | null };
  storage: KeyValueStorage | null;
  urls: { first: string; reconnect: string };
  clock?: Clock;
}

export type ChatDepsFactory = (role: TokenRole) => ChatDeps;

export const CHAT_DEPS = new InjectionToken<ChatDepsFactory>('CHAT_DEPS', {
  providedIn: 'root',
  factory: () => browserDeps,
});

/** sessionStorage, or null when blocked (private mode, sandboxed iframe). */
export function safeSessionStorage(): KeyValueStorage | null {
  try {
    const s = window.sessionStorage;
    s.getItem('probe');
    return s;
  } catch {
    return null;
  }
}

/** C5: `?node=a|b` pins only the FIRST connection to /ws-a or /ws-b; reconnects use /ws. */
export function firstConnectionPath(search: string): string {
  const node = new URLSearchParams(search).get('node');
  return node === 'a' ? '/ws-a' : node === 'b' ? '/ws-b' : '/ws';
}

function browserDeps(role: TokenRole): ChatDeps {
  const origin = window.location.origin;
  const storage = safeSessionStorage();
  const tokens = new DevTokenProvider(origin, { role }, storage);
  const wsBase = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}`;
  const transport = new StompJsTransport((cfg) => new Client(cfg) as unknown as StompClientLike, (path) => wsBase + path);
  return {
    transport,
    api: new HttpChatApi(origin, tokens),
    tokens,
    storage,
    urls: { first: firstConnectionPath(window.location.search), reconnect: '/ws' },
  };
}

/**
 * Thin Angular wrapper around the framework-free ChatClient: turns core events into signals and
 * screen-reader announcements. Provided per page (customer / agent), started with start(role).
 */
@Injectable()
export class ChatSession {
  private readonly i18n = inject(I18n);
  private readonly depsFactory = inject(CHAT_DEPS);

  readonly state = signal<ConnectionState>('idle');
  readonly instanceId = signal<string | null>(null);
  /** Text of the status live region (role=status), separate from the message log. */
  readonly announcement = signal('');
  readonly queue = signal<QueuePage>({ items: [], total: 0 });
  /**
   * C4: true while a backfilled batch is being inserted — the message log renders aria-live="off"
   * so the batch is not read item by item; only the count is announced in the status region.
   */
  readonly backfilling = signal(false);
  /** Bumped on every item/echo change; views read it to recompute. */
  readonly revision = signal(0);

  private client: ChatClient | null = null;
  private deps: ChatDeps | null = null;
  private announceTimer: ReturnType<typeof setTimeout> | null = null;
  private restoreLiveTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly initialLoad = new Set<number>();

  constructor() {
    inject(DestroyRef).onDestroy(() => this.stop());
  }

  get api(): ChatRestApi {
    return this.requireDeps().api;
  }

  get storage(): KeyValueStorage | null {
    return this.requireDeps().storage;
  }

  get subject(): string | null {
    return this.deps?.tokens.subject ?? null;
  }

  /**
   * Gets the identity first (token from auth-stub, retried until it answers), so the outbox can be
   * keyed per role + subject: another identity in the same tab never resends someone else's
   * unacked messages. Then starts the reliability core.
   */
  start(role: TokenRole): Promise<void> {
    this.starting ??= this.doStart(role);
    return this.starting;
  }

  private starting: Promise<void> | null = null;
  private stopped = false;

  private async doStart(role: TokenRole): Promise<void> {
    this.deps = this.depsFactory(role);
    const { transport, api, tokens, storage, urls, clock } = this.deps;
    this.state.set('connecting');
    for (let attempt = 0; ; attempt++) {
      try {
        await tokens.getToken();
        break;
      } catch (e) {
        console.warn('[chat] token', e);
        if (this.stopped) return;
        await new Promise((r) => setTimeout(r, Math.min(10_000, 500 * 2 ** attempt)));
      }
    }
    if (this.stopped) return;
    this.client = new ChatClient({
      transport,
      api,
      tokens,
      storage,
      urls,
      clock,
      outboxStorageKey: `ycyw.chat.outbox.${role}.${tokens.subject ?? 'anonymous'}.v1`,
      onInternalError: (e) => console.warn('[chat]', e),
    });
    this.client.on((e) => this.onEvent(e));
    this.client.start();
  }

  stop(): void {
    this.stopped = true;
    this.client?.stop();
    if (this.announceTimer) clearTimeout(this.announceTimer);
    if (this.restoreLiveTimer) clearTimeout(this.restoreLiveTimer);
  }

  watch(conversationId: number): void {
    this.initialLoad.add(conversationId);
    this.requireClient().watchConversation(conversationId);
  }

  unwatch(conversationId: number): void {
    this.client?.unwatchConversation(conversationId);
  }

  watchQueue(): void {
    this.requireClient().watchQueue();
  }

  removeFromQueue(id: number): void {
    this.client?.removeFromQueue(id);
  }

  refetchQueue(): void {
    void this.client?.refetchQueue();
  }

  backfill(id: number): void {
    void this.client?.backfill(id);
  }

  send(conversationId: number, text: string) {
    return this.requireClient().send(conversationId, text);
  }

  dismissFailed(conversationId: number, clientMessageId: string): void {
    this.client?.dismissFailed(conversationId, clientMessageId);
  }

  outboxConversationIds(): number[] {
    return this.client?.outboxConversationIds() ?? [];
  }

  items(conversationId: number): readonly StreamItem[] {
    this.revision();
    // A copy, so computed() consumers see a new value on every revision.
    return this.client?.items(conversationId).slice() ?? [];
  }

  echoes(conversationId: number): Echo[] {
    this.revision();
    return this.client?.echoes(conversationId) ?? [];
  }

  /**
   * Puts `text` in the status live region; clearing first makes a repeated text announced again.
   * Texts arriving in the same 100 ms window are joined rather than overwriting each other (e.g.
   * "claimed" then "1 message loaded"); a pending text made obsolete (`supersedes`, e.g. "lost"
   * when "restored" arrives) is dropped.
   */
  announce(text: string, supersedes?: string): void {
    if (supersedes) this.pendingAnnouncements = this.pendingAnnouncements.filter((p) => p !== supersedes);
    this.pendingAnnouncements.push(text);
    this.announcement.set('');
    if (this.announceTimer) clearTimeout(this.announceTimer);
    this.announceTimer = setTimeout(() => {
      const parts = this.pendingAnnouncements;
      this.announcement.set(parts.length === 1 ? parts[0] : parts.map((p, i) => (i === parts.length - 1 || /[.…!?]$/.test(p) ? p : `${p}.`)).join(' '));
      this.pendingAnnouncements = [];
      this.announceTimer = null;
    }, 100);
  }

  private pendingAnnouncements: string[] = [];

  private onEvent(e: ChatEvent): void {
    const t = this.i18n.t;
    switch (e.type) {
      case 'state':
        this.state.set(e.state);
        this.instanceId.set(e.instanceId);
        break;
      case 'connectionLost':
        this.initialLoad.clear(); // a first load interrupted by the loss is reported as a recovery
        this.announce(t.connectionLost);
        break;
      case 'connectionRestored':
        this.announce(t.connectionRestored(e.recovered), t.connectionLost);
        break;
      case 'items':
        if (e.source === 'backfill') this.suppressLiveRegion();
        this.revision.update((v) => v + 1);
        break;
      case 'synced':
        // First sync of a newly watched conversation only; later syncs are reconnects, announced by
        // connectionRestored alone (C4).
        if (this.initialLoad.delete(e.conversationId)) {
          const n = this.client?.items(e.conversationId).length ?? 0;
          if (n > 0) this.announce(t.historyLoaded(n));
        }
        break;
      case 'echoes':
        this.revision.update((v) => v + 1);
        break;
      case 'sendFailed':
        this.announce(t.sendFailed(this.i18n.reason(e.code)));
        break;
      case 'queue':
        this.queue.set(e.page);
        break;
      case 'subscriptionRefused':
        this.announce(this.i18n.reason(e.code));
        break;
      default:
        break;
    }
  }

  /** C4: aria-live="off" for the render of this batch, restored right after. */
  private suppressLiveRegion(): void {
    this.backfilling.set(true);
    if (this.restoreLiveTimer) clearTimeout(this.restoreLiveTimer);
    this.restoreLiveTimer = setTimeout(() => this.backfilling.set(false), 300);
  }

  private requireClient(): ChatClient {
    if (!this.client) throw new Error('ChatSession not started');
    return this.client;
  }

  private requireDeps(): ChatDeps {
    if (!this.deps) throw new Error('ChatSession not started');
    return this.deps;
  }
}
