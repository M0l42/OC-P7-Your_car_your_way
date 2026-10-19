package com.ycyw.chat.support;

import com.ycyw.chat.security.Actor;
import com.ycyw.chat.security.Role;
import java.util.UUID;

/** Unique actors per test so tests sharing one database never see each other's rows. */
public final class Actors {

    private Actors() {
    }

    public static Actor customer() {
        return Actor.of("customer-" + UUID.randomUUID(), Role.CUSTOMER);
    }

    public static Actor guest(String reservationReference) {
        return new Actor("guest-" + UUID.randomUUID(), Role.GUEST, reservationReference);
    }

    public static Actor agent() {
        return Actor.of("agent-" + UUID.randomUUID(), Role.AGENT);
    }
}
