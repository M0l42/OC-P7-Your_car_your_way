package com.ycyw.chat.conversation;

import com.fasterxml.jackson.annotation.JsonValue;

/** Native enum {@code statut_conversation}; the wire uses the database values. */
public enum ConversationStatus {
    EN_ATTENTE("en_attente"),
    EN_COURS("en_cours"),
    CLOTUREE("cloturee");

    private final String dbValue;

    ConversationStatus(String dbValue) {
        this.dbValue = dbValue;
    }

    @JsonValue
    public String dbValue() {
        return dbValue;
    }

    public static ConversationStatus fromDb(String value) {
        for (ConversationStatus s : values()) {
            if (s.dbValue.equals(value)) {
                return s;
            }
        }
        throw new IllegalArgumentException("unknown status " + value);
    }
}
