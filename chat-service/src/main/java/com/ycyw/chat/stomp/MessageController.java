package com.ycyw.chat.stomp;

import com.ycyw.chat.conversation.ChatError;
import com.ycyw.chat.conversation.ChatException;
import com.ycyw.chat.message.MessageWriteService;
import com.ycyw.chat.message.MessageWriteService.SendResult;
import com.ycyw.chat.security.Actor;
import java.security.Principal;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.messaging.Message;
import org.springframework.messaging.MessageHeaders;
import org.springframework.messaging.handler.annotation.DestinationVariable;
import org.springframework.messaging.handler.annotation.MessageMapping;
import org.springframework.messaging.simp.SimpMessageHeaderAccessor;
import org.springframework.messaging.simp.SimpMessageType;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.stereotype.Controller;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * {@code SEND /app/conversations/{id}/messages {clientMessageId, content}} (protocol.md §3.5). After the
 * write transaction commits: ack on {@code /user/queue/acks}, or error on {@code /user/queue/errors},
 * both to the <em>sending session only</em> (session-targeted user destination, not every session of
 * the user). An unexpected failure sends nothing: the client resends after its 5 s ack timeout.
 */
@Controller
public class MessageController {

    private static final Logger log = LoggerFactory.getLogger(MessageController.class);

    public record Ack(long conversationId, String clientMessageId, int seq) {
    }

    public record SendError(long conversationId, String clientMessageId, ChatError code, String reason) {
    }

    private final MessageWriteService writer;
    private final SimpMessagingTemplate template;
    private final JsonMapper json;

    public MessageController(MessageWriteService writer, SimpMessagingTemplate template, JsonMapper json) {
        this.writer = writer;
        this.template = template;
        this.json = json;
    }

    @MessageMapping("/conversations/{id}/messages")
    public void send(@DestinationVariable long id, Message<byte[]> message, Principal principal) {
        Actor actor = ActorPrincipal.actorOf(principal);
        String sessionId = SimpMessageHeaderAccessor.getSessionId(message.getHeaders());
        String clientMessageId = null;
        try {
            JsonNode body = json.readTree(message.getPayload());
            JsonNode idNode = body.get("clientMessageId");
            clientMessageId = idNode != null && idNode.isString() ? idNode.asString() : null;
            UUID uuid = parseUuid(clientMessageId);
            JsonNode contentNode = body.get("content");
            String content = contentNode != null && contentNode.isString() ? contentNode.asString() : null;
            SendResult result = writer.send(actor, id, uuid, content);
            toSession(principal, sessionId, "/queue/acks",
                    new Ack(id, result.clientMessageId().toString(), result.seq()));
        } catch (ChatException e) {
            toSession(principal, sessionId, "/queue/errors", new SendError(id, clientMessageId, e.code(), e.reason()));
        } catch (JacksonException e) {
            toSession(principal, sessionId, "/queue/errors",
                    new SendError(id, null, ChatError.INVALID_REQUEST, "body must be a JSON object"));
        } catch (RuntimeException e) {
            log.warn("send to conversation {} failed, client will retry: {}", id, e.toString());
        }
    }

    private static UUID parseUuid(String value) {
        if (value == null) {
            throw new ChatException(ChatError.INVALID_REQUEST, "clientMessageId must be a UUID string");
        }
        try {
            return UUID.fromString(value);
        } catch (IllegalArgumentException e) {
            throw new ChatException(ChatError.INVALID_REQUEST, "clientMessageId must be a UUID string");
        }
    }

    private void toSession(Principal principal, String sessionId, String destination, Object payload) {
        SimpMessageHeaderAccessor headers = SimpMessageHeaderAccessor.create(SimpMessageType.MESSAGE);
        headers.setSessionId(sessionId);
        headers.setLeaveMutable(true);
        MessageHeaders messageHeaders = headers.getMessageHeaders();
        template.convertAndSendToUser(principal.getName(), destination, payload, messageHeaders);
    }
}
