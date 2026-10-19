package com.ycyw.chat.conversation;

import org.springframework.http.HttpStatus;

/** Error codes of the wire contract (protocol.md §3.5, §4). */
public enum ChatError {
    INVALID_REQUEST(HttpStatus.BAD_REQUEST),
    INVALID_CONTENT(HttpStatus.BAD_REQUEST),
    UNAUTHORIZED(HttpStatus.UNAUTHORIZED),
    TOKEN_EXPIRED(HttpStatus.UNAUTHORIZED),
    FORBIDDEN(HttpStatus.FORBIDDEN),
    NOT_FOUND(HttpStatus.NOT_FOUND),
    ALREADY_CLAIMED(HttpStatus.CONFLICT),
    CONVERSATION_CLOSED(HttpStatus.CONFLICT);

    private final HttpStatus httpStatus;

    ChatError(HttpStatus httpStatus) {
        this.httpStatus = httpStatus;
    }

    public HttpStatus httpStatus() {
        return httpStatus;
    }
}
