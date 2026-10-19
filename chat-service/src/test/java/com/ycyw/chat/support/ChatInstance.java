package com.ycyw.chat.support;

import com.ycyw.chat.ChatServiceApplication;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.WebSocket;
import java.net.http.WebSocketHandshakeException;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletionException;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.web.server.context.WebServerApplicationContext;
import org.springframework.context.ConfigurableApplicationContext;
import org.testcontainers.postgresql.PostgreSQLContainer;

/** One chat-service instance (its own Spring context, Tomcat port and LISTEN connection) in this JVM. */
public final class ChatInstance implements AutoCloseable {

    private final ConfigurableApplicationContext context;
    private final String instanceId;
    private static final HttpClient HTTP = HttpClient.newHttpClient();

    private ChatInstance(ConfigurableApplicationContext context, String instanceId) {
        this.context = context;
        this.instanceId = instanceId;
    }

    public static Builder on(PostgreSQLContainer postgres, String instanceId) {
        return new Builder(postgres, instanceId);
    }

    public static final class Builder {
        private final Map<String, Object> properties = new LinkedHashMap<>();
        private final List<Class<?>> sources = new ArrayList<>(List.of(ChatServiceApplication.class));
        private final String instanceId;

        private Builder(PostgreSQLContainer postgres, String instanceId) {
            this.instanceId = instanceId;
            properties.put("server.port", 0);
            properties.put("spring.datasource.url", postgres.getJdbcUrl());
            properties.put("spring.datasource.username", postgres.getUsername());
            properties.put("spring.datasource.password", postgres.getPassword());
            properties.put("chat.instance-id", instanceId);
            properties.put("spring.main.banner-mode", "off");
        }

        public Builder property(String key, Object value) {
            properties.put(key, value);
            return this;
        }

        public Builder with(Class<?> configuration) {
            sources.add(configuration);
            return this;
        }

        public ChatInstance start() {
            // Command-line args: they override application.yml (builder "properties" would not).
            String[] args = properties.entrySet().stream().map(e -> "--" + e.getKey() + "=" + e.getValue())
                    .toArray(String[]::new);
            ConfigurableApplicationContext context = new SpringApplicationBuilder(sources.toArray(Class[]::new))
                    .run(args);
            return new ChatInstance(context, instanceId);
        }

        /** Starts and waits until the listener is active (readiness UP). */
        public ChatInstance startReady() {
            ChatInstance instance = start();
            instance.awaitReadiness(200, Duration.ofSeconds(20));
            return instance;
        }
    }

    public String id() {
        return instanceId;
    }

    public <T> T bean(Class<T> type) {
        return context.getBean(type);
    }

    public int port() {
        return ((WebServerApplicationContext) context).getWebServer().getPort();
    }

    public String wsUrl() {
        return "ws://localhost:" + port() + "/ws";
    }

    /** HTTP status of /actuator/health/readiness (200 UP, 503 not ready). */
    public int readinessStatus() {
        try {
            return HTTP.send(HttpRequest.newBuilder(URI.create("http://localhost:" + port()
                    + "/actuator/health/readiness")).build(), HttpResponse.BodyHandlers.discarding()).statusCode();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    /** HTTP status of a raw WebSocket handshake on /ws (101 accepted, 503 refused). */
    public int handshakeStatus() {
        try {
            WebSocket ws = HTTP.newWebSocketBuilder().connectTimeout(Duration.ofSeconds(5))
                    .buildAsync(URI.create(wsUrl()), new WebSocket.Listener() { })
                    .get(10, TimeUnit.SECONDS);
            ws.abort();
            return 101;
        } catch (Exception e) {
            Throwable cause = e instanceof CompletionException || e.getCause() != null ? e.getCause() : e;
            if (cause instanceof WebSocketHandshakeException h) {
                return h.getResponse().statusCode();
            }
            throw new IllegalStateException(e);
        }
    }

    public void awaitReadiness(int status, Duration timeout) {
        await(() -> readinessStatus() == status, timeout, "readiness " + status + " on " + instanceId);
    }

    public static void await(BooleanSupplier condition, Duration timeout, String what) {
        long deadline = System.nanoTime() + timeout.toNanos();
        while (System.nanoTime() < deadline) {
            if (condition.getAsBoolean()) {
                return;
            }
            try {
                Thread.sleep(50);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new IllegalStateException(e);
            }
        }
        throw new AssertionError("timed out after " + timeout + " waiting for " + what);
    }

    @Override
    public void close() {
        context.close();
    }
}
