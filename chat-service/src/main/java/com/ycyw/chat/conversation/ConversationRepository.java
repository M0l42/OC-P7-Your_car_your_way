package com.ycyw.chat.conversation;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

/** JDBC access to {@code conversation}. Callers own the transaction. */
@Repository
public class ConversationRepository {

    private static final String COLUMNS = """
            id, status, customer_ref, customer_kind, reservation_reference, agent_ref, last_seq,
            created_at, claimed_at, closed_at""";

    static final RowMapper<Conversation> MAPPER = ConversationRepository::map;

    private final JdbcClient jdbc;

    public ConversationRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    public Optional<Conversation> findById(long id) {
        return jdbc.sql("SELECT " + COLUMNS + " FROM conversation WHERE id = ?")
                .param(id).query(MAPPER).optional();
    }

    /** Takes the conversation row lock: serialises every writer of this conversation until commit. */
    public Optional<Conversation> lockById(long id) {
        return jdbc.sql("SELECT " + COLUMNS + " FROM conversation WHERE id = ? FOR UPDATE")
                .param(id).query(MAPPER).optional();
    }

    /** Inserts unless (customer_ref, client_request_id) exists; empty when it already existed (A6). */
    public Optional<Conversation> insertIfAbsent(String customerRef, String customerKind,
            String reservationReference, UUID clientRequestId) {
        return jdbc.sql("""
                INSERT INTO conversation (customer_ref, customer_kind, reservation_reference, client_request_id)
                VALUES (?, ?::type_client, ?, ?)
                ON CONFLICT (customer_ref, client_request_id) DO NOTHING
                """ + "RETURNING " + COLUMNS)
                .params(customerRef, customerKind, reservationReference, clientRequestId)
                .query(MAPPER).optional();
    }

    public Optional<Conversation> findByClientRequest(String customerRef, UUID clientRequestId) {
        return jdbc.sql("SELECT " + COLUMNS + " FROM conversation WHERE customer_ref = ? AND client_request_id = ?")
                .params(customerRef, clientRequestId).query(MAPPER).optional();
    }

    /** Next gap-free seq of the conversation. Must run after {@link #lockById} in the same transaction. */
    public int nextSeq(long id) {
        return jdbc.sql("UPDATE conversation SET last_seq = last_seq + 1 WHERE id = ? RETURNING last_seq")
                .param(id).query(Integer.class).single();
    }

    /** Conditional claim: only an {@code en_attente} row changes (first agent wins). */
    public Optional<Conversation> claim(long id, String agentRef) {
        return jdbc.sql("""
                UPDATE conversation SET status = 'en_cours', agent_ref = ?, claimed_at = now()
                WHERE id = ? AND status = 'en_attente'
                """ + "RETURNING " + COLUMNS)
                .params(agentRef, id).query(MAPPER).optional();
    }

    public Conversation close(long id) {
        return jdbc.sql("""
                UPDATE conversation SET status = 'cloturee', closed_at = now()
                WHERE id = ? AND status <> 'cloturee'
                """ + "RETURNING " + COLUMNS)
                .param(id).query(MAPPER).single();
    }

    /** Oldest waiting conversations first (P1). */
    public List<Conversation> findWaiting(int limit) {
        return jdbc.sql("SELECT " + COLUMNS + " FROM conversation WHERE status = 'en_attente' "
                        + "ORDER BY created_at, id LIMIT ?")
                .param(limit).query(MAPPER).list();
    }

    public long countWaiting() {
        return jdbc.sql("SELECT count(*) FROM conversation WHERE status = 'en_attente'")
                .query(Long.class).single();
    }

    public List<Conversation> findByCustomer(String customerRef, int limit) {
        return jdbc.sql("SELECT " + COLUMNS + " FROM conversation WHERE customer_ref = ? "
                        + "ORDER BY created_at DESC, id DESC LIMIT ?")
                .params(customerRef, limit).query(MAPPER).list();
    }

    public long countByCustomer(String customerRef) {
        return jdbc.sql("SELECT count(*) FROM conversation WHERE customer_ref = ?")
                .param(customerRef).query(Long.class).single();
    }

    public List<Conversation> findInProgressByAgent(String agentRef, int limit) {
        return jdbc.sql("SELECT " + COLUMNS + " FROM conversation WHERE agent_ref = ? AND status = 'en_cours' "
                        + "ORDER BY created_at DESC, id DESC LIMIT ?")
                .params(agentRef, limit).query(MAPPER).list();
    }

    public long countInProgressByAgent(String agentRef) {
        return jdbc.sql("SELECT count(*) FROM conversation WHERE agent_ref = ? AND status = 'en_cours'")
                .param(agentRef).query(Long.class).single();
    }

    private static Conversation map(ResultSet rs, int row) throws SQLException {
        return new Conversation(
                rs.getLong("id"),
                ConversationStatus.fromDb(rs.getString("status")),
                rs.getString("customer_ref"),
                rs.getString("customer_kind"),
                rs.getString("reservation_reference"),
                rs.getString("agent_ref"),
                rs.getInt("last_seq"),
                instant(rs, "created_at"),
                instant(rs, "claimed_at"),
                instant(rs, "closed_at"));
    }

    /** Wire timestamps carry milliseconds (protocol.md §1). */
    public static Instant instant(ResultSet rs, String column) throws SQLException {
        OffsetDateTime value = rs.getObject(column, OffsetDateTime.class);
        return value == null ? null : value.toInstant().truncatedTo(ChronoUnit.MILLIS);
    }
}
