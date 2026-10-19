package com.ycyw.chat.message;

import static com.ycyw.chat.conversation.ConversationAccessPolicy.notFound;

import com.ycyw.chat.conversation.ChatError;
import com.ycyw.chat.conversation.ChatException;
import com.ycyw.chat.conversation.Conversation;
import com.ycyw.chat.conversation.ConversationAccessPolicy;
import com.ycyw.chat.conversation.ConversationRepository;
import com.ycyw.chat.events.ChatEvents;
import com.ycyw.chat.security.Actor;
import java.util.Optional;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * The send path, one transaction (A2, protocol.md §3.5):
 * <pre>
 *  lock conversation FOR UPDATE ──absent──▶ NOT_FOUND
 *  lookup (conversation_id, client_message_id) ──found, same sender──▶ ack existing seq (no row, no NOTIFY)
 *  access / closed / content checks ──fail──▶ ChatException (rollback, no row)
 *  last_seq + 1 → INSERT message → pg_notify → COMMIT ──▶ ack new seq
 * </pre>
 * The idempotency lookup runs before the closed check, so a retry of a message stored just before a
 * close is acked, never reported as failed. The ack itself is sent by the caller after commit.
 */
@Service
public class MessageWriteService {

    public static final int MAX_CONTENT_CODE_POINTS = 2000;

    private final ConversationRepository conversations;
    private final MessageRepository messages;
    private final ConversationAccessPolicy policy;
    private final ChatEvents events;

    public MessageWriteService(ConversationRepository conversations, MessageRepository messages,
            ConversationAccessPolicy policy, ChatEvents events) {
        this.conversations = conversations;
        this.messages = messages;
        this.policy = policy;
        this.events = events;
    }

    /** {@code duplicate} is true for an idempotent retry (existing seq, nothing written). */
    public record SendResult(long conversationId, UUID clientMessageId, int seq, boolean duplicate) {
    }

    @Transactional
    public SendResult send(Actor actor, long conversationId, UUID clientMessageId, String content) {
        Conversation conversation = conversations.lockById(conversationId)
                .orElseThrow(() -> notFound(conversationId));

        Optional<Item> existing = messages.findByClientMessageId(conversationId, clientMessageId);
        if (existing.isPresent()) {
            Item item = existing.get();
            if (item.senderRef().equals(actor.ref()) && item.senderRole() == SenderRole.of(actor)) {
                return new SendResult(conversationId, clientMessageId, item.seq(), true);
            }
            policy.requireVisible(actor, conversation);
            throw new ChatException(ChatError.FORBIDDEN, "clientMessageId already used by another sender");
        }

        policy.requireCanSend(actor, conversation);
        validateContent(content);

        int seq = conversations.nextSeq(conversationId);
        messages.insert(conversationId, seq, clientMessageId, ItemType.TEXTE, SenderRole.of(actor), actor.ref(),
                content);
        events.item(conversationId, seq);
        return new SendResult(conversationId, clientMessageId, seq, false);
    }

    /** Same rule as the CHECK constraint (char_length counts code points), plus "not blank". No trimming. */
    static void validateContent(String content) {
        if (content == null || content.isBlank()) {
            throw new ChatException(ChatError.INVALID_CONTENT, "content must not be blank");
        }
        int length = content.codePointCount(0, content.length());
        if (length > MAX_CONTENT_CODE_POINTS) {
            throw new ChatException(ChatError.INVALID_CONTENT,
                    "content has " + length + " characters, max " + MAX_CONTENT_CODE_POINTS);
        }
    }
}
