package com.ycyw.chat.support;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.net.http.WebSocketHandshakeException;
import java.time.Duration;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

/** A WebSocket without any STOMP client logic: raw frames, custom Origin, handshake status. */
public final class RawWebSocket implements AutoCloseable {

    private final WebSocket socket;
    private final BlockingQueue<String> frames;
    private final CompletableFuture<Integer> closed;

    private RawWebSocket(WebSocket socket, BlockingQueue<String> frames, CompletableFuture<Integer> closed) {
        this.socket = socket;
        this.frames = frames;
        this.closed = closed;
    }

    /** Handshake status only: 101 accepted, else the HTTP status of the refusal. */
    public static int handshakeStatus(String url, String origin) {
        try (RawWebSocket ws = open(url, origin)) {
            return 101;
        } catch (HandshakeRefused e) {
            return e.status;
        }
    }

    public static RawWebSocket open(String url, String origin) {
        BlockingQueue<String> frames = new LinkedBlockingQueue<>();
        CompletableFuture<Integer> closed = new CompletableFuture<>();
        StringBuilder partial = new StringBuilder();
        WebSocket.Listener listener = new WebSocket.Listener() {
            @Override
            public CompletionStage<?> onText(WebSocket ws, CharSequence data, boolean last) {
                partial.append(data);
                if (last) {
                    frames.add(partial.toString());
                    partial.setLength(0);
                }
                ws.request(1);
                return null;
            }

            @Override
            public CompletionStage<?> onClose(WebSocket ws, int statusCode, String reason) {
                closed.complete(statusCode);
                return null;
            }

            @Override
            public void onError(WebSocket ws, Throwable error) {
                closed.complete(-1);
            }
        };
        WebSocket.Builder builder = HttpClient.newHttpClient().newWebSocketBuilder()
                .connectTimeout(Duration.ofSeconds(5));
        if (origin != null) {
            builder.header("Origin", origin);
        }
        try {
            WebSocket socket = builder.buildAsync(URI.create(url), listener).get(10, TimeUnit.SECONDS);
            return new RawWebSocket(socket, frames, closed);
        } catch (Exception e) {
            for (Throwable t = e; t != null; t = t.getCause()) {
                if (t instanceof WebSocketHandshakeException h) {
                    throw new HandshakeRefused(h.getResponse().statusCode());
                }
            }
            throw new IllegalStateException(e);
        }
    }

    public void send(String text) {
        socket.sendText(text, true).join();
    }

    public String nextFrame(Duration timeout) throws InterruptedException {
        return frames.poll(timeout.toMillis(), TimeUnit.MILLISECONDS);
    }

    /** Close status code sent by the server, or null if still open after the timeout. */
    public Integer awaitClose(Duration timeout) {
        try {
            return closed.get(timeout.toMillis(), TimeUnit.MILLISECONDS);
        } catch (Exception e) {
            return null;
        }
    }

    @Override
    public void close() {
        socket.abort();
    }

    public static final class HandshakeRefused extends RuntimeException {
        public final int status;

        HandshakeRefused(int status) {
            super("handshake refused with " + status);
            this.status = status;
        }
    }
}
