package com.ycyw.chat.support;

import java.lang.reflect.Type;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.springframework.messaging.Message;
import org.springframework.messaging.MessageHeaders;
import org.springframework.messaging.converter.AbstractMessageConverter;
import org.springframework.messaging.simp.stomp.StompCommand;
import org.springframework.messaging.simp.stomp.StompFrameHandler;
import org.springframework.messaging.simp.stomp.StompHeaders;
import org.springframework.messaging.simp.stomp.StompSession;
import org.springframework.messaging.simp.stomp.StompSessionHandlerAdapter;
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler;
import org.springframework.util.MimeTypeUtils;
import org.springframework.web.socket.WebSocketHttpHeaders;
import org.springframework.web.socket.client.standard.StandardWebSocketClient;
import org.springframework.web.socket.messaging.WebSocketStompClient;

/**
 * Thin STOMP client for integration tests (tests 2, 4c, 4e, O1, auth): connect, subscribe with or
 * without receipt, send JSON, receive frames per destination, observe ERROR frames and closes.
 * Bodies stay raw JSON strings; assertions parse them.
 */
public final class StompTestClient implements AutoCloseable {

    /** One received MESSAGE or ERROR frame. */
    public record Frame(StompHeaders headers, String body) {
    }

    private static final ThreadPoolTaskScheduler SCHEDULER = new ThreadPoolTaskScheduler();

    static {
        SCHEDULER.setPoolSize(2);
        SCHEDULER.setThreadNamePrefix("stomp-test-client-");
        SCHEDULER.setDaemon(true);
        SCHEDULER.initialize();
    }

    private final StompSession session;
    private final StompHeaders connected;
    private final Map<String, BlockingQueue<Frame>> messages = new ConcurrentHashMap<>();
    private final BlockingQueue<Frame> errors;
    private final CompletableFuture<Throwable> closed;
    private final AtomicInteger ids = new AtomicInteger();

    private StompTestClient(StompSession session, StompHeaders connected, BlockingQueue<Frame> errors,
            CompletableFuture<Throwable> closed) {
        this.session = session;
        this.connected = connected;
        this.errors = errors;
        this.closed = closed;
    }

    public static StompTestClient connect(String url, StompHeaders connectHeaders) {
        return connect(url, new WebSocketHttpHeaders(), connectHeaders);
    }

    public static StompTestClient connect(String url, WebSocketHttpHeaders handshakeHeaders,
            StompHeaders connectHeaders) {
        WebSocketStompClient client = new WebSocketStompClient(new StandardWebSocketClient());
        client.setMessageConverter(new RawJsonConverter());
        client.setInboundMessageSizeLimit(1024 * 1024);
        client.setTaskScheduler(SCHEDULER);
        client.setReceiptTimeLimit(30_000);
        BlockingQueue<Frame> errors = new LinkedBlockingQueue<>();
        CompletableFuture<Throwable> closed = new CompletableFuture<>();
        CompletableFuture<StompHeaders> connectedFuture = new CompletableFuture<>();
        StompSessionHandlerAdapter handler = new StompSessionHandlerAdapter() {
            @Override
            public void afterConnected(StompSession s, StompHeaders headers) {
                connectedFuture.complete(headers);
            }

            @Override
            public Type getPayloadType(StompHeaders headers) {
                return String.class;
            }

            @Override
            public void handleFrame(StompHeaders headers, Object payload) {
                // Only ERROR frames reach the session handler.
                Frame frame = new Frame(headers, payload == null ? "" : payload.toString());
                errors.add(frame);
                connectedFuture.completeExceptionally(new IllegalStateException("ERROR " + headers.getFirst("message")));
            }

            @Override
            public void handleException(StompSession s, StompCommand command, StompHeaders headers,
                    byte[] payload, Throwable exception) {
                errors.add(new Frame(headers, exception.toString()));
            }

            @Override
            public void handleTransportError(StompSession s, Throwable exception) {
                closed.complete(exception);
                connectedFuture.completeExceptionally(exception);
            }
        };
        try {
            StompSession session = client.connectAsync(url, handshakeHeaders, connectHeaders, handler)
                    .get(10, TimeUnit.SECONDS);
            StompHeaders headers = connectedFuture.get(10, TimeUnit.SECONDS);
            return new StompTestClient(session, headers, errors, closed);
        } catch (Exception e) {
            throw new IllegalStateException("STOMP connect to " + url + " failed: " + e, e);
        }
    }

    public StompHeaders connectedHeaders() {
        return connected;
    }

    /** SUBSCRIBE with a {@code receipt} header; returns once the RECEIPT arrived (fails after timeout). */
    public void subscribeWithReceipt(String destination, Duration timeout) {
        CompletableFuture<Void> receipt = new CompletableFuture<>();
        StompSession.Subscription subscription = subscribe(destination, "r-" + ids.incrementAndGet());
        subscription.addReceiptTask(() -> receipt.complete(null));
        subscription.addReceiptLostTask(() -> receipt.completeExceptionally(new IllegalStateException("receipt lost")));
        try {
            receipt.get(timeout.toMillis(), TimeUnit.MILLISECONDS);
        } catch (Exception e) {
            throw new IllegalStateException("no RECEIPT for " + destination + " within " + timeout, e);
        }
    }

    /** SUBSCRIBE with a {@code receipt} header; true if a RECEIPT arrived within the timeout. */
    public boolean subscribeAndAwaitReceipt(String destination, Duration timeout) {
        try {
            subscribeWithReceipt(destination, timeout);
            return true;
        } catch (IllegalStateException e) {
            return false;
        }
    }

    /** SUBSCRIBE without receipt (e.g. /user/queue/acks). */
    public void subscribe(String destination) {
        subscribe(destination, null);
    }

    private StompSession.Subscription subscribe(String destination, String receipt) {
        BlockingQueue<Frame> queue = messages.computeIfAbsent(destination, d -> new LinkedBlockingQueue<>());
        StompHeaders headers = new StompHeaders();
        headers.setDestination(destination);
        headers.setId("sub-" + ids.incrementAndGet());
        if (receipt != null) {
            headers.setReceipt(receipt);
        }
        return session.subscribe(headers, new StompFrameHandler() {
            @Override
            public Type getPayloadType(StompHeaders h) {
                return String.class;
            }

            @Override
            public void handleFrame(StompHeaders h, Object payload) {
                queue.add(new Frame(h, (String) payload));
            }
        });
    }

    public void send(String destination, String json) {
        StompHeaders headers = new StompHeaders();
        headers.setDestination(destination);
        headers.setContentType(MimeTypeUtils.APPLICATION_JSON);
        session.send(headers, json);
    }

    /** Next frame received on {@code destination}, or null after the timeout. */
    public Frame next(String destination, Duration timeout) throws InterruptedException {
        return messages.computeIfAbsent(destination, d -> new LinkedBlockingQueue<>())
                .poll(timeout.toMillis(), TimeUnit.MILLISECONDS);
    }

    public List<Frame> pending(String destination) {
        return List.copyOf(messages.computeIfAbsent(destination, d -> new LinkedBlockingQueue<>()));
    }

    public Frame nextError(Duration timeout) throws InterruptedException {
        return errors.poll(timeout.toMillis(), TimeUnit.MILLISECONDS);
    }

    /** True once the server closed the connection (or the transport failed) within the timeout. */
    public boolean awaitClosed(Duration timeout) {
        try {
            closed.get(timeout.toMillis(), TimeUnit.MILLISECONDS);
            return true;
        } catch (Exception e) {
            return closed.isDone() || !session.isConnected();
        }
    }

    public boolean isConnected() {
        return session.isConnected() && !closed.isDone();
    }

    @Override
    public void close() {
        if (session.isConnected()) {
            try {
                session.disconnect();
            } catch (RuntimeException ignored) {
                // already closed by the server
            }
        }
    }

    /** Strings in, strings out, whatever the content-type (JSON bodies, text ERROR bodies). */
    private static final class RawJsonConverter extends AbstractMessageConverter {

        RawJsonConverter() {
            super(List.of(MimeTypeUtils.APPLICATION_JSON, MimeTypeUtils.TEXT_PLAIN,
                    MimeTypeUtils.APPLICATION_OCTET_STREAM));
            setStrictContentTypeMatch(false);
        }

        @Override
        protected boolean supports(Class<?> clazz) {
            return String.class == clazz;
        }

        @Override
        protected boolean supportsMimeType(MessageHeaders headers) {
            return true;
        }

        @Override
        protected Object convertFromInternal(Message<?> message, Class<?> targetClass, Object conversionHint) {
            Object payload = message.getPayload();
            return payload instanceof byte[] bytes ? new String(bytes, StandardCharsets.UTF_8) : payload.toString();
        }

        @Override
        protected Object convertToInternal(Object payload, MessageHeaders headers, Object conversionHint) {
            return ((String) payload).getBytes(StandardCharsets.UTF_8);
        }
    }
}
