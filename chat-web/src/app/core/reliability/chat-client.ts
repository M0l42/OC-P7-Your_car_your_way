// Reliability core of the chat client — framework-free (no Angular imports), shared by chat-web and
// the Node chaos client (D21/O2). Wire contract: docs/protocol.md.
//
// Connection state machine (one physical STOMP connection at a time; callbacks of a superseded
// connection are ignored through a generation counter):
//
//            start()
//   idle ───────────▶ connecting ──(token, transport.connect: 1st attempt → urls.first (/ws-a|/ws-b),
//                        ▲   │                               every later attempt → urls.reconnect (/ws))
//                        │   │ CONNECTED (instance-id → badge)
//                        │   ▼
//                        │ subscribing ── SUBSCRIBE /user/queue/acks + /user/queue/errors (no receipt)
//                        │   │            SUBSCRIBE /topic/conversations/{id}, /topic/queue WITH receipt
//                        │   │            resend every unacked outbox entry (same clientMessageId)
//                        │   │            arm per receipt: 5 s timeout ─────────────┐
//                        │   │            arm per subscribe: 2 s safety-net backfill │
//                        │   │ RECEIPT(id) → backfill that target (afterSeq=lastSeq, │
//                        │   │               pages until hasMore=false / queue GET)  │
//                        │   ▼ all receipts in                                       │
//                        │  ready ── attempt := 0; after a reconnect, once the       │
//                        │   │       post-receipt backfills settle → "restored, N"   │
//                        │   │                                                       │
//                        │   │ socket closed / ERROR / receipt timeout ◀─────────────┘
//                        │   ▼
//                        │ (lost) ── emit connectionLost once per outage; clear receipt/ack timers
//                        │   │
//                        │   ├── ERROR TOKEN_EXPIRED ──▶ renewing ── POST /dev/tokens ──┐ (immediate)
//                        │   └── otherwise ───────────▶ waiting ── backoff(attempt++) ──┤
//                        └──────────────────────────────────────────────────────────────┘
//   stop() from any state ──▶ stopped (no reconnect)
//
// Per conversation, ordering/dedup lives in ConversationStream (C1/P1); local echo + outbox in
// Outbox (C2/O11); the agent queue in QueueTracker. Sends while connected arm a 5 s ack timeout that
// resends with the same clientMessageId; sends while disconnected wait for the next connection.

import { DEFAULT_BACKOFF, backoffDelay, type BackoffOptions } from './backoff';
import { ConversationStream, type ItemSource } from './conversation-stream';
import { Outbox, type Echo } from './outbox';
import {
  newUuid,
  realClock,
  type ChatApi,
  type Clock,
  type KeyValueStorage,
  type TimerHandle,
  type TokenProvider,
  type Transport,
  type TransportHandlers,
} from './ports';
import {
  NOT_FOUND,
  TOKEN_EXPIRED,
  UNAUTHORIZED,
  destinations,
  validateContent,
  type Ack,
  type QueuePage,
  type SendError,
  type StreamItem,
} from './protocol';
import { QueueTracker } from './queue-tracker';

export type ConnectionState = 'idle' | 'connecting' | 'subscribing' | 'ready' | 'waiting' | 'renewing' | 'stopped';

export type ChatEvent =
  | { type: 'state'; state: ConnectionState; instanceId: string | null }
  | { type: 'connectionLost' }
  | { type: 'connectionRestored'; recovered: number }
  | { type: 'items'; conversationId: number; items: StreamItem[]; source: ItemSource }
  /** The post-RECEIPT backfill of a conversation finished (after each (re)subscribe). */
  | { type: 'synced'; conversationId: number }
  | { type: 'echoes'; conversationId: number }
  | { type: 'ack'; ack: Ack; first: boolean }
  | { type: 'sendFailed'; conversationId: number; clientMessageId: string; code: string }
  | { type: 'queue'; page: QueuePage }
  | { type: 'subscriptionRefused'; conversationId: number; code: string }
  | { type: 'serverError'; code: string; detail?: string };

export type ChatListener = (event: ChatEvent) => void;

export interface ChatClientOptions {
  transport: Transport;
  api: ChatApi;
  tokens: TokenProvider;
  /** First connection URL (demo pin /ws-a or /ws-b, C5) and every reconnect URL (/ws). */
  urls: { first: string; reconnect: string };
  clock?: Clock;
  storage?: KeyValueStorage | null;
  outboxStorageKey?: string;
  random?: () => number;
  newId?: () => string;
  /** Wall clock for echo timestamps (Date.now by default). */
  wallClock?: () => number;
  receiptTimeoutMs?: number;
  /** CONNECTED must arrive within this delay after transport.connect, else close + reconnect. */
  connectTimeoutMs?: number;
  safetyNetMs?: number;
  ackTimeoutMs?: number;
  backoff?: BackoffOptions;
  /** Disables the 2 s safety-net backfill (tests only; production keeps it on). */
  safetyNet?: boolean;
  onInternalError?: (e: unknown) => void;
}

interface Watched {
  stream: ConversationStream;
  subscriptionId: string | null;
  safetyTimer: TimerHandle | null;
}

type ReceiptTarget = { kind: 'conversation'; id: number } | { kind: 'queue' };

export class ChatClient {
  private readonly clock: Clock;
  private readonly random: () => number;
  private readonly newId: () => string;
  private readonly wallClock: () => number;
  private readonly receiptTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly safetyNetMs: number;
  private readonly ackTimeoutMs: number;
  private readonly backoff: BackoffOptions;
  private readonly safetyNetEnabled: boolean;
  private readonly onInternalError: (e: unknown) => void;

  private readonly listeners = new Set<ChatListener>();
  private readonly outbox: Outbox;
  private readonly watched = new Map<number, Watched>();
  private queue: { tracker: QueueTracker; subscriptionId: string | null; safetyTimer: TimerHandle | null } | null = null;

  private stateValue: ConnectionState = 'idle';
  private instanceIdValue: string | null = null;
  private generation = 0;
  private attempts = 0; // connection attempts made (selects first vs reconnect URL)
  private failures = 0; // consecutive failures since the last ready (backoff exponent)
  private connected = false;
  private renewNeeded = false;
  private renewStreak = 0;
  private unauthorizedRenewed = false; // UNAUTHORIZED triggers at most one renewal per outage
  private connectTimer: TimerHandle | null = null;
  private outage = false;
  private everReady = false;
  private receiptCounter = 0;
  private readonly pendingReceipts = new Map<string, { target: ReceiptTarget; timer: TimerHandle }>();
  private readonly ackTimers = new Map<string, TimerHandle>();
  private reconnectTimer: TimerHandle | null = null;
  private recovery: { count: number; outstanding: Promise<void>[] } | null = null;

  constructor(private readonly opts: ChatClientOptions) {
    this.clock = opts.clock ?? realClock;
    this.random = opts.random ?? Math.random;
    this.newId = opts.newId ?? newUuid;
    this.wallClock = opts.wallClock ?? Date.now;
    this.receiptTimeoutMs = opts.receiptTimeoutMs ?? 5000;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 10_000;
    this.safetyNetMs = opts.safetyNetMs ?? 2000;
    this.ackTimeoutMs = opts.ackTimeoutMs ?? 5000;
    this.backoff = opts.backoff ?? DEFAULT_BACKOFF;
    this.safetyNetEnabled = opts.safetyNet ?? true;
    this.onInternalError = opts.onInternalError ?? (() => undefined);
    this.outbox = new Outbox(opts.storage ?? null, opts.outboxStorageKey);
  }

  // ---- public API -----------------------------------------------------------------------------

  get state(): ConnectionState {
    return this.stateValue;
  }

  get instanceId(): string | null {
    return this.instanceIdValue;
  }

  on(listener: ChatListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (this.stateValue !== 'idle') return;
    void this.openConnection();
  }

  stop(): void {
    this.generation++;
    this.setState('stopped');
    this.clearConnectTimer();
    this.clearConnectionTimers();
    if (this.reconnectTimer !== null) this.clock.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    for (const w of this.watched.values()) w.stream.dispose();
    this.queue?.tracker.dispose();
    if (this.connected) {
      this.connected = false;
      this.opts.transport.close();
    }
  }

  watchConversation(conversationId: number): void {
    if (this.watched.has(conversationId)) return;
    const stream = new ConversationStream(
      conversationId,
      this.opts.api,
      this.clock,
      (items, source) => this.onItems(conversationId, items, source),
      0,
      this.onInternalError,
    );
    const w: Watched = { stream, subscriptionId: null, safetyTimer: null };
    this.watched.set(conversationId, w);
    if (this.connected) this.subscribeConversation(conversationId, w);
  }

  unwatchConversation(conversationId: number): void {
    const w = this.watched.get(conversationId);
    if (!w) return;
    this.watched.delete(conversationId);
    w.stream.dispose();
    if (w.safetyTimer !== null) this.clock.clearTimeout(w.safetyTimer);
    if (this.connected && w.subscriptionId) this.opts.transport.unsubscribe(w.subscriptionId);
    this.dropReceipts((t) => t.kind === 'conversation' && t.id === conversationId);
  }

  watchQueue(): void {
    if (this.queue) return;
    const tracker = new QueueTracker(this.opts.api, this.clock, (page) => this.emit({ type: 'queue', page }), this.onInternalError);
    this.queue = { tracker, subscriptionId: null, safetyTimer: null };
    if (this.connected) this.subscribeQueue();
  }

  unwatchQueue(): void {
    if (!this.queue) return;
    const q = this.queue;
    this.queue = null;
    q.tracker.dispose();
    if (q.safetyTimer !== null) this.clock.clearTimeout(q.safetyTimer);
    if (this.connected && q.subscriptionId) this.opts.transport.unsubscribe(q.subscriptionId);
    this.dropReceipts((t) => t.kind === 'queue');
  }

  /** Local removal from the queue after a claim (won, or 409 lost); next refetch is authoritative. */
  removeFromQueue(conversationId: number): void {
    this.queue?.tracker.remove(conversationId);
  }

  refetchQueue(): Promise<void> {
    return this.queue?.tracker.refetch() ?? Promise.resolve();
  }

  /** Validates, echoes ("envoi…"), persists and publishes (now if connected, else on reconnect). */
  send(conversationId: number, raw: string): { ok: true; clientMessageId: string } | { ok: false; code: 'EMPTY' | 'TOO_LONG' } {
    const v = validateContent(raw);
    if (!v.ok) return v;
    const clientMessageId = this.newId();
    this.outbox.add(conversationId, clientMessageId, v.content, this.wallClock());
    this.emit({ type: 'echoes', conversationId });
    if (this.connected) this.publish(this.outbox.get(clientMessageId)!);
    return { ok: true, clientMessageId };
  }

  dismissFailed(conversationId: number, clientMessageId: string): void {
    this.outbox.dismiss(clientMessageId);
    this.emit({ type: 'echoes', conversationId });
  }

  items(conversationId: number): readonly StreamItem[] {
    return this.watched.get(conversationId)?.stream.snapshot() ?? [];
  }

  lastSeq(conversationId: number): number {
    return this.watched.get(conversationId)?.stream.lastSeq ?? 0;
  }

  echoes(conversationId: number): Echo[] {
    return this.outbox.forConversation(conversationId);
  }

  /** Conversations with unacked entries restored from storage (O11) — lets the app re-watch them. */
  outboxConversationIds(): number[] {
    return [...new Set(this.outbox.unacked().map((e) => e.conversationId))];
  }

  queueSnapshot(): QueuePage {
    return this.queue?.tracker.snapshot ?? { items: [], total: 0 };
  }

  /** Backfill now (e.g. after a REST action like claim/close). */
  backfill(conversationId: number): Promise<void> {
    return this.watched.get(conversationId)?.stream.backfill() ?? Promise.resolve();
  }

  // ---- connection lifecycle -------------------------------------------------------------------

  private async openConnection(): Promise<void> {
    const gen = ++this.generation;
    const url = this.attempts++ === 0 ? this.opts.urls.first : this.opts.urls.reconnect;
    let token: string;
    try {
      if (this.renewNeeded) {
        this.setState('renewing');
        token = await this.opts.tokens.renew();
        this.renewNeeded = false;
      } else {
        this.setState('connecting');
        token = await this.opts.tokens.getToken();
      }
    } catch (e) {
      this.onInternalError(e);
      if (gen === this.generation && this.stateValue !== 'stopped') this.scheduleReconnect();
      return;
    }
    if (gen !== this.generation || this.stateValue === 'stopped') return;
    if (this.stateValue === 'renewing') this.setState('connecting');
    const handlers: TransportHandlers = {
      onConnected: (info) => gen === this.generation && this.handleConnected(info.instanceId ?? null),
      onReceipt: (id) => gen === this.generation && this.handleReceipt(id),
      onMessage: (dest, body) => gen === this.generation && this.handleMessage(dest, body),
      onError: (err) => gen === this.generation && this.handleError(err),
      onClose: () => gen === this.generation && this.handleClose(),
    };
    this.connectTimer = this.clock.setTimeout(() => {
      this.connectTimer = null;
      // Handshake or CONNECT hanging (e.g. instance killed mid-handshake): give up on this socket.
      if (gen === this.generation && !this.connected) {
        this.handleClose();
        this.opts.transport.close();
      }
    }, this.connectTimeoutMs);
    try {
      this.opts.transport.connect(url, token, handlers);
    } catch (e) {
      this.onInternalError(e);
      if (gen === this.generation) this.handleClose();
    }
  }

  private handleConnected(instanceId: string | null): void {
    this.clearConnectTimer();
    this.connected = true;
    this.instanceIdValue = instanceId;
    this.renewStreak = 0;
    const isReconnect = this.everReady;
    this.recovery = isReconnect ? { count: 0, outstanding: [] } : null;
    this.setState('subscribing');
    const t = this.opts.transport;
    t.subscribe(destinations.acks);
    t.subscribe(destinations.errors);
    for (const [id, w] of this.watched) this.subscribeConversation(id, w);
    if (this.queue) this.subscribeQueue();
    for (const echo of this.outbox.unacked()) this.publish(echo);
    this.maybeReady();
  }

  private subscribeConversation(id: number, w: Watched): void {
    const receiptId = this.armReceipt({ kind: 'conversation', id });
    w.subscriptionId = this.opts.transport.subscribe(destinations.conversationTopic(id), receiptId);
    if (w.safetyTimer !== null) this.clock.clearTimeout(w.safetyTimer);
    w.safetyTimer = this.safetyNetEnabled
      ? this.clock.setTimeout(() => {
          w.safetyTimer = null;
          if (this.watched.get(id) === w) void w.stream.backfill();
        }, this.safetyNetMs)
      : null;
  }

  private subscribeQueue(): void {
    const q = this.queue!;
    const receiptId = this.armReceipt({ kind: 'queue' });
    q.subscriptionId = this.opts.transport.subscribe(destinations.queueTopic, receiptId);
    if (q.safetyTimer !== null) this.clock.clearTimeout(q.safetyTimer);
    q.safetyTimer = this.safetyNetEnabled
      ? this.clock.setTimeout(() => {
          q.safetyTimer = null;
          if (this.queue === q) void q.tracker.refetch();
        }, this.safetyNetMs)
      : null;
  }

  private armReceipt(target: ReceiptTarget): string {
    const receiptId = `r-${target.kind === 'queue' ? 'queue' : target.id}-${++this.receiptCounter}`;
    const timer = this.clock.setTimeout(() => {
      if (this.pendingReceipts.has(receiptId)) this.forceReconnect();
    }, this.receiptTimeoutMs);
    this.pendingReceipts.set(receiptId, { target, timer });
    return receiptId;
  }

  private handleReceipt(receiptId: string): void {
    const pending = this.pendingReceipts.get(receiptId);
    if (!pending) return;
    this.clock.clearTimeout(pending.timer);
    this.pendingReceipts.delete(receiptId);
    // The subscription is registered on the broker: anything committed from now on arrives live,
    // so a snapshot taken now closes the gap (A1).
    let done: Promise<void> | null = null;
    if (pending.target.kind === 'conversation') {
      const id = pending.target.id;
      const gen = this.generation;
      done = this.watched.get(id)?.stream.backfill() ?? null;
      void done?.then(() => {
        if (gen === this.generation && this.watched.has(id)) this.emit({ type: 'synced', conversationId: id });
      });
    } else if (this.queue) {
      done = this.queue.tracker.refetch();
    }
    if (done && this.recovery) this.recovery.outstanding.push(done);
    this.maybeReady();
  }

  private maybeReady(): void {
    if (this.stateValue !== 'subscribing' || this.pendingReceipts.size > 0) return;
    this.failures = 0;
    this.unauthorizedRenewed = false;
    this.everReady = true;
    this.setState('ready');
    const recovery = this.recovery;
    if (!recovery) return;
    const gen = this.generation;
    void Promise.all(recovery.outstanding).then(() => {
      if (gen !== this.generation || this.recovery !== recovery) return;
      this.recovery = null;
      this.outage = false;
      this.emit({ type: 'connectionRestored', recovered: recovery.count });
    });
  }

  private handleMessage(destination: string, body: string): void {
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch (e) {
      this.onInternalError(e);
      return;
    }
    if (destination === destinations.acks) return this.handleAck(payload as Ack);
    if (destination === destinations.errors) return this.handleSendError(payload as SendError);
    if (destination === destinations.queueTopic) {
      void this.queue?.tracker.refetch();
      return;
    }
    const item = payload as StreamItem;
    const w = this.watched.get(item.conversationId);
    if (w && destination === destinations.conversationTopic(item.conversationId)) w.stream.receiveLive(item);
  }

  private handleAck(ack: Ack): void {
    this.clearAckTimer(ack.clientMessageId);
    const echo = this.outbox.ack(ack.clientMessageId, ack.seq);
    this.emit({ type: 'ack', ack, first: echo !== null });
    if (echo) this.emit({ type: 'echoes', conversationId: echo.conversationId });
  }

  private handleSendError(err: SendError): void {
    if (!err.clientMessageId) {
      this.emit({ type: 'serverError', code: err.code, detail: err.reason });
      return;
    }
    this.clearAckTimer(err.clientMessageId);
    const echo = this.outbox.fail(err.clientMessageId, err.code);
    if (!echo) return;
    this.emit({ type: 'echoes', conversationId: echo.conversationId });
    this.emit({ type: 'sendFailed', conversationId: echo.conversationId, clientMessageId: echo.clientMessageId, code: err.code });
  }

  private handleError(err: { code: string; receiptId?: string; detail?: string }): void {
    if (err.code === TOKEN_EXPIRED || (err.code === UNAUTHORIZED && !this.unauthorizedRenewed)) {
      // Expired token (A5), or a token the server rejects: fetch a fresh one before reconnecting.
      // A second UNAUTHORIZED in the same outage is surfaced instead of looping on renewals.
      if (err.code === UNAUTHORIZED) this.unauthorizedRenewed = true;
      this.renewNeeded = true;
      return;
    }
    const target = err.receiptId ? this.pendingReceipts.get(err.receiptId)?.target : undefined;
    if (target?.kind === 'conversation') {
      // Subscription refused (NOT_FOUND/FORBIDDEN): stop watching it, or every reconnect would fail again.
      this.unwatchConversation(target.id);
      this.emit({ type: 'subscriptionRefused', conversationId: target.id, code: err.code });
      return;
    }
    if (err.code !== NOT_FOUND) this.emit({ type: 'serverError', code: err.code, detail: err.detail });
  }

  private forceReconnect(): void {
    if (!this.connected) return;
    this.handleClose();
    this.opts.transport.close();
  }

  private handleClose(): void {
    this.generation++; // late callbacks of this connection are ignored from here on
    const wasConnected = this.connected;
    this.connected = false;
    this.instanceIdValue = null; // badge shows "no instance" until the next CONNECTED (C5 demo)
    this.clearConnectTimer();
    this.clearConnectionTimers();
    this.recovery = null;
    if (this.stateValue === 'stopped') return;
    if (wasConnected && this.everReady && !this.outage) {
      this.outage = true;
      this.emit({ type: 'connectionLost' });
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    let delay: number;
    if (this.renewNeeded && this.renewStreak++ === 0) {
      delay = 0; // first TOKEN_EXPIRED: renew right away; repeated ones fall back to backoff
    } else {
      delay = backoffDelay(this.failures++, this.random, this.backoff);
    }
    this.setState(this.renewNeeded ? 'renewing' : 'waiting');
    if (this.reconnectTimer !== null) this.clock.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = this.clock.setTimeout(() => {
      this.reconnectTimer = null;
      void this.openConnection();
    }, delay);
  }

  private clearConnectionTimers(): void {
    for (const { timer } of this.pendingReceipts.values()) this.clock.clearTimeout(timer);
    this.pendingReceipts.clear();
    for (const timer of this.ackTimers.values()) this.clock.clearTimeout(timer);
    this.ackTimers.clear();
    for (const w of this.watched.values()) {
      w.subscriptionId = null;
      if (w.safetyTimer !== null) this.clock.clearTimeout(w.safetyTimer);
      w.safetyTimer = null;
    }
    if (this.queue) {
      this.queue.subscriptionId = null;
      if (this.queue.safetyTimer !== null) this.clock.clearTimeout(this.queue.safetyTimer);
      this.queue.safetyTimer = null;
    }
  }

  private clearConnectTimer(): void {
    if (this.connectTimer !== null) this.clock.clearTimeout(this.connectTimer);
    this.connectTimer = null;
  }

  private dropReceipts(match: (t: ReceiptTarget) => boolean): void {
    for (const [id, p] of this.pendingReceipts) {
      if (match(p.target)) {
        this.clock.clearTimeout(p.timer);
        this.pendingReceipts.delete(id);
      }
    }
    this.maybeReady();
  }

  // ---- outbox / items -------------------------------------------------------------------------

  private publish(echo: Echo): void {
    this.opts.transport.publish(
      destinations.send(echo.conversationId),
      JSON.stringify({ clientMessageId: echo.clientMessageId, content: echo.content }),
    );
    this.clearAckTimer(echo.clientMessageId);
    const id = echo.clientMessageId;
    this.ackTimers.set(
      id,
      this.clock.setTimeout(() => {
        this.ackTimers.delete(id);
        const current = this.outbox.get(id);
        if (this.connected && current?.status === 'sending') this.publish(current);
      }, this.ackTimeoutMs),
    );
  }

  private clearAckTimer(clientMessageId: string): void {
    const t = this.ackTimers.get(clientMessageId);
    if (t !== undefined) {
      this.clock.clearTimeout(t);
      this.ackTimers.delete(clientMessageId);
    }
  }

  private onItems(conversationId: number, items: StreamItem[], source: ItemSource): void {
    if (source === 'backfill' && this.recovery) this.recovery.count += items.length;
    let echoesChanged = false;
    for (const item of items) {
      if (this.outbox.resolve(item.clientMessageId)) {
        this.clearAckTimer(item.clientMessageId);
        echoesChanged = true;
      }
    }
    this.emit({ type: 'items', conversationId, items, source });
    if (echoesChanged) this.emit({ type: 'echoes', conversationId });
  }

  private setState(state: ConnectionState): void {
    if (this.stateValue === state) return;
    this.stateValue = state;
    this.emit({ type: 'state', state, instanceId: this.instanceIdValue });
  }

  private emit(event: ChatEvent): void {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch (e) {
        this.onInternalError(e);
      }
    }
  }
}
