package com.ycyw.chat.conversation;

import static com.ycyw.chat.conversation.ConversationAccessPolicy.notFound;

import com.ycyw.chat.events.ChatEvents;
import com.ycyw.chat.events.QueueEventType;
import com.ycyw.chat.message.Item;
import com.ycyw.chat.message.ItemType;
import com.ycyw.chat.message.MessageRepository;
import com.ycyw.chat.message.SenderRole;
import com.ycyw.chat.security.Actor;
import com.ycyw.chat.security.Role;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Conversation lifecycle and reads. Claim and close use the send path's transaction shape:
 * lock the conversation → change status → append a {@code systeme} item with the next seq →
 * NOTIFY (item + queue event) → commit. Status changes are therefore part of the sequenced stream.
 */
@Service
public class ConversationService {

    public static final int QUEUE_LIMIT = 50;
    public static final int MINE_LIMIT = 50;
    public static final int MAX_PAGE = 200;
    public static final int MAX_RESERVATION_REFERENCE = 64;

    private final ConversationRepository conversations;
    private final MessageRepository messages;
    private final ConversationAccessPolicy policy;
    private final ChatEvents events;

    public ConversationService(ConversationRepository conversations, MessageRepository messages,
            ConversationAccessPolicy policy, ChatEvents events) {
        this.conversations = conversations;
        this.messages = messages;
        this.policy = policy;
        this.events = events;
    }

    public record OpenResult(Conversation conversation, boolean created) {
    }

    public record ConversationPage(List<Conversation> items, long total) {
    }

    public record ItemPage(List<Item> items, boolean hasMore) {
    }

    /** Idempotent by (customer, clientRequestId) (A6). */
    @Transactional
    public OpenResult open(Actor actor, UUID clientRequestId, String reservationReference) {
        if (!actor.isCustomer()) {
            throw new ChatException(ChatError.FORBIDDEN, "Only customers open conversations");
        }
        String reference = blankToNull(reservationReference);
        if (reference == null) {
            reference = blankToNull(actor.reservationReference());
        }
        if (reference != null && reference.length() > MAX_RESERVATION_REFERENCE) {
            throw new ChatException(ChatError.INVALID_REQUEST,
                    "reservationReference longer than " + MAX_RESERVATION_REFERENCE);
        }
        String kind = actor.role() == Role.GUEST ? "invite" : "compte";
        Optional<Conversation> created = conversations.insertIfAbsent(actor.ref(), kind, reference, clientRequestId);
        if (created.isPresent()) {
            events.queue(created.get().id(), QueueEventType.OPENED);
            return new OpenResult(created.get(), true);
        }
        // ON CONFLICT waited for any concurrent insert to commit; this new statement sees it.
        Conversation existing = conversations.findByClientRequest(actor.ref(), clientRequestId).orElseThrow();
        return new OpenResult(existing, false);
    }

    @Transactional(readOnly = true)
    public Conversation get(Actor actor, long id) {
        Conversation c = conversations.findById(id).orElseThrow(() -> notFound(id));
        policy.requireVisible(actor, c);
        return c;
    }

    /** First agent wins; the others get ALREADY_CLAIMED. Re-claiming one's own conversation is a no-op. */
    @Transactional
    public Conversation claim(Actor actor, long id) {
        Conversation c = conversations.lockById(id).orElseThrow(() -> notFound(id));
        policy.requireCanClaim(actor, c);
        if (c.status() == ConversationStatus.EN_COURS && actor.ref().equals(c.agentRef())) {
            return c;
        }
        conversations.claim(id, actor.ref()).orElseThrow(() -> new ChatException(ChatError.ALREADY_CLAIMED,
                "Conversation " + id + " is already " + c.status().dbValue()));
        appendSystemItem(id, ItemType.PRISE_EN_CHARGE, actor);
        events.queue(id, QueueEventType.CLAIMED);
        return conversations.findById(id).orElseThrow();
    }

    @Transactional
    public Conversation close(Actor actor, long id) {
        Conversation c = conversations.lockById(id).orElseThrow(() -> notFound(id));
        policy.requireCanClose(actor, c);
        conversations.close(id);
        appendSystemItem(id, ItemType.CLOTURE, actor);
        events.queue(id, QueueEventType.CLOSED);
        return conversations.findById(id).orElseThrow();
    }

    /** Agent queue: oldest 50 waiting + total (P1). */
    @Transactional(readOnly = true)
    public ConversationPage waitingQueue(Actor actor) {
        if (!actor.isAgent()) {
            throw new ChatException(ChatError.FORBIDDEN, "Only agents read the queue");
        }
        return new ConversationPage(conversations.findWaiting(QUEUE_LIMIT), conversations.countWaiting());
    }

    /** Customer: own conversations; agent: own in-progress conversations. Newest first. */
    @Transactional(readOnly = true)
    public ConversationPage mine(Actor actor) {
        if (actor.isCustomer()) {
            return new ConversationPage(conversations.findByCustomer(actor.ref(), MINE_LIMIT),
                    conversations.countByCustomer(actor.ref()));
        }
        return new ConversationPage(conversations.findInProgressByAgent(actor.ref(), MINE_LIMIT),
                conversations.countInProgressByAgent(actor.ref()));
    }

    /** Backfill page: seq &gt; afterSeq, ascending, at most {@code limit} (≤ 200) + hasMore (P1). */
    @Transactional(readOnly = true)
    public ItemPage items(Actor actor, long id, int afterSeq, int limit) {
        if (afterSeq < 0 || limit < 1 || limit > MAX_PAGE) {
            throw new ChatException(ChatError.INVALID_REQUEST, "afterSeq >= 0 and 1 <= limit <= " + MAX_PAGE);
        }
        Conversation c = conversations.findById(id).orElseThrow(() -> notFound(id));
        policy.requireVisible(actor, c);
        List<Item> page = messages.findAfter(id, afterSeq, limit + 1);
        boolean hasMore = page.size() > limit;
        return new ItemPage(hasMore ? List.copyOf(page.subList(0, limit)) : page, hasMore);
    }

    private void appendSystemItem(long id, ItemType type, Actor actor) {
        int seq = conversations.nextSeq(id);
        messages.insert(id, seq, UUID.randomUUID(), type, SenderRole.SYSTEME, actor.ref(), null);
        events.item(id, seq);
    }

    private static String blankToNull(String s) {
        return s == null || s.isBlank() ? null : s;
    }
}
