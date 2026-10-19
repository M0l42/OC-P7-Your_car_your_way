package com.ycyw.chat.message;

import com.ycyw.chat.conversation.ConversationRepository;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

/** JDBC access to {@code message}. Callers own the transaction. */
@Repository
public class MessageRepository {

    private static final String COLUMNS =
            "conversation_id, seq, client_message_id, type, sender_role, sender_ref, content, created_at";

    private static final RowMapper<Item> MAPPER = MessageRepository::map;

    private final JdbcClient jdbc;

    public MessageRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    public Optional<Item> findByClientMessageId(long conversationId, UUID clientMessageId) {
        return jdbc.sql("SELECT " + COLUMNS + " FROM message WHERE conversation_id = ? AND client_message_id = ?")
                .params(conversationId, clientMessageId).query(MAPPER).optional();
    }

    public Optional<Item> findBySeq(long conversationId, int seq) {
        return jdbc.sql("SELECT " + COLUMNS + " FROM message WHERE conversation_id = ? AND seq = ?")
                .params(conversationId, seq).query(MAPPER).optional();
    }

    /** Items with seq &gt; afterSeq in ascending order, at most {@code limit} (backfill page, P1). */
    public List<Item> findAfter(long conversationId, int afterSeq, int limit) {
        return jdbc.sql("SELECT " + COLUMNS + " FROM message WHERE conversation_id = ? AND seq > ? "
                        + "ORDER BY seq LIMIT ?")
                .params(conversationId, afterSeq, limit).query(MAPPER).list();
    }

    public Item insert(long conversationId, int seq, UUID clientMessageId, ItemType type, SenderRole senderRole,
            String senderRef, String content) {
        return jdbc.sql("""
                INSERT INTO message (conversation_id, seq, client_message_id, type, sender_role, sender_ref, content)
                VALUES (?, ?, ?, ?::type_message, ?::role_emetteur, ?, ?)
                """ + "RETURNING " + COLUMNS)
                .params(conversationId, seq, clientMessageId, type.dbValue(), senderRole.dbValue(), senderRef, content)
                .query(MAPPER).single();
    }

    private static Item map(ResultSet rs, int row) throws SQLException {
        return new Item(
                rs.getLong("conversation_id"),
                rs.getInt("seq"),
                rs.getObject("client_message_id", UUID.class),
                ItemType.fromDb(rs.getString("type")),
                SenderRole.fromDb(rs.getString("sender_role")),
                rs.getString("sender_ref"),
                rs.getString("content"),
                ConversationRepository.instant(rs, "created_at"));
    }
}
