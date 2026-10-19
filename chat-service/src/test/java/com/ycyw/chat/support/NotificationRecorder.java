package com.ycyw.chat.support;

import com.ycyw.chat.events.ChatEvents;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;
import javax.sql.DataSource;
import org.postgresql.PGConnection;
import org.postgresql.PGNotification;

/** Test helper: LISTENs on chat_events and collects payloads, to assert what a transaction notified. */
public final class NotificationRecorder implements AutoCloseable {

    private final Connection connection;
    private final PGConnection pg;

    public NotificationRecorder(DataSource dataSource) throws SQLException {
        connection = dataSource.getConnection();
        connection.setAutoCommit(true);
        try (Statement s = connection.createStatement()) {
            s.execute("LISTEN " + ChatEvents.CHANNEL);
        }
        pg = connection.unwrap(PGConnection.class);
    }

    /** Payloads received so far, waiting up to {@code waitMillis} for the first batch. */
    public List<String> drain(int waitMillis) throws SQLException {
        List<String> payloads = new ArrayList<>();
        PGNotification[] batch = pg.getNotifications(waitMillis);
        while (batch != null && batch.length > 0) {
            for (PGNotification n : batch) {
                payloads.add(n.getParameter());
            }
            batch = pg.getNotifications(100);
        }
        return payloads;
    }

    @Override
    public void close() throws SQLException {
        try (Statement s = connection.createStatement()) {
            s.execute("UNLISTEN *");
        }
        connection.close();
    }
}
