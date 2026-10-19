package com.ycyw.chat.conversation;

import com.fasterxml.jackson.annotation.JsonIgnore;
import java.time.Instant;

/** A conversation row; also the {@code Conversation} JSON shape of protocol.md §2.1. */
public record Conversation(
        long id,
        ConversationStatus status,
        String customerRef,
        String customerKind,
        String reservationReference,
        String agentRef,
        int lastSeq,
        Instant createdAt,
        Instant claimedAt,
        Instant closedAt) {

    /** Not a wire field (protocol.md §2.1). */
    @JsonIgnore
    public boolean isClosed() {
        return status == ConversationStatus.CLOTUREE;
    }
}
