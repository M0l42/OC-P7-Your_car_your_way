# ADR-003 — Order and gap detection by a per-conversation sequence

- Status: accepted
- Date: 2026-10-19
- Decision IDs: premise 4 (revised after the second opinion), A2, test 1 (design doc and eng review)

## Context

Every client reconnects the same way: it re-subscribes, then asks for "everything after the last
item I have" and merges by position. This only works if the position is safe to resume from: a
reader that has seen position N must be able to rely on every item at position ≤ N being already
visible to it.

The first draft used a global `BIGSERIAL` id as that position. That is not safe. A sequence value is
taken at INSERT time but becomes visible at COMMIT time, and transactions do not commit in the order
they took their ids. A reader can see id 2 before id 1 is committed, then resume "after 2" and never
see id 1. This is a silent loss of exactly the kind the PoC exists to rule out.

## Decision

Each conversation carries its own gap-free counter `conversation.last_seq`. Every item (`texte`, and
the system events `prise_en_charge` and `cloture`) is written in one transaction:

1. `SELECT … FROM conversation WHERE id = ? FOR UPDATE`: the row lock serialises every writer of this
   conversation until commit.
2. Idempotency lookup on `(conversation_id, client_message_id)`. If the item is found and the sender
   matches, the existing seq is acked (A2). This happens *before* the closed and participant checks,
   so a retry of a message stored just before a close is acked, never reported as failed.
3. Access, closed and content checks. A rejection writes nothing.
4. `UPDATE conversation SET last_seq = last_seq + 1 … RETURNING last_seq`.
5. `INSERT INTO message (conversation_id, seq, …)`, with primary key `(conversation_id, seq)`.
6. `pg_notify(…)`, then `COMMIT`.

The second writer cannot even take its seq before the first commits, so **seq order is commit
order**. A reader resuming "after seq N" can never skip a row. The client detects holes
(`seq > lastSeq + 1`) and re-fetches them. The `message` primary key serves the backfill query
`WHERE conversation_id = ? AND seq > ? ORDER BY seq` (pages of 200, P1).

## Alternatives considered

| Option | Why not |
|---|---|
| Global `BIGSERIAL` / identity as position | Visible out of commit order: proven to lose rows (evidence below). |
| `created_at` timestamp | Same commit-order problem, plus ties and clock issues. |
| Global sequence + "safe horizon" (only read ids older than the oldest open transaction) | Needs `txid_snapshot` / `pg_snapshot_xmin` bookkeeping on every read; complex to explain and to test. |
| Serializable isolation for writers | Retries on conflict for every write. The row lock gives the same ordering for the one conversation involved, without aborts. |

## Consequences

- **Writers of one conversation are serialised.** With two participants per conversation this is not
  a contention point. A very chatty conversation would hold its row lock for the length of one
  insert-and-commit.
- **Positions are per conversation.** Clients track `lastSeq` per conversation, and there is no global
  order across conversations. None is needed: the agent queue is unsequenced and is recovered by a
  refetch.
- **Status changes are items on the same stream**, so a customer learns of claim and close exactly
  like a message: live, or by backfill.
- **Idempotent retries consume no seq** and emit no NOTIFY. This is asserted by `WritePathIT` with a
  LISTEN recorder.

## Evidence

### Test 1 — `ConcurrentCommitIT` (written first: red, then green)

- It was committed before the schema existed. It failed with `relation "conversation" does not
  exist`, then went green with `V1__chat.sql`.
- `globalBigserialBackfillMissesARowCommittedOutOfIdOrder`: session 1 takes id 1 and does not commit;
  session 2 takes id 2 and commits. A reader backfills and sees `[2]`. Session 1 then commits. A
  reader resuming "after 2" gets `[]`, so id 1 is never seen.
- `perConversationSeqNeverBecomesVisibleOutOfOrder`: the second writer is still blocked after 500 ms.
  The reader sees `[]` while the first writer holds the lock, then `[1, 2]`.
- `readerPollingAfterItsHighWaterMarkSeesEverySeqUnderConcurrentWriters`: 8 writers × 50 messages, and a
  reader resuming after its high-water mark sees exactly 1..400 in order.

### psql transcript (PostgreSQL 17.11, two writer sessions plus a reader, 2026-10-19)

Global BIGSERIAL: id 1 is committed after id 2 and is skipped by a resuming reader.

```
-- session 1 starts 10:15:48.237
BEGIN;
INSERT INTO bigserial_message (content) VALUES ('session 1') RETURNING id;   -- id = 1
SELECT pg_sleep(3);
-- session 2 10:15:49.238
BEGIN;
INSERT INTO bigserial_message (content) VALUES ('session 2') RETURNING id;   -- id = 2
COMMIT;
-- reader 10:15:49.300: backfill 'after the highest id I have seen' (0)
SELECT id, content FROM bigserial_message WHERE id > 0 ORDER BY id;
 id |  content
----+-----------
  2 | session 2
(1 row)
-- session 1: COMMIT;  committed 10:15:51.297
-- reader 10:15:51.300: next backfill 'after id 2'
SELECT id, content FROM bigserial_message WHERE id > 2 ORDER BY id;
(0 rows)                                      <-- id 1 is never delivered
SELECT id, content FROM bigserial_message ORDER BY id;
  1 | session 1
  2 | session 2
```

Per-conversation seq: the second writer waits for the first. The reader never sees a later seq
before an earlier one.

```
-- session 1 starts 10:15:51.392
BEGIN;
SELECT id FROM conversation WHERE id = 1 FOR UPDATE;
UPDATE conversation SET last_seq = last_seq + 1 WHERE id = 1 RETURNING last_seq;   -- 1
INSERT INTO message VALUES (1, 1, 'session 1');
SELECT pg_sleep(3);
-- session 2 starts 10:15:52.394 (blocks on FOR UPDATE)
BEGIN;
SELECT id FROM conversation WHERE id = 1 FOR UPDATE;          -- waits…
-- reader 10:15:52.896: backfill afterSeq=0 while session 1 holds the lock
SELECT seq, content FROM message WHERE conversation_id = 1 AND seq > 0 ORDER BY seq;
(0 rows)                                      <-- nothing committed, nothing skipped
-- session 1: COMMIT;  committed 10:15:54.489
-- session 2 resumes: last_seq = 2, INSERT (1, 2), COMMIT;  committed 10:15:54.494
-- reader 10:15:54.496: backfill afterSeq=0
 seq |  content
-----+-----------
   1 | session 1
   2 | session 2
```

Session 2 was blocked from 10:15:52.394 to 10:15:54.489 (about 2.1 s, until session 1 committed) and
only then took `last_seq = 2`. The transcript was produced by a scripted two-session run in a
throwaway `postgres:17-alpine` container (`docker exec … psql`, no local psql). The Lead Dev reproduced
the same blocking by hand during review (the second writer waited 4.04 s, then got `last_seq = 2`).
