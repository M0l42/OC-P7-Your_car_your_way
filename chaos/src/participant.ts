// One chat participant (customer or agent) driven by the SAME reliability core as chat-web (D21/O2).

import { Client } from '@stomp/stompjs';
import {
  ChatClient,
  DevTokenProvider,
  HttpChatApi,
  StompJsTransport,
  type StompClientLike,
  type TokenRole,
} from '../../chat-web/src/app/core/reliability/index.ts';
import type { ReceivedItem } from './checks.ts';

class MemoryStorage {
  private readonly m = new Map<string, string>();
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}

export class Participant {
  readonly tokens: DevTokenProvider;
  readonly api: HttpChatApi;
  readonly client: ChatClient;
  readonly received = new Map<number, ReceivedItem[]>();
  /** First time each clientMessageId reached this participant (performance.now()). */
  readonly receivedAt = new Map<string, number>();
  readonly acks = new Map<string, number[]>();
  readonly failures: string[] = [];
  /** Instance of every CONNECTED, in order (badge history). */
  readonly instances: string[] = [];
  /** Every state change with its time (s since process start), for post-mortems in the JSON result. */
  readonly transitions: string[] = [];
  lost = 0;
  restored = 0;

  constructor(
    readonly name: string,
    role: TokenRole,
    baseUrl: string,
    firstPath: '/ws' | '/ws-a' | '/ws-b',
  ) {
    this.tokens = new DevTokenProvider(baseUrl, { role, name });
    this.api = new HttpChatApi(baseUrl, this.tokens);
    const wsBase = baseUrl.replace(/^http/, 'ws');
    const transport = new StompJsTransport((cfg) => new Client(cfg) as unknown as StompClientLike, (path) => wsBase + path);
    this.client = new ChatClient({
      transport,
      api: this.api,
      tokens: this.tokens,
      storage: new MemoryStorage(),
      urls: { first: firstPath, reconnect: '/ws' },
      onInternalError: (e) => this.failures.push(`internal: ${String(e)}`),
    });
    this.client.on((e) => {
      switch (e.type) {
        case 'items': {
          const list = this.received.get(e.conversationId) ?? [];
          const now = performance.now();
          for (const it of e.items) {
            list.push({ seq: it.seq, clientMessageId: it.clientMessageId, type: it.type });
            if (!this.receivedAt.has(it.clientMessageId)) this.receivedAt.set(it.clientMessageId, now);
          }
          this.received.set(e.conversationId, list);
          break;
        }
        case 'ack': {
          const seqs = this.acks.get(e.ack.clientMessageId) ?? [];
          seqs.push(e.ack.seq);
          this.acks.set(e.ack.clientMessageId, seqs);
          break;
        }
        case 'sendFailed':
          this.failures.push(`send failed ${e.clientMessageId}: ${e.code}`);
          break;
        case 'serverError':
          this.failures.push(`server error ${e.code}`);
          break;
        case 'subscriptionRefused':
          this.failures.push(`subscription refused ${e.conversationId}: ${e.code}`);
          break;
        case 'state':
          if (e.state === 'subscribing' && e.instanceId) this.instances.push(e.instanceId);
          this.transitions.push(`${(performance.now() / 1000).toFixed(2)} ${e.state}@${e.instanceId ?? '-'}`);
          break;
        case 'connectionLost':
          this.lost++;
          break;
        case 'connectionRestored':
          this.restored++;
          break;
      }
    });
  }

  /** Sends and returns the clientMessageId (throws on client-side validation failure). */
  send(conversationId: number, text: string): string {
    const r = this.client.send(conversationId, text);
    if (!r.ok) throw new Error(`invalid content: ${r.code}`);
    return r.clientMessageId;
  }

  lastSeq(conversationId: number): number {
    return this.client.lastSeq(conversationId);
  }

  get unacked(): number {
    return this.client.outboxConversationIds().length;
  }
}
