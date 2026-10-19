// Test doubles for the reliability core: manual clock, scripted transport, deferred REST API.

import type { ChatApi, Clock, KeyValueStorage, TimerHandle, TokenProvider, Transport, TransportHandlers } from '../ports';
import type { MessagePage, QueuePage, StreamItem } from '../protocol';

/** Deterministic clock: timers only fire on advance(). */
export class FakeClock implements Clock {
  private t = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();

  now(): number {
    return this.t;
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = this.nextId++;
    this.timers.set(id, { at: this.t + Math.max(0, ms), fn });
    return id;
  }

  clearTimeout(handle: TimerHandle): void {
    this.timers.delete(handle as number);
  }

  /** Advances time, firing due timers in order (timers created meanwhile included). */
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      let due: [number, { at: number; fn: () => void }] | undefined;
      for (const e of this.timers) if (e[1].at <= end && (!due || e[1].at < due[1].at)) due = e;
      if (!due) break;
      this.timers.delete(due[0]);
      this.t = due[1].at;
      due[1].fn();
      await flush();
    }
    this.t = end;
    await flush();
  }

  get pendingTimers(): number {
    return this.timers.size;
  }
}

/** Lets pending promise callbacks run. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(v: T): void;
  reject(e: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** REST double: every call is recorded and answered by the test. */
export class FakeApi implements ChatApi {
  readonly messageCalls: { conversationId: number; afterSeq: number; reply: Deferred<MessagePage> }[] = [];
  readonly queueCalls: Deferred<QueuePage>[] = [];

  fetchMessages(conversationId: number, afterSeq: number): Promise<MessagePage> {
    const reply = deferred<MessagePage>();
    this.messageCalls.push({ conversationId, afterSeq, reply });
    return reply.promise;
  }

  fetchQueue(): Promise<QueuePage> {
    const reply = deferred<QueuePage>();
    this.queueCalls.push(reply);
    return reply.promise;
  }

  /** Answers the oldest unanswered messages call. */
  async replyMessages(page: MessagePage): Promise<{ conversationId: number; afterSeq: number }> {
    const call = this.messageCalls.shift();
    if (!call) throw new Error('no pending fetchMessages call');
    call.reply.resolve(page);
    await flush();
    return call;
  }

  async failMessages(e: unknown = new Error('network')): Promise<void> {
    const call = this.messageCalls.shift();
    if (!call) throw new Error('no pending fetchMessages call');
    call.reply.reject(e);
    await flush();
  }

  async replyQueue(page: QueuePage): Promise<void> {
    const call = this.queueCalls.shift();
    if (!call) throw new Error('no pending fetchQueue call');
    call.resolve(page);
    await flush();
  }
}

export class FakeTokens implements TokenProvider {
  issued = 1;
  renewCalls = 0;
  getToken(): Promise<string> {
    return Promise.resolve(`token-${this.issued}`);
  }
  renew(): Promise<string> {
    this.renewCalls++;
    this.issued++;
    return Promise.resolve(`token-${this.issued}`);
  }
}

export type TransportCall =
  | { op: 'connect'; url: string; token: string }
  | { op: 'subscribe'; destination: string; receiptId?: string; id: string }
  | { op: 'unsubscribe'; id: string }
  | { op: 'publish'; destination: string; body: string }
  | { op: 'close' };

/** Scripted STOMP transport: records calls, the test plays the server side. */
export class FakeTransport implements Transport {
  readonly calls: TransportCall[] = [];
  private handlers: TransportHandlers | null = null;
  private subCounter = 0;
  /** Subscriptions of the current connection by destination. */
  readonly active = new Map<string, string>();

  connect(url: string, token: string, handlers: TransportHandlers): void {
    this.calls.push({ op: 'connect', url, token });
    this.handlers = handlers;
    this.active.clear();
  }

  subscribe(destination: string, receiptId?: string): string {
    const id = `sub-${++this.subCounter}`;
    this.calls.push({ op: 'subscribe', destination, receiptId, id });
    this.active.set(destination, id);
    return id;
  }

  unsubscribe(id: string): void {
    this.calls.push({ op: 'unsubscribe', id });
    for (const [d, s] of this.active) if (s === id) this.active.delete(d);
  }

  publish(destination: string, body: string): void {
    this.calls.push({ op: 'publish', destination, body });
  }

  close(): void {
    this.calls.push({ op: 'close' });
    const h = this.handlers;
    this.handlers = null;
    h?.onClose();
  }

  // ---- server side ----
  private h(): TransportHandlers {
    if (!this.handlers) throw new Error('not connected');
    return this.handlers;
  }
  connected(instanceId = 'chat-1'): void {
    this.h().onConnected({ instanceId });
  }
  receipt(receiptId: string): void {
    this.h().onReceipt(receiptId);
  }
  /** RECEIPT for every receipt requested so far on this connection (in order). */
  receiptAll(): void {
    for (const r of this.receiptsRequested()) this.h().onReceipt(r);
  }
  message(destination: string, payload: unknown): void {
    this.h().onMessage(destination, JSON.stringify(payload));
  }
  error(code: string, receiptId?: string): void {
    this.h().onError({ code, receiptId });
  }
  /** Server-side close (instance killed): closes and drops the handlers. */
  drop(): void {
    const h = this.h();
    this.handlers = null;
    h.onClose();
  }

  get isConnected(): boolean {
    return this.handlers !== null;
  }
  connects(): Extract<TransportCall, { op: 'connect' }>[] {
    return this.calls.filter((c): c is Extract<TransportCall, { op: 'connect' }> => c.op === 'connect');
  }
  /** Calls since the latest connect. */
  sinceConnect(): TransportCall[] {
    const i = this.calls.map((c) => c.op).lastIndexOf('connect');
    return this.calls.slice(i + 1);
  }
  receiptsRequested(): string[] {
    return this.sinceConnect().flatMap((c) => (c.op === 'subscribe' && c.receiptId ? [c.receiptId] : []));
  }
  receiptFor(destination: string): string {
    const sub = [...this.sinceConnect()].reverse().find((c) => c.op === 'subscribe' && c.destination === destination);
    if (!sub || sub.op !== 'subscribe' || !sub.receiptId) throw new Error(`no receipt requested for ${destination}`);
    return sub.receiptId;
  }
  publishes(): { destination: string; body: { clientMessageId: string; content: string } }[] {
    return this.calls.flatMap((c) => (c.op === 'publish' ? [{ destination: c.destination, body: JSON.parse(c.body) }] : []));
  }
}

export class MemoryStorage implements KeyValueStorage {
  readonly map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
}

export function item(conversationId: number, seq: number, extra: Partial<StreamItem> = {}): StreamItem {
  return {
    conversationId,
    seq,
    clientMessageId: `cm-${conversationId}-${seq}`,
    type: 'texte',
    senderRole: 'agent',
    senderRef: 'agent-1',
    content: `m${seq}`,
    createdAt: '2026-10-19T10:00:00.000Z',
    ...extra,
  };
}

export function items(conversationId: number, from: number, to: number): StreamItem[] {
  const out: StreamItem[] = [];
  for (let s = from; s <= to; s++) out.push(item(conversationId, s));
  return out;
}

/** Sequential ids id-1, id-2, … */
export function idSequence(prefix = 'id'): () => string {
  let n = 0;
  return () => `${prefix}-${++n}`;
}
