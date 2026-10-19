package com.ycyw.chat.fanout;

import com.ycyw.chat.events.ChatEvents;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.sql.Statement;
import java.time.Duration;
import java.util.Properties;
import org.postgresql.PGConnection;
import org.postgresql.PGNotification;
import org.postgresql.PGProperty;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.jdbc.autoconfigure.JdbcConnectionDetails;
import org.springframework.context.SmartLifecycle;
import org.springframework.stereotype.Component;

/**
 * Cross-instance fan-out: one dedicated, non-pooled connection per instance doing
 * {@code LISTEN chat_events}, republishing each notification on the local simple broker.
 *
 * <pre>
 *  writer tx (any instance): INSERT … ; pg_notify('chat_events', {t,c,s}) ; COMMIT
 *                                              │ delivered at commit, in commit order
 *                                              ▼
 *  ┌──────────────── listener thread (this class, one per instance) ────────────────────┐
 *  │ connect(chat.listener.jdbc-url, autocommit, socketTimeout=10s, tcpKeepAlive)       │
 *  │ LISTEN chat_events ──▶ readiness UP (/ws accepts handshakes)                       │
 *  │ loop: getNotifications(1 s) ──▶ FanoutPublisher: load (c,s) ──▶ /topic/…           │
 *  │       every 5 s: SELECT 1   (A3: detects a half-open connection within ~15 s)      │
 *  └───────┬─────────────────────────────────────────────────────────────────────────────┘
 *          │ any failure: connection lost, liveness timeout, load/publish error (O1)
 *          ▼
 *  readiness DOWN (/ws → 503) ─▶ close ALL WebSocket sessions (1012) ─▶ backoff ─▶ reconnect
 *          clients reconnect elsewhere, re-subscribe with receipt, backfill afterSeq=lastSeq
 * </pre>
 *
 * Notifications sent while this instance was not listening are lost for it; that is safe only
 * because no session survives the gap (every client re-subscribes and backfills from the DB).
 * Autocommit stays on: pgjdbc's getNotifications returns early while a transaction is open.
 */
@Component
public class NotifyListener implements SmartLifecycle {

    private static final Logger log = LoggerFactory.getLogger(NotifyListener.class);

    private final ListenerProperties properties;
    private final JdbcConnectionDetails pool;
    private final FanoutPublisher publisher;
    private final ListenerReadiness readiness;
    private final WebSocketSessionRegistry sessions;
    private final String instanceId;

    private volatile boolean running;
    private volatile Thread thread;
    private volatile Connection connection;

    public NotifyListener(ListenerProperties properties, JdbcConnectionDetails pool, FanoutPublisher publisher,
            ListenerReadiness readiness, WebSocketSessionRegistry sessions,
            @Value("${chat.instance-id}") String instanceId) {
        this.properties = properties;
        this.pool = pool;
        this.publisher = publisher;
        this.readiness = readiness;
        this.sessions = sessions;
        this.instanceId = instanceId;
    }

    @Override
    public void start() {
        running = true;
        thread = Thread.ofPlatform().name("chat-listener").daemon().start(this::run);
    }

    @Override
    public void stop() {
        running = false;
        readiness.markDown("stopping");
        closeQuietly(connection);
        Thread t = thread;
        if (t != null) {
            t.interrupt();
            try {
                t.join(Duration.ofSeconds(5));
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
    }

    @Override
    public boolean isRunning() {
        return running;
    }

    /** Start after the web server and broker are up, stop before them. */
    @Override
    public int getPhase() {
        return Integer.MAX_VALUE - 1000;
    }

    private void run() {
        Duration backoff = properties.backoffMin();
        while (running) {
            try (Connection c = connect()) {
                connection = c;
                listen(c);
                backoff = properties.backoffMin();
                readiness.markUp();
                log.info("LISTEN {} active, instance ready", ChatEvents.CHANNEL);
                pump(c);
            } catch (Exception e) {
                if (!running) {
                    break;
                }
                fail(e);
            } finally {
                connection = null;
            }
            if (running) {
                sleep(backoff);
                backoff = backoff.multipliedBy(2).compareTo(properties.backoffMax()) > 0
                        ? properties.backoffMax() : backoff.multipliedBy(2);
            }
        }
    }

    private void pump(Connection c) throws SQLException {
        PGConnection pg = c.unwrap(PGConnection.class);
        int pollMillis = (int) properties.pollTimeout().toMillis();
        long livenessNanos = properties.livenessInterval().toNanos();
        long lastLiveness = System.nanoTime();
        while (running) {
            PGNotification[] notifications = pg.getNotifications(pollMillis);
            if (notifications != null) {
                for (PGNotification n : notifications) {
                    publisher.publish(n.getParameter());
                }
            }
            if (System.nanoTime() - lastLiveness >= livenessNanos) {
                try (Statement s = c.createStatement()) {
                    s.execute("SELECT 1");
                }
                lastLiveness = System.nanoTime();
            }
        }
    }

    private void fail(Exception e) {
        readiness.markDown(e.toString());
        log.error("Listener failed, instance NOT READY, closing all sessions: {}", e.toString());
        sessions.closeAll();
    }

    private Connection connect() throws SQLException {
        String url = properties.jdbcUrl() == null || properties.jdbcUrl().isBlank()
                ? pool.getJdbcUrl() : properties.jdbcUrl();
        Properties info = new Properties();
        if (pool.getUsername() != null) {
            info.setProperty(PGProperty.USER.getName(), pool.getUsername());
        }
        if (pool.getPassword() != null) {
            info.setProperty(PGProperty.PASSWORD.getName(), pool.getPassword());
        }
        // Defaults; parameters present in the URL win.
        info.setProperty(PGProperty.SOCKET_TIMEOUT.getName(), Long.toString(properties.socketTimeout().toSeconds()));
        info.setProperty(PGProperty.TCP_KEEP_ALIVE.getName(), "true");
        info.setProperty(PGProperty.CONNECT_TIMEOUT.getName(), "5");
        info.setProperty(PGProperty.APPLICATION_NAME.getName(), "chat-listener-" + instanceId);
        Connection c = DriverManager.getConnection(url, info);
        c.setAutoCommit(true);
        return c;
    }

    private static void listen(Connection c) throws SQLException {
        try (Statement s = c.createStatement()) {
            s.execute("LISTEN " + ChatEvents.CHANNEL);
        }
    }

    private static void sleep(Duration d) {
        try {
            Thread.sleep(d);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    private static void closeQuietly(Connection c) {
        if (c != null) {
            try {
                c.close();
            } catch (SQLException ignored) {
                // closing a broken connection
            }
        }
    }
}
