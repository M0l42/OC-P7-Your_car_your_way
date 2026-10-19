package com.ycyw.chat;

import static org.assertj.core.api.Assertions.assertThat;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.postgresql.PostgreSQLContainer;

/**
 * Test 1 — why the stream is ordered by a per-conversation seq and not by a global BIGSERIAL
 * (premise 4, ADR-003).
 *
 * <p>A reader that backfills "everything after the highest id I have seen" relies on ids becoming
 * visible in id order. A sequence value is taken at INSERT time but becomes visible at COMMIT time,
 * so a transaction that took id 1 and commits after the one that took id 2 is skipped forever.
 * With {@code conversation.last_seq} incremented under the conversation row lock, the second writer
 * cannot even take its seq before the first one commits: seq order == commit order.
 *
 * <p>Plain JDBC on purpose: the transcript is the evidence quoted in ADR-003.
 */
@Testcontainers
class ConcurrentCommitIT {

    @Container
    static final PostgreSQLContainer POSTGRES = new PostgreSQLContainer("postgres:17-alpine");

    @BeforeAll
    static void migrate() {
        Flyway.configure()
                .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration")
                .load()
                .migrate();
    }

    private static Connection open() throws SQLException {
        Connection c = DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword());
        c.setAutoCommit(false);
        return c;
    }

    // ---- Counter-example: the rejected design --------------------------------------------------

    @Test
    void globalBigserialBackfillMissesARowCommittedOutOfIdOrder() throws Exception {
        try (Connection ddl = DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()); Statement s = ddl.createStatement()) {
            s.execute("CREATE TABLE bigserial_message (id BIGSERIAL PRIMARY KEY, content TEXT NOT NULL)");
        }
        try (Connection slow = open(); Connection fast = open(); Connection reader = open()) {
            long slowId = insertBigserial(slow, "slow");   // takes id 1, does not commit yet
            long fastId = insertBigserial(fast, "fast");   // takes id 2
            fast.commit();
            assertThat(slowId).isLessThan(fastId);

            // Reader backfills and remembers the highest id it saw.
            List<Long> firstRead = readBigserialAfter(reader, 0);
            assertThat(firstRead).containsExactly(fastId);
            long highWater = firstRead.getLast();

            slow.commit();                                 // id 1 becomes visible only now

            // "Everything after the highest id I have seen" never returns id 1.
            assertThat(readBigserialAfter(reader, highWater)).isEmpty();
            assertThat(readBigserialAfter(reader, 0)).containsExactly(slowId, fastId);
        }
    }

    // ---- The chosen design: per-conversation seq under a row lock ------------------------------

    @Test
    void perConversationSeqNeverBecomesVisibleOutOfOrder() throws Exception {
        long conversationId = createConversation();
        try (Connection first = open(); Connection second = open(); Connection reader = open()) {
            long firstSeq = appendWithSeq(first, conversationId, "first"); // holds the row lock

            // The second writer blocks on SELECT … FOR UPDATE until the first commits.
            CompletableFuture<Long> secondSeq = CompletableFuture.supplyAsync(() -> {
                try {
                    long seq = appendWithSeq(second, conversationId, "second");
                    second.commit();
                    return seq;
                } catch (SQLException e) {
                    throw new IllegalStateException(e);
                }
            });
            Thread.sleep(500);
            assertThat(secondSeq).as("second writer must wait for the row lock").isNotDone();

            List<Integer> firstRead = readSeqAfter(reader, conversationId, 0);
            assertThat(firstRead).isEmpty();               // nothing committed yet → nothing skipped

            first.commit();
            assertThat(secondSeq.get(10, TimeUnit.SECONDS)).isEqualTo(firstSeq + 1);

            // Backfill after the high-water mark (0) returns both, contiguous, in commit order.
            assertThat(readSeqAfter(reader, conversationId, 0)).containsExactly(1, 2);
        }
    }

    @Test
    void readerPollingAfterItsHighWaterMarkSeesEverySeqUnderConcurrentWriters() throws Exception {
        long conversationId = createConversation();
        int writers = 8;
        int perWriter = 50;
        List<CompletableFuture<Void>> futures = new ArrayList<>();
        for (int w = 0; w < writers; w++) {
            futures.add(CompletableFuture.runAsync(() -> {
                try (Connection c = open()) {
                    for (int i = 0; i < perWriter; i++) {
                        appendWithSeq(c, conversationId, "m");
                        c.commit();
                    }
                } catch (SQLException e) {
                    throw new IllegalStateException(e);
                }
            }));
        }
        List<Integer> seen = new ArrayList<>();
        try (Connection reader = open()) {
            int highWater = 0;
            while (highWater < writers * perWriter) {
                for (int seq : readSeqAfter(reader, conversationId, highWater)) {
                    seen.add(seq);
                    highWater = seq;
                }
            }
        }
        CompletableFuture.allOf(futures.toArray(CompletableFuture[]::new)).get(60, TimeUnit.SECONDS);
        assertThat(seen).hasSize(writers * perWriter);
        for (int i = 0; i < seen.size(); i++) {
            assertThat(seen.get(i)).isEqualTo(i + 1);
        }
    }

    // ---- helpers ---------------------------------------------------------------------------------

    private static long insertBigserial(Connection c, String content) throws SQLException {
        try (PreparedStatement ps = c.prepareStatement(
                "INSERT INTO bigserial_message (content) VALUES (?) RETURNING id")) {
            ps.setString(1, content);
            try (ResultSet rs = ps.executeQuery()) {
                rs.next();
                return rs.getLong(1);
            }
        }
    }

    private static List<Long> readBigserialAfter(Connection c, long afterId) throws SQLException {
        List<Long> ids = new ArrayList<>();
        try (PreparedStatement ps = c.prepareStatement(
                "SELECT id FROM bigserial_message WHERE id > ? ORDER BY id")) {
            ps.setLong(1, afterId);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    ids.add(rs.getLong(1));
                }
            }
        }
        c.commit(); // each read is its own snapshot, like one REST backfill call
        return ids;
    }

    private static long createConversation() throws SQLException {
        try (Connection c = open(); PreparedStatement ps = c.prepareStatement("""
                INSERT INTO conversation (customer_ref, customer_kind, client_request_id)
                VALUES ('customer-1', 'compte', ?) RETURNING id""")) {
            ps.setObject(1, UUID.randomUUID());
            try (ResultSet rs = ps.executeQuery()) {
                rs.next();
                long id = rs.getLong(1);
                c.commit();
                return id;
            }
        }
    }

    /** Same statements as the production write path: lock → last_seq + 1 → insert. */
    private static long appendWithSeq(Connection c, long conversationId, String content) throws SQLException {
        try (PreparedStatement lock = c.prepareStatement("SELECT id FROM conversation WHERE id = ? FOR UPDATE")) {
            lock.setLong(1, conversationId);
            lock.executeQuery().close();
        }
        int seq;
        try (PreparedStatement next = c.prepareStatement(
                "UPDATE conversation SET last_seq = last_seq + 1 WHERE id = ? RETURNING last_seq")) {
            next.setLong(1, conversationId);
            try (ResultSet rs = next.executeQuery()) {
                rs.next();
                seq = rs.getInt(1);
            }
        }
        try (PreparedStatement insert = c.prepareStatement("""
                INSERT INTO message (conversation_id, seq, client_message_id, type, sender_role, sender_ref, content)
                VALUES (?, ?, ?, 'texte', 'client', 'customer-1', ?)""")) {
            insert.setLong(1, conversationId);
            insert.setInt(2, seq);
            insert.setObject(3, UUID.randomUUID());
            insert.setString(4, content);
            insert.executeUpdate();
        }
        return seq;
    }

    private static List<Integer> readSeqAfter(Connection c, long conversationId, int afterSeq) throws SQLException {
        List<Integer> seqs = new ArrayList<>();
        try (PreparedStatement ps = c.prepareStatement(
                "SELECT seq FROM message WHERE conversation_id = ? AND seq > ? ORDER BY seq")) {
            ps.setLong(1, conversationId);
            ps.setInt(2, afterSeq);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    seqs.add(rs.getInt(1));
                }
            }
        }
        c.commit();
        return seqs;
    }
}
