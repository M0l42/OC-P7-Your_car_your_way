package com.ycyw.chat.stomp;

import com.ycyw.chat.conversation.ChatError;
import com.ycyw.chat.conversation.ChatException;
import java.nio.charset.StandardCharsets;
import org.springframework.messaging.Message;
import org.springframework.messaging.simp.stomp.StompCommand;
import org.springframework.messaging.simp.stomp.StompHeaderAccessor;
import org.springframework.messaging.support.MessageBuilder;
import org.springframework.stereotype.Component;
import org.springframework.util.MimeTypeUtils;
import org.springframework.web.socket.messaging.StompSubProtocolErrorHandler;

/**
 * ERROR frames for rejected client frames (protocol.md §3.2–3.3): {@code message} header = machine
 * code, body = "CODE reason", {@code receipt-id} copied from the rejected frame's {@code receipt} so a
 * client can drop that one destination instead of reconnecting in a loop. Spring closes the session
 * after sending an ERROR.
 */
@Component
public class StompErrorHandler extends StompSubProtocolErrorHandler {

    /**
     * Used by Spring for errors raised while dispatching a client frame outside our interceptor. A frame
     * sent before CONNECT never reaches the interceptor: Spring rejects it ("Unknown session"), which
     * the contract reports as {@code UNAUTHORIZED} (A7).
     */
    @Override
    public Message<byte[]> handleClientMessageProcessingError(Message<byte[]> clientMessage, Throwable ex) {
        StompHeaderAccessor client = clientMessage == null ? null : StompHeaderAccessor.wrap(clientMessage);
        for (Throwable t = ex; t != null; t = t.getCause()) {
            if (t instanceof ChatException rejection) {
                return errorFrame(rejection, client, null);
            }
        }
        if (client != null && client.getCommand() != StompCommand.CONNECT && client.getCommand() != StompCommand.STOMP
                && client.getUser() == null) {
            return errorFrame(new ChatException(ChatError.UNAUTHORIZED,
                    client.getCommand() + " before an authenticated CONNECT"), client, null);
        }
        return super.handleClientMessageProcessingError(clientMessage, ex);
    }

    /** The ERROR frame for {@code rejection}; {@code sessionId} non-null when sent on clientOutboundChannel. */
    public static Message<byte[]> errorFrame(ChatException rejection, StompHeaderAccessor client, String sessionId) {
        StompHeaderAccessor error = StompHeaderAccessor.create(StompCommand.ERROR);
        error.setMessage(rejection.code().name());
        error.setContentType(MimeTypeUtils.TEXT_PLAIN);
        if (client != null && client.getReceipt() != null) {
            error.setReceiptId(client.getReceipt());
        }
        if (sessionId != null) {
            error.setSessionId(sessionId);
        }
        error.setLeaveMutable(true);
        byte[] body = (rejection.code().name() + " " + rejection.reason()).getBytes(StandardCharsets.UTF_8);
        return MessageBuilder.createMessage(body, error.getMessageHeaders());
    }
}
