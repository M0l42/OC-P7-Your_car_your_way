// Ports of the reliability core. Production adapters: stomp-transport.ts (@stomp/stompjs),
// http-api.ts (fetch), realClock, browser/Node storage. Tests use testing/fakes.ts.

import type { MessagePage, QueuePage } from './protocol';

export type TimerHandle = unknown;

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

export const realClock: Clock = {
  now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** Callbacks of one physical connection. The core ignores callbacks of superseded connections. */
export interface TransportHandlers {
  /** STOMP CONNECTED. `instanceId` comes from the CONNECTED frame (instance badge, C5). */
  onConnected(info: { instanceId?: string }): void;
  onReceipt(receiptId: string): void;
  onMessage(destination: string, body: string): void;
  /**
   * STOMP ERROR frame: `code` is the frame's `message` header (TOKEN_EXPIRED, UNAUTHORIZED,
   * NOT_FOUND, FORBIDDEN), `receiptId` its `receipt-id` header when the failing frame had one.
   */
  onError(error: { code: string; receiptId?: string; detail?: string }): void;
  /** Socket closed (always called last, also after an ERROR or a failed handshake). */
  onClose(): void;
}

export interface Transport {
  connect(url: string, token: string, handlers: TransportHandlers): void;
  /** Returns a subscription id. When `receiptId` is set the server answers with a RECEIPT. */
  subscribe(destination: string, receiptId?: string): string;
  unsubscribe(subscriptionId: string): void;
  publish(destination: string, body: string): void;
  /** Closes the current connection; onClose follows. */
  close(): void;
}

export interface ChatApi {
  fetchMessages(conversationId: number, afterSeq: number): Promise<MessagePage>;
  fetchQueue(): Promise<QueuePage>;
}

export interface TokenProvider {
  getToken(): Promise<string>;
  /** Fetches a fresh token from auth-stub (A5). */
  renew(): Promise<string>;
}

/** Subset of the Web Storage API (sessionStorage in the browser, in-memory in Node). */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function newUuid(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  // crypto.randomUUID only exists in secure contexts; fall back to getRandomValues (RFC 4122 v4).
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
