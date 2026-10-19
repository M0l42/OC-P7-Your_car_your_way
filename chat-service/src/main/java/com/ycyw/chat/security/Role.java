package com.ycyw.chat.security;

import java.util.Locale;

/** Value of the JWT {@code role} claim (protocol.md §1). */
public enum Role {
    CUSTOMER,
    GUEST,
    AGENT;

    public static Role fromClaim(String claim) {
        if (claim == null) {
            throw new IllegalArgumentException("missing role claim");
        }
        return valueOf(claim.toUpperCase(Locale.ROOT));
    }

    public String claim() {
        return name().toLowerCase(Locale.ROOT);
    }
}
