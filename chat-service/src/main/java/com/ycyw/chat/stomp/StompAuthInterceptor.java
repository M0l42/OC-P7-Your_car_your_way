package com.ycyw.chat.stomp;

import com.ycyw.chat.conversation.ChatError;
import com.ycyw.chat.conversation.ChatException;
import com.ycyw.chat.conversation.ConversationService;
import com.ycyw.chat.security.Actor;
import com.ycyw.chat.security.TokenVerifier;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.context.annotation.Lazy;
import org.springframework.messaging.Message;
import org.springframework.messaging.MessageChannel;
import org.springframework.messaging.simp.stomp.StompCommand;
import org.springframework.messaging.simp.stomp.StompHeaderAccessor;
import org.springframework.messaging.support.ChannelInterceptor;
import org.springframework.messaging.support.MessageHeaderAccessor;
import org.springframework.stereotype.Component;

/**
 * Authentication and destination authorization for every inbound STOMP frame (A5, A7, O4;
 * protocol.md §3.2–3.3). A rejection drops the frame and sends an ERROR frame (header {@code message} =
 * code, {@code receipt-id} if the frame had a receipt) on clientOutboundChannel; Spring closes the session
 * after an ERROR. The ERROR is sent here rather than by throwing, because with setPreserveReceiveOrder
 * Spring's ordered inbound decorator logs and swallows interceptor exceptions (no ERROR would reach
 * the client).
 *
 * <ul>
 *   <li>CONNECT: verify the bearer token (signature, iss, aud, exp) → session user. Expired →
 *       {@code TOKEN_EXPIRED}, anything else → {@code UNAUTHORIZED}. The token is not re-checked later.</li>
 *   <li>Any other frame on a session without a user → {@code UNAUTHORIZED}.</li>
 *   <li>SUBSCRIBE: own conversation topics per {@code ConversationAccessPolicy} (else {@code NOT_FOUND}),
 *       {@code /topic/queue} for agents, own {@code /user/queue/acks|errors}; anything else {@code FORBIDDEN}.</li>
 *   <li>SEND: only {@code /app/conversations/{id}/messages} (never {@code /topic/**}).</li>
 * </ul>
 */
@Component
public class StompAuthInterceptor implements ChannelInterceptor {

    private static final Pattern CONVERSATION_TOPIC = Pattern.compile("^/topic/conversations/(\\d{1,18})$");
    private static final Pattern SEND_DESTINATION = Pattern.compile("^/app/conversations/\\d{1,18}/messages$");
    private static final Set<String> USER_QUEUES = Set.of("/user/queue/acks", "/user/queue/errors");

    private final TokenVerifier tokens;
    private final ConversationService conversations;
    private final MessageChannel clientOutboundChannel;

    public StompAuthInterceptor(TokenVerifier tokens, ConversationService conversations,
            @Lazy @Qualifier("clientOutboundChannel") MessageChannel clientOutboundChannel) {
        this.tokens = tokens;
        this.conversations = conversations;
        this.clientOutboundChannel = clientOutboundChannel;
    }

    @Override
    public Message<?> preSend(Message<?> message, MessageChannel channel) {
        StompHeaderAccessor accessor = MessageHeaderAccessor.getAccessor(message, StompHeaderAccessor.class);
        if (accessor == null || accessor.getCommand() == null) {
            return message; // heart-beat
        }
        try {
            authorize(accessor);
            return message;
        } catch (ChatException rejection) {
            clientOutboundChannel.send(StompErrorHandler.errorFrame(rejection, accessor, accessor.getSessionId()));
            return null; // frame dropped
        }
    }

    private void authorize(StompHeaderAccessor accessor) {
        StompCommand command = accessor.getCommand();
        if (command == StompCommand.CONNECT || command == StompCommand.STOMP) {
            String authorization = accessor.getFirstNativeHeader("Authorization");
            if (authorization == null) {
                authorization = accessor.getFirstNativeHeader("authorization");
            }
            accessor.setUser(new ActorPrincipal(tokens.verify(authorization)));
            return;
        }
        if (command == StompCommand.DISCONNECT) {
            return;
        }
        Actor actor = ActorPrincipal.actorOf(accessor.getUser());
        if (actor == null) {
            throw new ChatException(ChatError.UNAUTHORIZED, command + " before an authenticated CONNECT");
        }
        if (command == StompCommand.SUBSCRIBE) {
            authorizeSubscribe(actor, accessor.getDestination());
        } else if (command == StompCommand.SEND) {
            String destination = accessor.getDestination();
            if (destination == null || !SEND_DESTINATION.matcher(destination).matches()) {
                throw new ChatException(ChatError.FORBIDDEN, "SEND not allowed to " + destination);
            }
        }
    }

    private void authorizeSubscribe(Actor actor, String destination) {
        if (destination == null) {
            throw new ChatException(ChatError.FORBIDDEN, "SUBSCRIBE without destination");
        }
        if (USER_QUEUES.contains(destination)) {
            return;
        }
        if ("/topic/queue".equals(destination)) {
            if (!actor.isAgent()) {
                throw new ChatException(ChatError.FORBIDDEN, "/topic/queue is for agents");
            }
            return;
        }
        Matcher m = CONVERSATION_TOPIC.matcher(destination);
        if (m.matches()) {
            conversations.get(actor, Long.parseLong(m.group(1))); // NOT_FOUND unless visible (O4)
            return;
        }
        throw new ChatException(ChatError.FORBIDDEN, "SUBSCRIBE not allowed to " + destination);
    }
}
