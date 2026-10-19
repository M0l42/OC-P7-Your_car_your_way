package com.ycyw.chat.fanout;

import java.io.IOException;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.WebSocketHandler;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.WebSocketHandlerDecorator;
import org.springframework.web.socket.handler.WebSocketHandlerDecoratorFactory;
import org.springframework.web.socket.server.HandshakeInterceptor;
import org.springframework.http.HttpStatus;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;

/**
 * Tracks this instance's WebSocket sessions so that a listener failure can close all of them
 * (A3, O1), and refuses handshakes with 503 while the listener is down.
 *
 * <p>Race-free with {@link ListenerReadiness}: a session registers first, then checks the
 * generation it was accepted in; a failure marks DOWN (new generation) first, then closes every
 * registered session. Whatever the interleaving, a session that might have missed a notification
 * is closed.
 */
@Component
public class WebSocketSessionRegistry implements WebSocketHandlerDecoratorFactory, HandshakeInterceptor {

    /** RFC 6455 1012 "service restart": the client reconnects (protocol.md §3.7). */
    public static final CloseStatus LISTENER_LOST = CloseStatus.SERVICE_RESTARTED;

    private static final Logger log = LoggerFactory.getLogger(WebSocketSessionRegistry.class);
    private static final String GENERATION = "chat.listenerGeneration";

    private final ListenerReadiness readiness;
    private final Map<String, WebSocketSession> sessions = new ConcurrentHashMap<>();

    public WebSocketSessionRegistry(ListenerReadiness readiness) {
        this.readiness = readiness;
    }

    // ---- handshake gate ---------------------------------------------------------------------------

    @Override
    public boolean beforeHandshake(ServerHttpRequest request, ServerHttpResponse response, WebSocketHandler handler,
            Map<String, Object> attributes) {
        if (!readiness.isReady()) {
            response.setStatusCode(HttpStatus.SERVICE_UNAVAILABLE);
            return false;
        }
        attributes.put(GENERATION, readiness.generation());
        return true;
    }

    @Override
    public void afterHandshake(ServerHttpRequest request, ServerHttpResponse response, WebSocketHandler handler,
            Exception exception) {
    }

    // ---- session tracking ---------------------------------------------------------------------------

    @Override
    public WebSocketHandler decorate(WebSocketHandler handler) {
        return new WebSocketHandlerDecorator(handler) {
            @Override
            public void afterConnectionEstablished(WebSocketSession session) throws Exception {
                sessions.put(session.getId(), session);
                Object generation = session.getAttributes().get(GENERATION);
                if (!(generation instanceof Long g) || !readiness.isCurrent(g)) {
                    sessions.remove(session.getId());
                    session.close(LISTENER_LOST);
                    return;
                }
                super.afterConnectionEstablished(session);
            }

            @Override
            public void afterConnectionClosed(WebSocketSession session, CloseStatus status) throws Exception {
                sessions.remove(session.getId());
                super.afterConnectionClosed(session, status);
            }
        };
    }

    public int size() {
        return sessions.size();
    }

    /** Closes every session; their clients reconnect (to a ready instance) and backfill. */
    public void closeAll() {
        int closed = 0;
        for (WebSocketSession session : sessions.values()) {
            sessions.remove(session.getId());
            try {
                session.close(LISTENER_LOST);
                closed++;
            } catch (IOException | RuntimeException e) {
                log.debug("closing session {} failed: {}", session.getId(), e.toString());
            }
        }
        if (closed > 0) {
            log.warn("Closed {} WebSocket sessions after listener failure", closed);
        }
    }
}
