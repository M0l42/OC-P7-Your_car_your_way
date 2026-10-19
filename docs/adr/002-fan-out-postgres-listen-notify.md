# ADR-002 — Cross-instance fan-out with PostgreSQL LISTEN/NOTIFY

- Status: accepted
- Date: 2026-10-19
- Decision IDs: Approach B, A1, A3, O1, O3, O7, O9, O10, F4, F9 (design doc and eng review)

## Context

Several chat instances run behind a round-robin load balancer (an ALB in the target, nginx in the
PoC). Spring's STOMP simple broker is in memory: it reaches only the clients connected to the same
JVM. A customer on instance A and an agent on instance B must still see each other's messages, and
killing an instance must not lose, duplicate or reorder anything.

The reliability already lives in the data (ADR-003): every item is committed with a gap-free
per-conversation `seq` before it is broadcast, and a client that reconnects backfills "after seq N".
The fan-out layer therefore only needs to be fast and eventually aligned with the database. It does
not have to be durable.

## Decision

Use PostgreSQL `LISTEN/NOTIFY` as the bus, with no new component:

1. The write transaction (send, claim, close) ends with
   `pg_notify('chat_events', '{"t":"msg","c":<conversation>,"s":<seq>}')`, plus a `queue` event for
   agents. PostgreSQL delivers a notification only if the transaction commits, so a notification
   always refers to a committed row.
2. Each instance holds **one dedicated, non-pooled connection** doing `LISTEN chat_events`
   (`NotifyListener`; URL `chat.listener.jdbc-url`, separate from the Hikari pool, F9). It runs in
   autocommit, with `socketTimeout=10` and `tcpKeepAlive`. It loops on `getNotifications(1000)`, loads
   each notified row through the pool and publishes it to the local simple broker. A single thread
   does this; together with NOTIFY's commit order and `setPreservePublishOrder` (O9), this keeps each
   subscription in seq order.
3. **Readiness is the listener.** Readiness is UP only while `LISTEN` is active, and `/ws` handshakes
   get 503 otherwise. nginx retries a 503 handshake on the other instance (`proxy_next_upstream
   http_503`).
4. **Any listener problem is treated like losing the instance**: the connection drops, the `SELECT 1`
   liveness check (every 5 s) fails, or loading or publishing a notified row fails (A3, O1). The
   instance goes not-ready, closes all its WebSocket sessions (1012) and reconnects with backoff. The
   clients reconnect, re-subscribe with a receipt (A1, O7) and backfill from the database. No session
   ever outlives a gap in the notifications it should have received. A half-open connection is
   detected within 5 s (liveness interval) + 1 s (poll) + 10 s (socketTimeout) = 16 s.

## Alternatives considered

Scored with the same method as the other choices in the architecture document (§2.2).

| Option | New infra | Durability needed from the bus | Ops / security surface | Fit |
|---|---|---|---|---|
| Simple broker only (one instance) | none | n/a | none | Proves nothing about the multi-instance claim. Rejected. |
| STOMP broker relay to RabbitMQ | RabbitMQ cluster | yes, it becomes the delivery path | queue cluster, credentials, monitoring, second source of truth | Oversized for the PoC load. |
| Redis pub/sub | Redis (ElastiCache) | no (fire-and-forget, same reliability design) | one more managed component | **Documented alternative**, see re-open trigger. |
| **PostgreSQL LISTEN/NOTIFY** | **none** | no | one extra connection per instance | **Chosen.** |

**Re-open trigger for Redis.** Move to Redis if any of these appears:

- sustained traffic above ~100 msg/s per region (an assumption, to validate with the chaos client's
  throughput measurement);
- a need for presence or typing state;
- a need for regional fan-out that does not depend on the EU primary.

## Consequences and limits

- **Zero new infrastructure.** The guarantee comes from the database, which is already required (ADR-001).
- **No regional failover for the chat.** NOTIFY exists only on the primary; read replicas do not
  receive notifications. The North American chat instances therefore LISTEN on the EU primary, over
  a cross-region connection that must bypass RDS Proxy, because LISTEN pins a session. If the EU
  primary is down, the chat stops in both regions. This is accepted and documented, not hidden.
- **Measured cross-region latency** (O10): the chaos variant `make chaos-region` adds 80 ms through
  Toxiproxy on chat-2's pool and listener connections.
  - NA p95 cross-instance delivery: **TBD**, filled in from the chaos job summary once the
    cross-region run has been executed.
  - Reported, not gated.
- **Scaling limit (assumption, F4)**:
  - Not verified against the PostgreSQL documentation yet. The documentation check was blocked in this
    environment; see "Verification status" below.
  - What we believe: NOTIFY serialises notifying transactions at commit (one global lock while
    the notification is queued), and all notifications go through a single shared queue of bounded
    size. When that queue is full, notifying transactions fail at commit. A listener that does not
    consume notifications makes the queue grow.
  - Why it is acceptable here: the payloads are tiny (`{t,c,s}`, < 100 bytes, far below the 8,000-byte
    payload limit) and each instance's listener consumes continuously. The serialisation only bounds
    the throughput of *notifying commits*, which the ~100 msg/s re-open trigger above already treats
    as the point to revisit.
- **Every instance loads every notified row**, even without subscribers: N instances cost N
  primary-key reads per message. This is negligible at PoC scale and another input to the re-open
  trigger.
- The listener connection is outside the pool, so pool exhaustion cannot starve it. Pool exhaustion
  can still fail a load, which then takes the O1 fail-fast path.

## Evidence

- Test 2 `CrossInstanceFanoutIT`: items committed through one instance reach subscribers of the other;
  a 100-message burst arrives in seq order.
- Test 4c `ListenerFailureIT`, via Toxiproxy (F9):
  - the handshake gets 503 until LISTEN is active;
  - `pg_terminate_backend` on the listener closes the sessions, and readiness goes DOWN then UP;
  - a half-open connection (timeout toxic) is detected within 16 s.
- O1 `ListenerFailureIT.LoadFailure`: an injected load failure closes the sessions, and the client
  recovers the message by backfill.
- Test 4e `ReceiptOrderingIT`: 1,000 iterations of subscribe, then receipt, then an immediate commit
  on the other instance. Every item was delivered live.
- Chaos run (`make chaos`): see the `chaos.yml` job summary.

## Verification status

The planned check of the scaling assumption against
<https://www.postgresql.org/docs/17/sql-notify.html> (the "Notes" section: queue size, full-queue
behaviour, commit ordering) could not be run in the build environment of 2026-10-19. The headless
browser that the project uses for web access needs Node 20+, and the host had Node 18. Until someone
reads that page and quotes it here, the scaling paragraph above stays an assumption.
