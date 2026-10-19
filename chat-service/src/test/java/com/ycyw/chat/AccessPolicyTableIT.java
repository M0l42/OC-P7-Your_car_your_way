package com.ycyw.chat;

import static org.assertj.core.api.Assertions.assertThat;

import com.ycyw.chat.conversation.ConversationService;
import com.ycyw.chat.security.Actor;
import com.ycyw.chat.support.Actors;
import com.ycyw.chat.support.ChatInstance;
import com.ycyw.chat.support.RestClient;
import com.ycyw.chat.support.RestClient.Response;
import com.ycyw.chat.support.TestTokens;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.stream.Stream;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.postgresql.PostgreSQLContainer;

/**
 * O4 + A4: actor × state × endpoint over REST, exactly protocol.md §5. Each row gets a fresh
 * conversation in the given state. SEND rows are in StompContractIT / WritePathIT; list rows in RestApiIT.
 */
@Testcontainers
class AccessPolicyTableIT {

    @Container
    static final PostgreSQLContainer POSTGRES = new PostgreSQLContainer("postgres:17-alpine");

    static ChatInstance chat;
    static RestClient api;

    enum Who { OWNER, OTHER_CUSTOMER, AGENT, CLAIMER }

    enum State { EN_ATTENTE, EN_COURS, CLOTUREE }

    enum Endpoint {
        GET("GET", ""), MESSAGES("GET", "/messages"), CLAIM("POST", "/claim"), CLOSE("POST", "/close");

        final String method;
        final String suffix;

        Endpoint(String method, String suffix) {
            this.method = method;
            this.suffix = suffix;
        }
    }

    @BeforeAll
    static void start() {
        chat = ChatInstance.on(POSTGRES, "policy-1").startReady();
        api = new RestClient(chat.port());
    }

    @AfterAll
    static void stop() {
        chat.close();
    }

    /** endpoint, actor, state, expected HTTP status, expected code (null for 200). */
    static Stream<Arguments> table() {
        List<Arguments> rows = new ArrayList<>();
        // read: GET /{id} and GET /{id}/messages share their rules
        for (Endpoint read : List.of(Endpoint.GET, Endpoint.MESSAGES)) {
            rows.add(row(read, Who.OWNER, State.EN_ATTENTE, 200));
            rows.add(row(read, Who.OWNER, State.EN_COURS, 200));
            rows.add(row(read, Who.OWNER, State.CLOTUREE, 200));
            rows.add(row(read, Who.OTHER_CUSTOMER, State.EN_ATTENTE, 404));
            rows.add(row(read, Who.OTHER_CUSTOMER, State.EN_COURS, 404));
            rows.add(row(read, Who.AGENT, State.EN_ATTENTE, 200));
            rows.add(row(read, Who.AGENT, State.EN_COURS, 404));
            rows.add(row(read, Who.AGENT, State.CLOTUREE, 404));
            rows.add(row(read, Who.CLAIMER, State.EN_COURS, 200));
            rows.add(row(read, Who.CLAIMER, State.CLOTUREE, 200));
        }
        rows.add(row(Endpoint.CLAIM, Who.OWNER, State.EN_ATTENTE, 403));
        rows.add(row(Endpoint.CLAIM, Who.OWNER, State.EN_COURS, 403));
        rows.add(row(Endpoint.CLAIM, Who.OTHER_CUSTOMER, State.EN_ATTENTE, 404));
        rows.add(row(Endpoint.CLAIM, Who.AGENT, State.EN_ATTENTE, 200));
        rows.add(row(Endpoint.CLAIM, Who.AGENT, State.EN_COURS, 409));
        rows.add(row(Endpoint.CLAIM, Who.AGENT, State.CLOTUREE, 409));
        rows.add(row(Endpoint.CLAIM, Who.CLAIMER, State.EN_COURS, 200));
        rows.add(row(Endpoint.CLAIM, Who.CLAIMER, State.CLOTUREE, 409));

        rows.add(row(Endpoint.CLOSE, Who.OWNER, State.EN_ATTENTE, 200));
        rows.add(row(Endpoint.CLOSE, Who.OWNER, State.EN_COURS, 200));
        rows.add(row(Endpoint.CLOSE, Who.OWNER, State.CLOTUREE, 409));
        rows.add(row(Endpoint.CLOSE, Who.OTHER_CUSTOMER, State.EN_ATTENTE, 404));
        rows.add(row(Endpoint.CLOSE, Who.OTHER_CUSTOMER, State.EN_COURS, 404));
        rows.add(row(Endpoint.CLOSE, Who.AGENT, State.EN_ATTENTE, 403));
        rows.add(row(Endpoint.CLOSE, Who.AGENT, State.EN_COURS, 404));
        rows.add(row(Endpoint.CLOSE, Who.CLAIMER, State.EN_COURS, 200));
        rows.add(row(Endpoint.CLOSE, Who.CLAIMER, State.CLOTUREE, 409));
        return rows.stream();
    }

    static Arguments row(Endpoint endpoint, Who who, State state, int status) {
        String code = switch (status) {
            case 200 -> null;
            case 403 -> "FORBIDDEN";
            case 404 -> "NOT_FOUND";
            case 409 -> endpoint == Endpoint.CLAIM ? "ALREADY_CLAIMED" : "CONVERSATION_CLOSED";
            default -> throw new IllegalArgumentException();
        };
        return Arguments.of(endpoint, who, state, status, code);
    }

    @ParameterizedTest(name = "{0} by {1} on {2} → {3}")
    @MethodSource("table")
    void accessRule(Endpoint endpoint, Who who, State state, int status, String code) {
        ConversationService service = chat.bean(ConversationService.class);
        Actor owner = Actors.customer();
        Actor claimer = Actors.agent();
        long id = service.open(owner, UUID.randomUUID(), null).conversation().id();
        if (state != State.EN_ATTENTE) {
            service.claim(claimer, id);
        }
        if (state == State.CLOTUREE) {
            service.close(claimer, id);
        }
        Actor actor = switch (who) {
            case OWNER -> owner;
            case OTHER_CUSTOMER -> Actors.customer();
            case AGENT -> Actors.agent();
            case CLAIMER -> claimer;
        };

        Response response = api.send(TestTokens.token(actor), endpoint.method,
                "/api/conversations/" + id + endpoint.suffix, null);

        assertThat(response.status()).isEqualTo(status);
        assertThat(response.code()).isEqualTo(code);
    }
}
