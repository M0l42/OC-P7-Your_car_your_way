package com.ycyw.chat.fanout;

import java.time.Duration;
import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * {@code chat.listener.*}. {@code jdbcUrl} (env {@code CHAT_LISTENER_JDBC_URL}, F9) is the dedicated
 * LISTEN connection's URL, separate from the Hikari pool so tests and the O10 variant can route only
 * the listener through Toxiproxy; blank → the pool's URL. Credentials are the pool's.
 */
@ConfigurationProperties("chat.listener")
public record ListenerProperties(
        String jdbcUrl,
        Duration pollTimeout,
        Duration livenessInterval,
        Duration socketTimeout,
        Duration backoffMin,
        Duration backoffMax) {

    public ListenerProperties {
        pollTimeout = pollTimeout == null ? Duration.ofSeconds(1) : pollTimeout;
        livenessInterval = livenessInterval == null ? Duration.ofSeconds(5) : livenessInterval;
        socketTimeout = socketTimeout == null ? Duration.ofSeconds(10) : socketTimeout;
        backoffMin = backoffMin == null ? Duration.ofMillis(200) : backoffMin;
        backoffMax = backoffMax == null ? Duration.ofSeconds(5) : backoffMax;
    }
}
