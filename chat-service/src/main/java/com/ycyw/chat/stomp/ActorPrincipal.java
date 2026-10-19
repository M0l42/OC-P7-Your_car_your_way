package com.ycyw.chat.stomp;

import com.ycyw.chat.security.Actor;
import java.security.Principal;

/** The STOMP session user, set at CONNECT; its name (JWT {@code sub}) resolves {@code /user/...} destinations. */
public record ActorPrincipal(Actor actor) implements Principal {

    @Override
    public String getName() {
        return actor.ref();
    }

    public static Actor actorOf(Principal principal) {
        return principal instanceof ActorPrincipal p ? p.actor() : null;
    }
}
