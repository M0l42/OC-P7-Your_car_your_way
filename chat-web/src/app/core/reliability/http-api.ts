// fetch-based REST adapter (browser and Node 24 both have global fetch). docs/protocol.md §4, §6.

import type { ChatApi, KeyValueStorage, TokenProvider } from './ports';
import { newUuid } from './ports';
import { TOKEN_EXPIRED, type ApiErrorBody, type Conversation, type MessagePage, type QueuePage } from './protocol';

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    reason?: string,
  ) {
    super(`${status} ${code}${reason ? `: ${reason}` : ''}`);
    this.name = 'ApiError';
  }
}

export class HttpChatApi implements ChatApi {
  constructor(
    private readonly baseUrl: string,
    private readonly tokens: TokenProvider,
    private readonly fetchFn: FetchFn = (i, init) => fetch(i, init),
  ) {}

  fetchMessages(conversationId: number, afterSeq: number): Promise<MessagePage> {
    return this.request('GET', `/api/conversations/${conversationId}/messages?afterSeq=${afterSeq}`);
  }

  fetchQueue(): Promise<QueuePage> {
    return this.request('GET', '/api/conversations?status=en_attente');
  }

  myConversations(): Promise<QueuePage> {
    return this.request('GET', '/api/conversations');
  }

  getConversation(id: number): Promise<Conversation> {
    return this.request('GET', `/api/conversations/${id}`);
  }

  /** Idempotent open (A6): reuse the same clientRequestId when retrying the same action. */
  openConversation(clientRequestId: string, reservationReference?: string | null): Promise<Conversation> {
    return this.request('POST', '/api/conversations', { clientRequestId, reservationReference: reservationReference || null });
  }

  claim(id: number): Promise<Conversation> {
    return this.request('POST', `/api/conversations/${id}/claim`);
  }

  close(id: number): Promise<Conversation> {
    return this.request('POST', `/api/conversations/${id}/close`);
  }

  private async request<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
    const token = await this.tokens.getToken();
    const res = await this.fetchFn(this.baseUrl + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.ok) return (await res.json()) as T;
    const err = await readError(res);
    if (res.status === 401 && err.code === TOKEN_EXPIRED && !retried) {
      await this.tokens.renew();
      return this.request(method, path, body, true);
    }
    throw new ApiError(res.status, err.code, err.reason);
  }
}

async function readError(res: Response): Promise<ApiErrorBody> {
  try {
    const b = (await res.json()) as Partial<ApiErrorBody>;
    return { code: typeof b.code === 'string' ? b.code : `HTTP_${res.status}`, reason: b.reason };
  } catch {
    return { code: `HTTP_${res.status}` };
  }
}

export type TokenRole = 'customer' | 'guest' | 'agent';

export interface DevTokenRequest {
  role: TokenRole;
  subject?: string;
  name?: string;
  email?: string;
  reservationReference?: string;
  ttlSeconds?: number;
}

interface StoredToken {
  token: string;
  subject: string;
  role: TokenRole;
  expiresAt: string;
}

/**
 * Dev token issuer client (auth-stub POST /dev/tokens, A5). The token and its subject are kept in
 * storage so a reload keeps the same identity; renew() asks for a new token for the same subject.
 */
export class DevTokenProvider implements TokenProvider {
  private current: StoredToken | null = null;
  private inflight: Promise<string> | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly request: DevTokenRequest,
    private readonly storage: KeyValueStorage | null = null,
    private readonly storageKey = `ycyw.chat.token.${request.role}.v1`,
    private readonly fetchFn: FetchFn = (i, init) => fetch(i, init),
  ) {
    try {
      const raw = storage?.getItem(storageKey);
      if (raw) this.current = JSON.parse(raw) as StoredToken;
    } catch {
      this.current = null;
    }
  }

  get subject(): string | null {
    return this.current?.subject ?? this.request.subject ?? null;
  }

  getToken(): Promise<string> {
    if (this.current) return Promise.resolve(this.current.token);
    return this.renew();
  }

  renew(): Promise<string> {
    // Concurrent callers (REST 401 + STOMP TOKEN_EXPIRED) share one issuance.
    this.inflight ??= this.issue().finally(() => (this.inflight = null));
    return this.inflight;
  }

  private async issue(): Promise<string> {
    const body: DevTokenRequest = { ...this.request, subject: this.subject ?? this.request.subject };
    if (!body.subject) delete body.subject;
    const res = await this.fetchFn(`${this.baseUrl}/dev/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await readError(res);
      throw new ApiError(res.status, err.code, err.reason);
    }
    const t = (await res.json()) as StoredToken;
    this.current = { token: t.token, subject: t.subject, role: t.role, expiresAt: t.expiresAt };
    try {
      this.storage?.setItem(this.storageKey, JSON.stringify(this.current));
    } catch {
      // storage unavailable: the identity lasts for this page only
    }
    return t.token;
  }
}

export { newUuid };
