import { ApiError, DevTokenProvider, HttpChatApi, type FetchFn } from './http-api';
import { FakeTokens, MemoryStorage } from './testing/fakes';

interface Call {
  url: string;
  method: string;
  auth?: string;
  body?: unknown;
}

function fakeFetch(responses: { status: number; body: unknown }[]): { fetchFn: FetchFn; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, method: init?.method ?? 'GET', auth: headers['Authorization'], body: init?.body ? JSON.parse(init.body as string) : undefined });
    const r = responses.shift();
    if (!r) throw new Error('unexpected fetch');
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } });
  };
  return { fetchFn, calls };
}

describe('HttpChatApi', () => {
  it.each([
    ['fetchMessages', (a: HttpChatApi) => a.fetchMessages(4, 17), 'GET', '/api/conversations/4/messages?afterSeq=17'],
    ['fetchQueue', (a: HttpChatApi) => a.fetchQueue(), 'GET', '/api/conversations?status=en_attente'],
    ['myConversations', (a: HttpChatApi) => a.myConversations(), 'GET', '/api/conversations'],
    ['getConversation', (a: HttpChatApi) => a.getConversation(4), 'GET', '/api/conversations/4'],
    ['claim', (a: HttpChatApi) => a.claim(4), 'POST', '/api/conversations/4/claim'],
    ['close', (a: HttpChatApi) => a.close(4), 'POST', '/api/conversations/4/close'],
  ])('%s → %s %s with the bearer token', async (_n, call, method, path) => {
    const { fetchFn, calls } = fakeFetch([{ status: 200, body: {} }]);
    await call(new HttpChatApi('http://h', new FakeTokens(), fetchFn));
    expect(calls).toEqual([{ url: `http://h${path}`, method, auth: 'Bearer token-1', body: undefined }]);
  });

  it('openConversation sends clientRequestId and a null reference when empty (A6)', async () => {
    const { fetchFn, calls } = fakeFetch([{ status: 201, body: { id: 1 } }]);
    await new HttpChatApi('', new FakeTokens(), fetchFn).openConversation('req-1', '');
    expect(calls[0].body).toEqual({ clientRequestId: 'req-1', reservationReference: null });
  });

  it('401 TOKEN_EXPIRED → renews once and retries with the new token (A5)', async () => {
    const tokens = new FakeTokens();
    const { fetchFn, calls } = fakeFetch([
      { status: 401, body: { code: 'TOKEN_EXPIRED', reason: 'expired' } },
      { status: 200, body: { items: [], total: 0 } },
    ]);
    await expect(new HttpChatApi('', tokens, fetchFn).fetchQueue()).resolves.toEqual({ items: [], total: 0 });
    expect(calls.map((c) => c.auth)).toEqual(['Bearer token-1', 'Bearer token-2']);
    expect(tokens.renewCalls).toBe(1);
  });

  it('a second 401 TOKEN_EXPIRED is not retried again', async () => {
    const { fetchFn } = fakeFetch([
      { status: 401, body: { code: 'TOKEN_EXPIRED' } },
      { status: 401, body: { code: 'TOKEN_EXPIRED' } },
    ]);
    await expect(new HttpChatApi('', new FakeTokens(), fetchFn).fetchQueue()).rejects.toMatchObject({ status: 401, code: 'TOKEN_EXPIRED' });
  });

  it.each([
    [409, { code: 'ALREADY_CLAIMED', reason: 'x' }, 'ALREADY_CLAIMED'],
    [404, { code: 'NOT_FOUND' }, 'NOT_FOUND'],
    [502, 'not json', 'HTTP_502'],
  ])('HTTP %i → ApiError %s', async (status, body, code) => {
    const { fetchFn } = fakeFetch([{ status, body }]);
    const err = await new HttpChatApi('', new FakeTokens(), fetchFn).claim(1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status, code });
  });
});

describe('DevTokenProvider (auth-stub, A5)', () => {
  const tokenBody = (n: number) => ({ token: `jwt-${n}`, tokenType: 'Bearer', expiresAt: 'x', subject: 'customer-ab12', role: 'customer' });

  it('issues once, caches, and renews for the SAME subject', async () => {
    const storage = new MemoryStorage();
    const { fetchFn, calls } = fakeFetch([
      { status: 200, body: tokenBody(1) },
      { status: 200, body: tokenBody(2) },
    ]);
    const p = new DevTokenProvider('http://h', { role: 'customer' }, storage, undefined, fetchFn);
    expect(await p.getToken()).toBe('jwt-1');
    expect(await p.getToken()).toBe('jwt-1');
    expect(await p.renew()).toBe('jwt-2');
    expect(calls.map((c) => [c.url, c.body])).toEqual([
      ['http://h/dev/tokens', { role: 'customer' }],
      ['http://h/dev/tokens', { role: 'customer', subject: 'customer-ab12' }],
    ]);
  });

  it('a reload keeps the identity from storage', async () => {
    const storage = new MemoryStorage();
    const first = fakeFetch([{ status: 200, body: tokenBody(1) }]);
    await new DevTokenProvider('', { role: 'customer' }, storage, undefined, first.fetchFn).getToken();
    const second = fakeFetch([]);
    const p = new DevTokenProvider('', { role: 'customer' }, storage, undefined, second.fetchFn);
    expect(await p.getToken()).toBe('jwt-1');
    expect(p.subject).toBe('customer-ab12');
    expect(second.calls).toEqual([]);
  });

  it('concurrent renewals share one request', async () => {
    const { fetchFn, calls } = fakeFetch([{ status: 200, body: tokenBody(1) }]);
    const p = new DevTokenProvider('', { role: 'agent' }, null, undefined, fetchFn);
    const [a, b] = await Promise.all([p.renew(), p.renew()]);
    expect([a, b]).toEqual(['jwt-1', 'jwt-1']);
    expect(calls.length).toBe(1);
  });
});
