package com.ycyw.chat.fanout;

import com.ycyw.chat.conversation.Conversation;
import com.ycyw.chat.conversation.ConversationRepository;
import com.ycyw.chat.events.QueueEventType;
import com.ycyw.chat.message.Item;
import com.ycyw.chat.message.MessageRepository;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * Turns one {@code chat_events} notification into a publish on the local simple broker. Runs on the
 * listener thread only (single-threaded on purpose: NOTIFY commit order + one thread +
 * setPreservePublishOrder keep per-subscription seq order, protocol.md §3.6).
 *
 * <p>Any failure (bad payload, row not found, DB error, broker error) is thrown: the listener treats
 * it like a lost LISTEN connection (O1), because the notification is consumed and would otherwise be
 * silently lost for this instance's subscribers.
 */
@Component
public class FanoutPublisher {

    public static final String CONVERSATION_TOPIC = "/topic/conversations/";
    public static final String QUEUE_TOPIC = "/topic/queue";

    /** Queue event on {@code /topic/queue}; {@code conversation} is read at publish time. */
    public record QueueEvent(QueueEventType t, long conversationId, Conversation conversation) {
    }

    private final MessageRepository messages;
    private final ConversationRepository conversations;
    private final SimpMessagingTemplate broker;
    private final JsonMapper json;

    public FanoutPublisher(MessageRepository messages, ConversationRepository conversations,
            SimpMessagingTemplate broker, JsonMapper json) {
        this.messages = messages;
        this.conversations = conversations;
        this.broker = broker;
        this.json = json;
    }

    public void publish(String payload) {
        JsonNode event = json.readTree(payload);
        String type = event.required("t").asString();
        long conversationId = event.required("c").asLong();
        switch (type) {
            case "msg" -> {
                int seq = event.required("s").asInt();
                Item item = messages.findBySeq(conversationId, seq).orElseThrow(() -> new IllegalStateException(
                        "notified item " + conversationId + "/" + seq + " not found"));
                broker.convertAndSend(CONVERSATION_TOPIC + conversationId, item);
            }
            case "queue" -> {
                QueueEventType queueEvent = QueueEventType.fromWire(event.required("e").asString());
                Conversation conversation = conversations.findById(conversationId).orElseThrow(
                        () -> new IllegalStateException("notified conversation " + conversationId + " not found"));
                broker.convertAndSend(QUEUE_TOPIC, new QueueEvent(queueEvent, conversationId, conversation));
            }
            default -> throw new IllegalStateException("unknown event type " + type);
        }
    }
}
