package com.ycyw.chat.events;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

/**
 * Emits {@code pg_notify} on the {@code chat_events} channel from inside the caller's transaction.
 * PostgreSQL delivers a notification only when that transaction commits (never on rollback), so a
 * notification always refers to a committed row.
 *
 * <p>Payloads are tiny on purpose (the listener reloads the row): {@code {"t":"msg","c":42,"s":7}}
 * for a sequenced item, {@code {"t":"queue","c":42,"e":"opened"}} for a queue event.
 */
@Component
public class ChatEvents {

    public static final String CHANNEL = "chat_events";

    private final JdbcClient jdbc;

    public ChatEvents(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    public void item(long conversationId, int seq) {
        notify("{\"t\":\"msg\",\"c\":" + conversationId + ",\"s\":" + seq + "}");
    }

    public void queue(long conversationId, QueueEventType event) {
        notify("{\"t\":\"queue\",\"c\":" + conversationId + ",\"e\":\"" + event.wire() + "\"}");
    }

    private void notify(String payload) {
        jdbc.sql("SELECT 1 FROM pg_notify('" + CHANNEL + "', ?)").param(payload).query(Integer.class).single();
    }
}
