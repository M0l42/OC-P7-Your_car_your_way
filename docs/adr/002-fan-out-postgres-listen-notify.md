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
  throughput measurement; the mechanism is the instance-wide NOTIFY commit lock, see below);
- a need for presence or typing state;
- a need for regional fan-out that does not depend on the EU primary.

## Consequences and limits

- **Zero new infrastructure.** The guarantee comes from the database, which is already required (ADR-001).
- **No regional failover for the chat.** NOTIFY exists only on the primary; read replicas do not
  receive notifications. The North American chat instances therefore LISTEN on the EU primary, over
  a cross-region connection that must bypass RDS Proxy, because LISTEN pins a session. If the EU
  primary is down, the chat stops in both regions. This is accepted and documented, not hidden.
- **Measured cross-region latency** (O10): the chaos variant `make chaos-region` adds 80 ms through
  Toxiproxy (downstream direction) on chat-2's pool and listener connections; chat-1 talks to
  Postgres directly. Five customers on chat-1 send to an agent on chat-2 every 100 ms for 60 s, no
  kills; latency = agent receive − customer send on one `performance.now()` clock.

  | Run (local compose, 2026-10-19) | Samples | p50 | p95 | max |
  |---|---|---|---|---|
  | Simulated NA instance (`make chaos-region`) | 597 | 173.2 ms | **202.9 ms** | 240.5 ms |
  | Reference, no added latency (`make chaos` steady phase) | 597 | 13.5 ms | 19.2 ms | 31.4 ms |

  - The simulated NA instance adds about 160–185 ms, consistent with two 80 ms crossings: the NOTIFY
    delivery to chat-2's listener and the load query through its pool.
  - Both runs: 0 lost, 0 duplicated, 0 out of order, every message acked, database rows match.
  - Reported, not gated (O5). Measured on develop 791133d with the chaos client of `feat/chaos-client`
    (4c7d48e).
  - Caveat: Toxiproxy adds a fixed delay to one direction of a local TCP link. It is not a real
    transatlantic network: no packet loss, no jitter, no bandwidth limit.
- **What the PostgreSQL documentation guarantees** ([NOTIFY, PostgreSQL 17][notify-docs]):
  - Notifications are delivered only if the transaction commits, and only between transactions.
    This is what makes "a notification always refers to a committed row" true.
  - The payload must be shorter than 8,000 bytes in the default configuration. For larger data the
    documentation recommends storing it in a table and sending its key, which is this design (`{t,c,s}`,
    < 100 bytes; the listener reloads the row).
  - All notifications go through one queue, 8 GB in a standard installation. If the queue is full,
    a transaction that issued NOTIFY fails at commit.
  - A listening session that stays inside a long transaction blocks the queue cleanup (a warning is
    logged once the queue is half full). Our listener runs in autocommit and never opens a
    transaction, so it cannot cause this. `pg_notification_queue_usage()` reports the queue usage and
    is the metric to watch.
- **Scaling limit (F4): notifying commits are serialised.**
  - The documentation page does not describe this. At commit, a transaction that issued NOTIFY
    takes a global lock (on "database 0", that is the whole instance) so that queue entries appear in
    commit order. This serialises every notifying commit of the instance, whatever the database or
    channel. Tom Lane describes this lock as serialising the commits that write the NOTIFY queue
    ([pgsql-general][tom-lane]).
  - Field reports describe the symptom: notifying commits that queue up behind each other under
    load, with no visible CPU or I/O saturation ([Recall.ai][recall], [DBOS][dbos]).
  - This bottleneck may be lifted in recent PostgreSQL versions. That is unverified: Recall.ai's post
    was updated to mention a later core commit, but the release was not confirmed. Check the release
    notes before relying on it.
  - Why it is acceptable here: support chat is a low write rate per region, and each chat write is one
    short transaction holding the lock only for its commit. The re-open trigger for Redis (~100 msg/s
    per region, an assumption to validate with the chaos client's throughput) now has a stated
    mechanism: the instance-wide commit lock, observable as commit latency growing with write
    concurrency while CPU and I/O stay low.
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
- Test 4e `ReceiptOrderingIT`: subscribe, then receipt, then an immediate commit on the other
  instance; every item must be delivered live. It runs 100 iterations in every `./mvnw verify`; a
  1,000-iteration run (`-Dreceipt.iterations=1000`) was green on 2026-10-19.
- Chaos run (`make chaos`): see the `chaos.yml` job summary.

## Sources

- **notify-docs**: PostgreSQL 17 documentation, NOTIFY, <https://www.postgresql.org/docs/17/sql-notify.html>
- **tom-lane**: Tom Lane, pgsql-general, on the lock that serialises commits writing the NOTIFY queue
  (its exclusivity matters, not its mode), <https://postgresql.org/message-id/3598.1363354686%40sss.pgh.pa.us>
- **recall**: Recall.ai engineering blog (field report), <https://recall.ai/blog/postgres-listen-notify-does-not-scale>
- **dbos**: DBOS blog (field report), <https://dbos.dev/blog/postgres-listen-notify-scalability>

[notify-docs]: https://www.postgresql.org/docs/17/sql-notify.html
[tom-lane]: https://postgresql.org/message-id/3598.1363354686%40sss.pgh.pa.us
[recall]: https://recall.ai/blog/postgres-listen-notify-does-not-scale
[dbos]: https://dbos.dev/blog/postgres-listen-notify-scalability

These sources were checked on 2026-10-19 by web search (search results only); the version that may
lift the commit lock is still to confirm in the PostgreSQL release notes.
