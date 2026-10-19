package com.ycyw.chat.stomp;

import java.io.IOException;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketHandler;
import org.springframework.web.socket.WebSocketMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.WebSocketHandlerDecorator;
import org.springframework.web.socket.handler.WebSocketHandlerDecoratorFactory;
import org.springframework.web.socket.handler.WebSocketSessionDecorator;

/**
 * Adds {@code instance-id:<chat.instance-id>} to the CONNECTED frame (C5 instance badge, protocol.md §3.2).
 * Spring builds CONNECTED itself and copies no application headers into it, so the header is inserted
 * where the frame leaves for the client: right after the {@code CONNECTED} command line.
 */
@Component
public class InstanceIdHeader implements WebSocketHandlerDecoratorFactory {

    private static final String CONNECTED = "CONNECTED\n";

    private final String headerLine;

    public InstanceIdHeader(@Value("${chat.instance-id}") String instanceId) {
        this.headerLine = "instance-id:" + instanceId.replaceAll("[\\r\\n:]", "_") + "\n";
    }

    @Override
    public WebSocketHandler decorate(WebSocketHandler handler) {
        return new WebSocketHandlerDecorator(handler) {
            @Override
            public void afterConnectionEstablished(WebSocketSession session) throws Exception {
                super.afterConnectionEstablished(new WebSocketSessionDecorator(session) {
                    @Override
                    public void sendMessage(WebSocketMessage<?> message) throws IOException {
                        if (message instanceof TextMessage text && text.getPayload().startsWith(CONNECTED)) {
                            message = new TextMessage(CONNECTED + headerLine
                                    + text.getPayload().substring(CONNECTED.length()));
                        }
                        super.sendMessage(message);
                    }
                });
            }
        };
    }
}
