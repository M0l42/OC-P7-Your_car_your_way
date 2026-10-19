package com.ycyw.chat.message;

import com.fasterxml.jackson.annotation.JsonValue;
import com.ycyw.chat.security.Actor;

/** Native enum {@code role_emetteur}. */
public enum SenderRole {
    CLIENT("client"),
    AGENT("agent"),
    SYSTEME("systeme");

    private final String dbValue;

    SenderRole(String dbValue) {
        this.dbValue = dbValue;
    }

    @JsonValue
    public String dbValue() {
        return dbValue;
    }

    public static SenderRole of(Actor actor) {
        return actor.isAgent() ? AGENT : CLIENT;
    }

    public static SenderRole fromDb(String value) {
        for (SenderRole r : values()) {
            if (r.dbValue.equals(value)) {
                return r;
            }
        }
        throw new IllegalArgumentException("unknown sender role " + value);
    }
}
