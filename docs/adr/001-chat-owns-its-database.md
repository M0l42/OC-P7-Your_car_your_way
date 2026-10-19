# ADR-001 — The chat service owns its own database

- Status: accepted
- Date: 2026-10-19
- Decision IDs: premise 1, premise 3, A6, C3 (design doc and eng review)

## Context

The target architecture is a modular monolith with one extracted service: the chat. It is extracted
because it holds long-lived WebSocket connections and has a different load profile, so it runs as
several independent containers (Fargate/ECS, two regions).

The first version of the architecture document said the chat service had "no dependency on the
database". That contradicts the brief, which asks for the chat's data structure. It also contradicts
the reliability design: messages must be persisted before they are broadcast, and a client that
reconnects asks for "everything after seq N".

The chat therefore needs durable storage. The question is whether that storage is the monolith's
schema or its own.

## Decision

The chat service owns a logical database `chat` with its own credentials. In the target architecture
it lives on the same RDS PostgreSQL instance as the monolith's database, so no new infrastructure is
added. It has no dependency on the monolith's schema:

- **No foreign key to the monolith.** `conversation.customer_ref` and `agent_ref` are the JWT `sub`;
  `reservation_reference` is an identifier carried by the client or by the guest token.
- **Identity without coupling** (premise 3). The chat service verifies RS256 tokens issued by the
  monolith, using a public key read from configuration (`chat.jwt.public-key-location`). It never calls
  the monolith at runtime. In the PoC, `auth-stub` stands in for the issuer.
- **Schema owned by the service.** Flyway migrations live in `chat-service`
  (`db/migration/V1__chat.sql`), and the compose bootstrap only creates the role and the empty
  database. The schema follows AR04: snake_case, BIGSERIAL technical ids, native enums with French
  values (`statut_conversation`, `type_message`, `role_emetteur`, `type_client`).
- **Invariants live in the schema**, not only in code: `CHECK status <> 'en_cours' OR agent_ref IS NOT
  NULL` (A4); system events have `sender_role = 'systeme'` and `content IS NULL`; text content is
  1–2000 characters (C3); `UNIQUE (conversation_id, client_message_id)` makes retries idempotent;
  `UNIQUE (customer_ref, client_request_id)` makes "open a conversation" idempotent (A6).

## Alternatives considered

| Option | Why not |
|---|---|
| Tables in the monolith's schema | Couples deployments and migrations of the extracted service to the monolith, which defeats the reason for extracting it; a monolith migration could break the chat. |
| No database (broker only) | Persist-before-broadcast and the "after seq N" backfill are impossible without durable, ordered storage; contradicts the brief. |
| Separate RDS instance or another engine | One more component to run, secure and pay for, for no capability the shared instance lacks ("avoid an oversized architecture"). |

## Consequences

- The chat can be deployed, migrated and scaled independently. Its only shared resource is the RDS
  instance, so the chat's connections count against that instance's `max_connections`: one Hikari
  pool plus one LISTEN connection per chat instance.
- Cross-database joins with the monolith (for example, "the customer's reservations") are not
  possible. The chat stores references only; any enrichment is done by the client or by the
  monolith.
- GDPR retention (purge or anonymise conversations N months after closing, consistent with the
  account-deletion rule in AR01) has to be implemented in the chat service itself. It is documented,
  not implemented, in the PoC.
- PostgreSQL also carries the cross-instance fan-out (ADR-002), so the database is the single
  dependency of the chat path. A Postgres outage stops the chat; this is out of the PoC's "zero loss"
  scope.
