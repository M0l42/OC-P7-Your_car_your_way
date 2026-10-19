package com.ycyw.chat.conversation;

/** A rejection with a wire error code. Thrown inside a transaction, it rolls it back: no row written. */
public class ChatException extends RuntimeException {

    private final ChatError code;

    public ChatException(ChatError code, String reason) {
        super(reason);
        this.code = code;
    }

    public ChatError code() {
        return code;
    }

    public String reason() {
        return getMessage();
    }
}
