package com.ycyw.chat.events;

import com.fasterxml.jackson.annotation.JsonValue;
import java.util.Locale;

/** {@code t} of a queue event on {@code /topic/queue} (protocol.md §3.6). */
public enum QueueEventType {
    OPENED,
    CLAIMED,
    CLOSED;

    @JsonValue
    public String wire() {
        return name().toLowerCase(Locale.ROOT);
    }

    public static QueueEventType fromWire(String value) {
        return valueOf(value.toUpperCase(Locale.ROOT));
    }
}
