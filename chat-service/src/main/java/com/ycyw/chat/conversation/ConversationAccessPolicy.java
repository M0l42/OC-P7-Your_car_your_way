package com.ycyw.chat.conversation;

import com.ycyw.chat.security.Actor;
import org.springframework.stereotype.Component;

/**
 * The single authorization rule for SUBSCRIBE, SEND and every REST endpoint (O4, A4; protocol.md §5).
 *
 * <p>Visibility: a customer sees only its own conversations; an agent sees {@code en_attente}
 * conversations and the ones it claimed. Not visible → {@code NOT_FOUND}, never 403, so ids cannot
 * be probed. Action rights are checked only on visible conversations.
 */
@Component
public class ConversationAccessPolicy {

    public boolean canSee(Actor actor, Conversation c) {
        if (actor.isCustomer()) {
            return c.customerRef().equals(actor.ref());
        }
        return c.status() == ConversationStatus.EN_ATTENTE || actor.ref().equals(c.agentRef());
    }

    public void requireVisible(Actor actor, Conversation c) {
        if (!canSee(actor, c)) {
            throw notFound(c.id());
        }
    }

    /** SEND rights; idempotent retries are handled before this check (A2). */
    public void requireCanSend(Actor actor, Conversation c) {
        requireVisible(actor, c);
        if (c.isClosed()) {
            throw new ChatException(ChatError.CONVERSATION_CLOSED, "Conversation " + c.id() + " is closed");
        }
        if (actor.isAgent() && !actor.ref().equals(c.agentRef())) {
            throw new ChatException(ChatError.FORBIDDEN, "Claim conversation " + c.id() + " before posting");
        }
    }

    /** A4: customer from en_attente/en_cours, claiming agent from en_cours, closed → 409. */
    public void requireCanClose(Actor actor, Conversation c) {
        requireVisible(actor, c);
        if (c.isClosed()) {
            throw new ChatException(ChatError.CONVERSATION_CLOSED, "Conversation " + c.id() + " is already closed");
        }
        if (actor.isAgent() && !actor.ref().equals(c.agentRef())) {
            throw new ChatException(ChatError.FORBIDDEN, "Only the claiming agent may close conversation " + c.id());
        }
    }

    /**
     * Claim rights. The only rule that answers about a conversation the agent cannot see: the loser
     * of a claim race must get 409 ALREADY_CLAIMED, not 404 (test plan, protocol.md §4.5).
     */
    public void requireCanClaim(Actor actor, Conversation c) {
        if (actor.isCustomer()) {
            requireVisible(actor, c);
            throw new ChatException(ChatError.FORBIDDEN, "Only agents may claim a conversation");
        }
    }

    public static ChatException notFound(long id) {
        return new ChatException(ChatError.NOT_FOUND, "Conversation " + id + " not found");
    }
}
