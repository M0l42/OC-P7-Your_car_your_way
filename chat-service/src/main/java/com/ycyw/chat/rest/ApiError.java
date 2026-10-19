package com.ycyw.chat.rest;

import com.ycyw.chat.conversation.ChatError;

/** REST error body (protocol.md §2.3). */
public record ApiError(ChatError code, String reason) {
}
