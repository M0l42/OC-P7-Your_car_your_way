import type { TransportHandlers } from './ports';
import { StompJsTransport, type StompClientConfigLike, type StompClientLike, type StompFrameLike } from './stomp-transport';

/** Minimal stand-in for @stomp/stompjs Client: records calls, lets the test fire callbacks. */
class FakeStompClient implements StompClientLike {
  onConnect: (frame: StompFrameLike) => void = () => undefined;
  onStompError: (frame: StompFrameLike) => void = () => undefined;
  onWebSocketClose: (evt: unknown) => void = () => undefined;
  onWebSocketError: (evt: unknown) => void = () => undefined;
  activated = false;
  deactivated = false;
  readonly subs: { destination: string; headers?: Record<string, string>; cb: (m: StompFrameLike) => void; unsubscribed: boolean }[] = [];
  readonly receipts = new Map<string, (f: StompFrameLike) => void>();
  readonly published: { destination: string; body: string; headers?: Record<string, string> }[] = [];
  constructor(readonly config: StompClientConfigLike) {}
  activate() {
    this.activated = true;
  }
  async deactivate() {
    this.deactivated = true;
    this.onWebSocketClose({});
  }
  subscribe(destination: string, cb: (m: StompFrameLike) => void, headers?: Record<string, string>) {
    const s = { destination, headers, cb, unsubscribed: false };
    this.subs.push(s);
    return { id: `sub-${this.subs.length - 1}`, unsubscribe: () => (s.unsubscribed = true) };
  }
  publish(p: { destination: string; body: string; headers?: Record<string, string> }) {
    this.published.push(p);
  }
  watchForReceipt(id: string, cb: (f: StompFrameLike) => void) {
    this.receipts.set(id, cb);
  }
}

function setup() {
  const clients: FakeStompClient[] = [];
  const t = new StompJsTransport(
    (cfg) => {
      const c = new FakeStompClient(cfg);
      clients.push(c);
      return c;
    },
    (path) => `ws://host${path}`,
  );
  const log: string[] = [];
  const h: TransportHandlers = {
    onConnected: (i) => log.push(`connected ${i.instanceId}`),
    onReceipt: (r) => log.push(`receipt ${r}`),
    onMessage: (d, b) => log.push(`message ${d} ${b}`),
    onError: (e) => log.push(`error ${e.code} ${e.receiptId ?? '-'}`),
    onClose: () => log.push('close'),
  };
  return { t, clients, log, h };
}

describe('StompJsTransport', () => {
  it('configures stompjs: bearer token, own reconnect disabled, heart-beats 10 s', () => {
    const s = setup();
    s.t.connect('/ws-a', 'jwt', s.h);
    expect(s.clients[0].config).toEqual({
      brokerURL: 'ws://host/ws-a',
      connectHeaders: { Authorization: 'Bearer jwt' },
      reconnectDelay: 0,
      heartbeatIncoming: 10_000,
      heartbeatOutgoing: 10_000,
    });
    expect(s.clients[0].activated).toBe(true);
  });

  it('maps CONNECTED instance-id, receipts, messages and ERROR message/receipt-id headers', () => {
    const s = setup();
    s.t.connect('/ws', 'jwt', s.h);
    const c = s.clients[0];
    c.onConnect({ headers: { 'instance-id': 'chat-2' }, body: '' });
    s.t.subscribe('/user/queue/acks');
    s.t.subscribe('/topic/conversations/1', 'r-1');
    expect(c.subs.map((x) => [x.destination, x.headers])).toEqual([
      ['/user/queue/acks', {}],
      ['/topic/conversations/1', { receipt: 'r-1' }],
    ]);
    c.receipts.get('r-1')!({ headers: {}, body: '' });
    c.subs[1].cb({ headers: {}, body: '{"seq":1}' });
    c.onStompError({ headers: { message: 'NOT_FOUND', 'receipt-id': 'r-1' }, body: 'NOT_FOUND whatever' });
    c.onWebSocketClose({});
    c.onWebSocketClose({});
    expect(s.log).toEqual(['connected chat-2', 'receipt r-1', 'message /topic/conversations/1 {"seq":1}', 'error NOT_FOUND r-1', 'close']);
  });

  it('publishes JSON with content-type and unsubscribes by id', () => {
    const s = setup();
    s.t.connect('/ws', 'jwt', s.h);
    const id = s.t.subscribe('/topic/queue', 'r-q');
    s.t.unsubscribe(id);
    s.t.publish('/app/conversations/1/messages', '{}');
    expect(s.clients[0].subs[0].unsubscribed).toBe(true);
    expect(s.clients[0].published).toEqual([{ destination: '/app/conversations/1/messages', body: '{}', headers: { 'content-type': 'application/json' } }]);
  });

  it('close() force-deactivates; late frames of the old client still go to the old handlers only', () => {
    const s = setup();
    s.t.connect('/ws', 'jwt', s.h);
    s.t.subscribe('/topic/conversations/1', 'r-1');
    s.t.close();
    expect(s.clients[0].deactivated).toBe(true);
    const log2: string[] = [];
    s.t.connect('/ws', 'jwt2', { ...s.h, onMessage: (d) => log2.push(d) });
    s.clients[0].subs[0].cb({ headers: {}, body: '{}' });
    expect(log2).toEqual([]);
  });

  it('subscribe without a connection throws', () => {
    expect(() => setup().t.subscribe('/topic/queue')).toThrow();
  });
});
