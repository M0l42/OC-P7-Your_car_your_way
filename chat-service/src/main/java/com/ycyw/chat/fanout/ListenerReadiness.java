package com.ycyw.chat.fanout;

import java.util.concurrent.atomic.AtomicLong;
import org.springframework.boot.health.contributor.Health;
import org.springframework.boot.health.contributor.HealthIndicator;
import org.springframework.stereotype.Component;

/**
 * Readiness of this instance = "LISTEN chat_events is active". Gates {@code /ws} handshakes (503 while
 * down) and is part of the {@code readiness} health group (health indicator {@code listener}).
 *
 * <p>Every transition to UP starts a new generation. A WebSocket session is only valid for the
 * generation it was accepted in: a session accepted before a listener loss may have missed
 * notifications, so it is closed even if it finishes its handshake after the listener came back.
 */
@Component("listener")
public class ListenerReadiness implements HealthIndicator {

    private final AtomicLong generation = new AtomicLong();
    private volatile boolean ready;
    private volatile String lastFailure = "starting";

    void markUp() {
        generation.incrementAndGet();
        ready = true;
    }

    void markDown(String reason) {
        ready = false;
        generation.incrementAndGet();
        lastFailure = reason;
    }

    public boolean isReady() {
        return ready;
    }

    public long generation() {
        return generation.get();
    }

    /** True if a session accepted in {@code acceptedGeneration} may still be served. */
    public boolean isCurrent(long acceptedGeneration) {
        return ready && generation.get() == acceptedGeneration;
    }

    @Override
    public Health health() {
        return ready ? Health.up().build() : Health.outOfService().withDetail("reason", lastFailure).build();
    }
}
