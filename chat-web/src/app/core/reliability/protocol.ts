// Wire contract shared with chat-service (docs/protocol.md). Framework-free: no Angular imports,
// reused as-is by the Node chaos client (D21/O2). Keep every payload shape in this one file.

export type ConversationStatus = 'en_attente' | 'en_cours' | 'cloturee';
export type MessageType = 'texte' | 'prise_en_charge' | 'cloture';
export type SenderRole = 'client' | 'agent' | 'systeme';

/** One sequenced item of a conversation stream (topic push or REST backfill). */
export interface StreamItem {
  conversationId: number;
  seq: number;
  clientMessageId: string;
  type: MessageType;
  senderRole: SenderRole;
  senderRef: string;
  content: string | null;
  createdAt: string;
}

export interface Conversation {
  id: number;
  status: ConversationStatus;
  customerRef: string;
  customerKind?: 'compte' | 'invite';
  reservationReference: string | null;
  agentRef: string | null;
  lastSeq: number;
  createdAt: string;
  claimedAt?: string | null;
  closedAt?: string | null;
}

/** GET /api/conversations/{id}/messages?afterSeq=N — at most 200 items, ascending seq (P1). */
export interface MessagePage {
  items: StreamItem[];
  hasMore: boolean;
}

/** GET /api/conversations?status=en_attente — oldest 50 + total (P1). */
export interface QueuePage {
  items: Conversation[];
  total: number;
}

/** SEND /app/conversations/{id}/messages */
export interface SendPayload {
  clientMessageId: string;
  content: string;
}

/** /user/queue/acks */
export interface Ack {
  conversationId?: number;
  clientMessageId: string;
  seq: number;
}

export type SendErrorCode = 'CONVERSATION_CLOSED' | 'FORBIDDEN' | 'INVALID_CONTENT' | (string & {});

/** /user/queue/errors */
export interface SendError {
  conversationId?: number;
  clientMessageId?: string;
  code: SendErrorCode;
  reason?: string;
}

/** /topic/queue — unsequenced, only used as a refetch trigger. */
export interface QueueEvent {
  t: 'opened' | 'claimed' | 'closed';
  conversationId: number;
  conversation?: Conversation;
}

/** REST error body. */
export interface ApiErrorBody {
  code: string;
  reason?: string;
}

/** STOMP ERROR / REST 401 code when the token is expired (A5). */
export const TOKEN_EXPIRED = 'TOKEN_EXPIRED';
/** STOMP ERROR / REST 401 code for a missing or invalid token. */
export const UNAUTHORIZED = 'UNAUTHORIZED';
/** STOMP ERROR code when a SUBSCRIBE is refused by the access policy (carries receipt-id). */
export const NOT_FOUND = 'NOT_FOUND';

export const MAX_CONTENT_LENGTH = 2000;

export const destinations = {
  conversationTopic: (id: number) => `/topic/conversations/${id}`,
  queueTopic: '/topic/queue',
  acks: '/user/queue/acks',
  errors: '/user/queue/errors',
  send: (id: number) => `/app/conversations/${id}/messages`,
} as const;

/** Unicode code points, like PostgreSQL char_length (an emoji counts 1, not 2 UTF-16 units). */
export function codePointLength(s: string): number {
  return [...s].length;
}

/** Client-side content rule mirroring the DB CHECK (1..2000 code points). Returns the text to send. */
export function validateContent(raw: string): { ok: true; content: string } | { ok: false; code: 'EMPTY' | 'TOO_LONG' } {
  const content = raw.trim();
  if (content.length === 0) return { ok: false, code: 'EMPTY' };
  if (codePointLength(content) > MAX_CONTENT_LENGTH) return { ok: false, code: 'TOO_LONG' };
  return { ok: true, content };
}

/** Status derived from the sequenced stream: claim/close are events on it. */
export function deriveStatus(initial: ConversationStatus, items: readonly StreamItem[]): ConversationStatus {
  let status = initial;
  for (const item of items) {
    if (item.type === 'cloture') status = 'cloturee';
    else if (item.type === 'prise_en_charge' && status !== 'cloturee') status = 'en_cours';
  }
  return status;
}
