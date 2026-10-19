// Angular-side test wiring: real ChatSession + real ChatClient over the core fakes.

import type { Provider } from '@angular/core';
import { CHAT_DEPS, type ChatDeps } from '../core/chat-session';
import type { ChatRestApi, Conversation, TokenRole } from '../core/reliability';
import { FakeApi, FakeClock, FakeTokens, FakeTransport, MemoryStorage, deferred, flush, type Deferred } from '../core/reliability/testing/fakes';

export class FakeRestApi extends FakeApi implements ChatRestApi {
  readonly actions: { op: string; args: unknown[]; reply: Deferred<unknown> }[] = [];

  private record<T>(op: string, ...args: unknown[]): Promise<T> {
    const reply = deferred<unknown>();
    this.actions.push({ op, args, reply });
    return reply.promise as Promise<T>;
  }
  myConversations() {
    return this.record<{ items: Conversation[]; total: number }>('myConversations');
  }
  getConversation(id: number) {
    return this.record<Conversation>('getConversation', id);
  }
  openConversation(clientRequestId: string, reservationReference?: string | null) {
    return this.record<Conversation>('openConversation', clientRequestId, reservationReference);
  }
  claim(id: number) {
    return this.record<Conversation>('claim', id);
  }
  close(id: number) {
    return this.record<Conversation>('close', id);
  }

  /** Answers the oldest pending action named `op`. */
  async answer(op: string, value: unknown, fail = false): Promise<unknown[]> {
    const i = this.actions.findIndex((a) => a.op === op);
    if (i < 0) throw new Error(`no pending ${op}`);
    const [a] = this.actions.splice(i, 1);
    if (fail) a.reply.reject(value);
    else a.reply.resolve(value);
    await flush();
    return a.args;
  }
}

export class SubjectTokens extends FakeTokens {
  constructor(readonly subject: string) {
    super();
  }
}

export interface TestChat {
  transport: FakeTransport;
  api: FakeRestApi;
  clock: FakeClock;
  storage: MemoryStorage;
  tokens: SubjectTokens;
  roles: TokenRole[];
  providers: Provider[];
}

export function testChat(subject = 'customer-1', storage = new MemoryStorage()): TestChat {
  const t: TestChat = {
    transport: new FakeTransport(),
    api: new FakeRestApi(),
    clock: new FakeClock(),
    storage,
    tokens: new SubjectTokens(subject),
    roles: [],
    providers: [],
  };
  const factory = (role: TokenRole): ChatDeps => {
    t.roles.push(role);
    return { transport: t.transport, api: t.api, tokens: t.tokens, storage: t.storage, urls: { first: '/ws-a', reconnect: '/ws' }, clock: t.clock };
  };
  t.providers = [{ provide: CHAT_DEPS, useValue: factory }];
  return t;
}

export function conversation(id: number, over: Partial<Conversation> = {}): Conversation {
  return {
    id,
    status: 'en_attente',
    customerRef: 'customer-1',
    customerKind: 'compte',
    reservationReference: null,
    agentRef: null,
    lastSeq: 0,
    createdAt: '2026-10-19T10:00:00.000Z',
    claimedAt: null,
    closedAt: null,
    ...over,
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
