package com.ycyw.chat;

import static org.assertj.core.api.Assertions.assertThat;

import com.ycyw.chat.conversation.ConversationService;
import com.ycyw.chat.security.Actor;
import com.ycyw.chat.support.Actors;
import com.ycyw.chat.support.ChatInstance;
import com.ycyw.chat.support.RawWebSocket;
import com.ycyw.chat.support.StompTestClient;
import com.ycyw.chat.support.StompTestClient.Frame;
import com.ycyw.chat.support.TestTokens;
import java.time.Duration;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.springframework.messaging.simp.stomp.StompHeaders;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.postgresql.PostgreSQLContainer;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * The STOMP side of protocol.md: CONNECT auth (A5), origins / size / frames before auth (A7),
 * CONNECTED instance-id (C5), SUBSCRIBE / SEND authorization (O4, §3.3) and the ack/error contract
 * over the wire (test 4b, A2), including "sending session only".
 */
@Testcontainers
class StompContractIT {

    @Container
    static final PostgreSQLContainer POSTGRES = new PostgreSQLContainer("postgres:17-alpine");

    static ChatInstance chat;
    static final Duration WAIT = Duration.ofSeconds(5);
    static final Duration QUIET = Duration.ofMillis(700);
    final JsonMapper json = JsonMapper.builder().build();

    @BeforeAll
    static void start() {
        chat = ChatInstance.on(POSTGRES, "stomp-1").startReady();
    }

    @AfterAll
    static void stop() {
        chat.close();
    }

    static StompTestClient connect(Actor actor) {
        return StompTestClient.connect(chat.wsUrl(), TestTokens.connectHeaders(actor));
    }

    static long open(Actor customer) {
        return chat.bean(ConversationService.class).open(customer, UUID.randomUUID(), null).conversation().id();
    }

    /** Connect with these CONNECT headers and return the ERROR frame (connection must then close). */
    static Frame connectError(StompHeaders headers) throws Exception {
        try (RawWebSocket ws = RawWebSocket.open(chat.wsUrl(), null)) {
            StringBuilder frame = new StringBuilder("CONNECT\naccept-version:1.2\nheart-beat:0,0\n");
            headers.toSingleValueMap().forEach((k, v) -> frame.append(k).append(':').append(v).append('\n'));
            ws.send(frame.append("\n\0").toString());
            String error = ws.nextFrame(WAIT);
            assertThat(ws.awaitClose(WAIT)).as("connection closed after ERROR").isNotNull();
            return parse(error);
        }
    }

    static Frame parse(String raw) {
        assertThat(raw).as("frame").isNotNull();
        String[] parts = raw.split("\n\n", 2);
        String[] lines = parts[0].split("\n");
        StompHeaders headers = new StompHeaders();
        headers.add("command", lines[0]);
        for (int i = 1; i < lines.length; i++) {
            int colon = lines[i].indexOf(':');
            headers.add(lines[i].substring(0, colon), lines[i].substring(colon + 1));
        }
        String body = parts.length > 1 ? parts[1].replace("\0", "") : "";
        return new Frame(headers, body);
    }

    // ---- CONNECT (A5, C5) ------------------------------------------------------------------------

    @Nested
    class Connect {

        @Test
        void connectedCarriesInstanceIdAndUserName() {
            Actor customer = Actors.customer();
            try (StompTestClient client = connect(customer)) {
                assertThat(client.connectedHeaders().getFirst("instance-id")).isEqualTo("stomp-1");
                assertThat(client.connectedHeaders().getFirst("user-name")).isEqualTo(customer.ref());
            }
        }

        @Test
        void expiredTokenGetsTokenExpired() throws Exception {
            Frame error = connectError(TestTokens.connectHeaders(TestTokens.expired(Actors.customer())));
            assertThat(error.headers().getFirst("command")).isEqualTo("ERROR");
            assertThat(error.headers().getFirst("message")).isEqualTo("TOKEN_EXPIRED");
            assertThat(error.body()).startsWith("TOKEN_EXPIRED ");
        }

        @Test
        void invalidTokensGetUnauthorized() throws Exception {
            Actor actor = Actors.customer();
            List<StompHeaders> cases = List.of(
                    new StompHeaders(),
                    TestTokens.connectHeaders("not-a-jwt"),
                    TestTokens.connectHeaders(TestTokens.foreignSignature(actor)),
                    TestTokens.connectHeaders(TestTokens.token(actor, b -> b.audience("someone-else"))),
                    TestTokens.connectHeaders(TestTokens.token(actor, b -> b.issuer("evil"))),
                    TestTokens.connectHeaders(TestTokens.token(actor, b -> b.claim("role", "admin"))));
            for (StompHeaders headers : cases) {
                assertThat(connectError(headers).headers().getFirst("message")).as(headers.toString())
                        .isEqualTo("UNAUTHORIZED");
            }
        }

        @Test
        void framesBeforeAnAuthenticatedConnectGetUnauthorized() throws Exception {
            for (String frame : List.of(
                    "SEND\ndestination:/app/conversations/1/messages\ncontent-type:application/json\n\n{}\0",
                    "SUBSCRIBE\nid:s1\ndestination:/topic/queue\nreceipt:r1\n\n\0")) {
                try (RawWebSocket ws = RawWebSocket.open(chat.wsUrl(), null)) {
                    ws.send(frame);
                    Frame error = parse(ws.nextFrame(WAIT));
                    assertThat(error.headers().getFirst("command")).isEqualTo("ERROR");
                    assertThat(error.headers().getFirst("message")).isEqualTo("UNAUTHORIZED");
                    assertThat(ws.awaitClose(WAIT)).isNotNull();
                }
            }
        }
    }

    // ---- handshake: origins, size (A7) -----------------------------------------------------------

    @Nested
    class Transport {

        @Test
        void allowedOrMissingOriginIsAcceptedForeignOriginIsRefused() {
            assertThat(RawWebSocket.handshakeStatus(chat.wsUrl(), null)).isEqualTo(101);
            assertThat(RawWebSocket.handshakeStatus(chat.wsUrl(), "http://allowed.test")).isEqualTo(101);
            assertThat(RawWebSocket.handshakeStatus(chat.wsUrl(), "http://evil.test")).isEqualTo(403);
        }

        @Test
        void framesOver16KbCloseTheSessionAndAMaxSizeMessageIsAccepted() throws Exception {
            Actor customer = Actors.customer();
            long id = open(customer);
            try (StompTestClient client = connect(customer)) {
                client.subscribe("/user/queue/acks");
                // 2,000 four-byte characters = 8,000 bytes of content: the largest valid message.
                client.send("/app/conversations/" + id + "/messages",
                        "{\"clientMessageId\":\"" + UUID.randomUUID() + "\",\"content\":\"" + "😀".repeat(2000) + "\"}");
                assertThat(client.next("/user/queue/acks", WAIT)).as("max-size message acked").isNotNull();

                client.send("/app/conversations/" + id + "/messages",
                        "{\"clientMessageId\":\"" + UUID.randomUUID() + "\",\"content\":\"" + "x".repeat(17_000) + "\"}");
                assertThat(client.awaitClosed(WAIT)).as("frame over 16 KB closes the session").isTrue();
            }
        }
    }

    // ---- SUBSCRIBE / SEND authorization (O4, §3.3) -------------------------------------------------

    @Nested
    class Authorization {

        private Frame refusedSubscribe(Actor actor, String destination) throws Exception {
            try (StompTestClient client = connect(actor)) {
                assertThat(client.subscribeAndAwaitReceipt(destination, Duration.ofSeconds(2))).isFalse();
                Frame error = client.nextError(WAIT);
                assertThat(error).as("ERROR for " + destination).isNotNull();
                assertThat(client.awaitClosed(WAIT)).isTrue();
                return error;
            }
        }

        @Test
        void foreignConversationIsNotFoundWithReceiptId() throws Exception {
            long id = open(Actors.customer());
            Frame error = refusedSubscribe(Actors.customer(), "/topic/conversations/" + id);
            assertThat(error.headers().getFirst("message")).isEqualTo("NOT_FOUND");
            assertThat(error.headers().getFirst("receipt-id")).startsWith("r-");
        }

        @Test
        void claimedByAnotherAgentIsNotFound() throws Exception {
            long id = open(Actors.customer());
            chat.bean(ConversationService.class).claim(Actors.agent(), id);
            assertThat(refusedSubscribe(Actors.agent(), "/topic/conversations/" + id).headers().getFirst("message"))
                    .isEqualTo("NOT_FOUND");
        }

        @Test
        void customerOnTheQueueTopicAndUnknownDestinationsAreForbidden() throws Exception {
            Frame queue = refusedSubscribe(Actors.customer(), "/topic/queue");
            assertThat(queue.headers().getFirst("message")).isEqualTo("FORBIDDEN");
            assertThat(queue.headers().getFirst("receipt-id")).isNotNull();
            assertThat(refusedSubscribe(Actors.agent(), "/topic/anything").headers().getFirst("message"))
                    .isEqualTo("FORBIDDEN");
        }

        @Test
        void allowedSubscriptionsGetTheirReceipt() {
            Actor customer = Actors.customer();
            long id = open(customer);
            try (StompTestClient c = connect(customer); StompTestClient a = connect(Actors.agent())) {
                c.subscribeWithReceipt("/topic/conversations/" + id, WAIT);
                a.subscribeWithReceipt("/topic/queue", WAIT);
                a.subscribeWithReceipt("/topic/conversations/" + id, WAIT); // waiting → visible to agents
            }
        }

        @Test
        void sendToATopicIsForbidden() throws Exception {
            Actor customer = Actors.customer();
            long id = open(customer);
            try (StompTestClient client = connect(customer)) {
                client.send("/topic/conversations/" + id, "{\"fake\":true}");
                assertThat(client.nextError(WAIT).headers().getFirst("message")).isEqualTo("FORBIDDEN");
                assertThat(client.awaitClosed(WAIT)).isTrue();
            }
        }
    }

    // ---- test 4b over STOMP: acks and errors -------------------------------------------------------

    @Nested
    class AcksAndErrors {

        private JsonNode next(StompTestClient client, String destination) throws Exception {
            Frame frame = client.next(destination, WAIT);
            assertThat(frame).as(destination).isNotNull();
            return json.readTree(frame.body());
        }

        private static String send(UUID clientMessageId, String content) {
            return "{\"clientMessageId\":\"" + clientMessageId + "\",\"content\":\"" + content + "\"}";
        }

        @Test
        void ackGoesToTheSendingSessionOnlyAndARetryIsAckedWithTheSameSeq() throws Exception {
            Actor customer = Actors.customer();
            long id = open(customer);
            String destination = "/app/conversations/" + id + "/messages";
            try (StompTestClient sender = connect(customer); StompTestClient otherTab = connect(customer)) {
                for (StompTestClient c : List.of(sender, otherTab)) {
                    c.subscribe("/user/queue/acks");
                    c.subscribe("/user/queue/errors");
                }
                UUID clientMessageId = UUID.randomUUID();
                sender.send(destination, send(clientMessageId, "Bonjour"));
                JsonNode ack = next(sender, "/user/queue/acks");
                assertThat(ack.get("conversationId").asLong()).isEqualTo(id);
                assertThat(ack.get("clientMessageId").asString()).isEqualTo(clientMessageId.toString());
                assertThat(ack.get("seq").asInt()).isEqualTo(1);

                sender.send(destination, send(clientMessageId, "Bonjour"));
                assertThat(next(sender, "/user/queue/acks").get("seq").asInt()).isEqualTo(1);

                assertThat(otherTab.next("/user/queue/acks", QUIET)).as("other session of the same user").isNull();
                assertThat(chat.bean(ConversationService.class).items(customer, id, 0, 200).items()).hasSize(1);
            }
        }

        @Test
        void closedConversationRejectsNewMessagesButAcksARetryOfAStoredOne() throws Exception {
            Actor customer = Actors.customer();
            long id = open(customer);
            String destination = "/app/conversations/" + id + "/messages";
            try (StompTestClient client = connect(customer)) {
                client.subscribe("/user/queue/acks");
                client.subscribe("/user/queue/errors");
                UUID stored = UUID.randomUUID();
                client.send(destination, send(stored, "just before close"));
                int seq = next(client, "/user/queue/acks").get("seq").asInt();

                chat.bean(ConversationService.class).close(customer, id);

                client.send(destination, send(stored, "just before close"));
                assertThat(next(client, "/user/queue/acks").get("seq").asInt()).as("retry after close").isEqualTo(seq);

                UUID late = UUID.randomUUID();
                client.send(destination, send(late, "too late"));
                JsonNode error = next(client, "/user/queue/errors");
                assertThat(error.get("conversationId").asLong()).isEqualTo(id);
                assertThat(error.get("clientMessageId").asString()).isEqualTo(late.toString());
                assertThat(error.get("code").asString()).isEqualTo("CONVERSATION_CLOSED");
                assertThat(error.get("reason").asString()).isNotBlank();
            }
        }

        @Test
        void invalidRequestsAndContentGetTheirCodes() throws Exception {
            Actor customer = Actors.customer();
            long id = open(customer);
            String destination = "/app/conversations/" + id + "/messages";
            try (StompTestClient client = connect(customer)) {
                client.subscribe("/user/queue/errors");
                client.send(destination, "not json");
                JsonNode notJson = next(client, "/user/queue/errors");
                assertThat(notJson.get("code").asString()).isEqualTo("INVALID_REQUEST");
                assertThat(notJson.get("clientMessageId").isNull()).isTrue();

                client.send(destination, "{\"clientMessageId\":\"nope\",\"content\":\"hi\"}");
                assertThat(next(client, "/user/queue/errors").get("code").asString()).isEqualTo("INVALID_REQUEST");

                client.send(destination, send(UUID.randomUUID(), "   "));
                assertThat(next(client, "/user/queue/errors").get("code").asString()).isEqualTo("INVALID_CONTENT");

                client.send("/app/conversations/" + open(Actors.customer()) + "/messages", send(UUID.randomUUID(), "x"));
                assertThat(next(client, "/user/queue/errors").get("code").asString()).isEqualTo("NOT_FOUND");
            }
        }

        @Test
        void agentMustClaimBeforePosting() throws Exception {
            long id = open(Actors.customer());
            Actor agent = Actors.agent();
            try (StompTestClient client = connect(agent)) {
                client.subscribe("/user/queue/acks");
                client.subscribe("/user/queue/errors");
                client.send("/app/conversations/" + id + "/messages", send(UUID.randomUUID(), "hello"));
                assertThat(next(client, "/user/queue/errors").get("code").asString()).isEqualTo("FORBIDDEN");
                chat.bean(ConversationService.class).claim(agent, id);
                client.send("/app/conversations/" + id + "/messages", send(UUID.randomUUID(), "hello"));
                assertThat(next(client, "/user/queue/acks").get("seq").asInt()).isEqualTo(2);
            }
        }
    }
}
