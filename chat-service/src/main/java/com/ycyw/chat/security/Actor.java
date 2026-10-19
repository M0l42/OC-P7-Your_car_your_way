package com.ycyw.chat.security;

import java.util.Objects;

/**
 * The authenticated caller, built from a verified JWT only ({@code sub} + {@code role}).
 * {@code reservationReference} is the guest token's claim, {@code null} otherwise.
 */
public record Actor(String ref, Role role, String reservationReference) {

    public Actor {
        Objects.requireNonNull(ref, "ref");
        Objects.requireNonNull(role, "role");
    }

    public static Actor of(String ref, Role role) {
        return new Actor(ref, role, null);
    }

    public boolean isAgent() {
        return role == Role.AGENT;
    }

    /** Customer actors: logged-in customers and guests. */
    public boolean isCustomer() {
        return role != Role.AGENT;
    }
}
