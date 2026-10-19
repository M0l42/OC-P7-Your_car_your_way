package com.ycyw.chat.message;

import java.time.Instant;
import java.util.UUID;

/** One sequenced entry of a conversation stream; the {@code Item} JSON shape of protocol.md §2.2. */
public record Item(
        long conversationId,
        int seq,
        UUID clientMessageId,
        ItemType type,
        SenderRole senderRole,
        String senderRef,
        String content,
        Instant createdAt) {
}
