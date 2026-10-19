package com.ycyw.chat.message;

import com.fasterxml.jackson.annotation.JsonValue;

/** Native enum {@code type_message}. */
public enum ItemType {
    TEXTE("texte"),
    PRISE_EN_CHARGE("prise_en_charge"),
    CLOTURE("cloture");

    private final String dbValue;

    ItemType(String dbValue) {
        this.dbValue = dbValue;
    }

    @JsonValue
    public String dbValue() {
        return dbValue;
    }

    public static ItemType fromDb(String value) {
        for (ItemType t : values()) {
            if (t.dbValue.equals(value)) {
                return t;
            }
        }
        throw new IllegalArgumentException("unknown type " + value);
    }
}
