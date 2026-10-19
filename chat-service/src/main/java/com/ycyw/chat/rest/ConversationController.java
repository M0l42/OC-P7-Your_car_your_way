package com.ycyw.chat.rest;

import com.ycyw.chat.conversation.ChatError;
import com.ycyw.chat.conversation.ChatException;
import com.ycyw.chat.conversation.Conversation;
import com.ycyw.chat.conversation.ConversationService;
import com.ycyw.chat.conversation.ConversationService.ConversationPage;
import com.ycyw.chat.conversation.ConversationService.ItemPage;
import com.ycyw.chat.conversation.ConversationService.OpenResult;
import com.ycyw.chat.conversation.ConversationStatus;
import com.ycyw.chat.security.Actor;
import com.ycyw.chat.stomp.ActorPrincipal;
import java.net.URI;
import java.util.UUID;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * REST API (protocol.md §4). Every endpoint goes through ConversationService, which applies the one
 * ConversationAccessPolicy (O4): invisible conversations are 404, never 403.
 */
@RestController
@RequestMapping("/api/conversations")
public class ConversationController {

    private final ConversationService conversations;

    public ConversationController(ConversationService conversations) {
        this.conversations = conversations;
    }

    public record OpenRequest(String clientRequestId, String reservationReference) {
    }

    /** 201 for a new conversation, 200 with the existing one for a replayed clientRequestId (A6). */
    @PostMapping
    public ResponseEntity<Conversation> open(Authentication auth, @RequestBody OpenRequest request) {
        UUID clientRequestId = uuid(request.clientRequestId(), "clientRequestId");
        OpenResult result = conversations.open(actor(auth), clientRequestId, request.reservationReference());
        Conversation c = result.conversation();
        return result.created()
                ? ResponseEntity.created(URI.create("/api/conversations/" + c.id())).body(c)
                : ResponseEntity.ok(c);
    }

    /** {@code ?status=en_attente}: agent queue (oldest 50 + total); no status: "my conversations". */
    @GetMapping
    public ConversationPage list(Authentication auth, @RequestParam(required = false) String status) {
        if (status == null) {
            return conversations.mine(actor(auth));
        }
        if (!ConversationStatus.EN_ATTENTE.dbValue().equals(status)) {
            throw new ChatException(ChatError.INVALID_REQUEST, "status must be en_attente or absent");
        }
        return conversations.waitingQueue(actor(auth));
    }

    @GetMapping("/{id}")
    public Conversation get(Authentication auth, @PathVariable long id) {
        return conversations.get(actor(auth), id);
    }

    @PostMapping("/{id}/claim")
    public Conversation claim(Authentication auth, @PathVariable long id) {
        return conversations.claim(actor(auth), id);
    }

    @PostMapping("/{id}/close")
    public Conversation close(Authentication auth, @PathVariable long id) {
        return conversations.close(actor(auth), id);
    }

    /** Backfill page (P1): seq &gt; afterSeq ascending, at most limit (default and max 200) + hasMore. */
    @GetMapping("/{id}/messages")
    public ItemPage messages(Authentication auth, @PathVariable long id,
            @RequestParam(defaultValue = "0") int afterSeq,
            @RequestParam(defaultValue = "" + ConversationService.MAX_PAGE) int limit) {
        return conversations.items(actor(auth), id, afterSeq, limit);
    }

    private static Actor actor(Authentication auth) {
        Actor actor = auth != null && auth.getPrincipal() instanceof ActorPrincipal p ? p.actor() : null;
        if (actor == null) {
            throw new ChatException(ChatError.UNAUTHORIZED, "not authenticated");
        }
        return actor;
    }

    private static UUID uuid(String value, String field) {
        try {
            return UUID.fromString(value);
        } catch (IllegalArgumentException | NullPointerException e) {
            throw new ChatException(ChatError.INVALID_REQUEST, field + " must be a UUID string");
        }
    }
}
