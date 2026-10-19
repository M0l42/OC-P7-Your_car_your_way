// Transport adapter over @stomp/stompjs. The library is injected (structural types below) so this
// file has no package import: chat-web and chaos/ each pass their own `Client` constructor.

import type { Transport, TransportHandlers } from './ports';

export interface StompFrameLike {
  headers: Record<string, string>;
  body: string;
}

export interface StompSubscriptionLike {
  id: string;
  unsubscribe(): void;
}

/** The subset of @stomp/stompjs `Client` used here. */
export interface StompClientLike {
  onConnect: (frame: StompFrameLike) => void;
  onStompError: (frame: StompFrameLike) => void;
  onWebSocketClose: (evt: unknown) => void;
  onWebSocketError: (evt: unknown) => void;
  activate(): void;
  deactivate(options?: { force?: boolean }): Promise<void>;
  subscribe(destination: string, callback: (message: StompFrameLike) => void, headers?: Record<string, string>): StompSubscriptionLike;
  publish(params: { destination: string; body: string; headers?: Record<string, string> }): void;
  watchForReceipt(receiptId: string, callback: (frame: StompFrameLike) => void): void;
}

export interface StompClientConfigLike {
  brokerURL: string;
  connectHeaders: Record<string, string>;
  reconnectDelay: number;
  heartbeatIncoming: number;
  heartbeatOutgoing: number;
  webSocketFactory?: () => unknown;
}

export type StompClientFactory = (config: StompClientConfigLike) => StompClientLike;

/**
 * One stompjs Client per physical connection, with stompjs' own reconnect disabled
 * (reconnectDelay 0): reconnect, backoff and URL selection belong to the core state machine.
 */
export class StompJsTransport implements Transport {
  private client: StompClientLike | null = null;
  private readonly subs = new Map<string, StompSubscriptionLike>();
  private closed = true;
  private lastHandlers: TransportHandlers | null = null;

  constructor(
    private readonly factory: StompClientFactory,
    /** Turns a path such as /ws into an absolute ws:// or wss:// URL. */
    private readonly resolveUrl: (path: string) => string,
  ) {}

  connect(url: string, token: string, h: TransportHandlers): void {
    this.subs.clear();
    this.closed = false;
    this.lastHandlers = h;
    let closeReported = false;
    const reportClose = () => {
      if (closeReported) return;
      closeReported = true;
      h.onClose();
    };
    const client = this.factory({
      brokerURL: this.resolveUrl(url),
      connectHeaders: { Authorization: `Bearer ${token}` },
      reconnectDelay: 0,
      heartbeatIncoming: 10_000,
      heartbeatOutgoing: 10_000,
    });
    client.onConnect = (frame) => h.onConnected({ instanceId: frame.headers['instance-id'] });
    client.onStompError = (frame) =>
      h.onError({ code: frame.headers['message'] ?? 'ERROR', receiptId: frame.headers['receipt-id'], detail: frame.body });
    client.onWebSocketClose = () => {
      if (this.client === client) this.client = null;
      reportClose();
    };
    client.onWebSocketError = () => undefined; // a close event always follows
    this.client = client;
    client.activate();
  }

  subscribe(destination: string, receiptId?: string): string {
    const client = this.requireClient();
    const h = this.lastHandlers!; // handlers of THIS connection, even if a late frame arrives after a reconnect
    if (receiptId) client.watchForReceipt(receiptId, () => h.onReceipt(receiptId));
    const sub = client.subscribe(
      destination,
      (msg) => h.onMessage(destination, msg.body),
      receiptId ? { receipt: receiptId } : {},
    );
    this.subs.set(sub.id, sub);
    return sub.id;
  }

  unsubscribe(subscriptionId: string): void {
    this.subs.get(subscriptionId)?.unsubscribe();
    this.subs.delete(subscriptionId);
  }

  publish(destination: string, body: string): void {
    this.requireClient().publish({ destination, body, headers: { 'content-type': 'application/json' } });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const c = this.client;
    this.client = null;
    void c?.deactivate({ force: true });
  }

  private requireClient(): StompClientLike {
    if (!this.client) throw new Error('STOMP transport not connected');
    return this.client;
  }
}
