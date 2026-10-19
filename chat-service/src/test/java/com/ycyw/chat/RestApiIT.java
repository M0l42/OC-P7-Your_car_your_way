package com.ycyw.chat;

import static org.assertj.core.api.Assertions.assertThat;

import com.ycyw.chat.message.MessageWriteService;
import com.ycyw.chat.security.Actor;
import com.ycyw.chat.support.Actors;
import com.ycyw.chat.support.ChatInstance;
import com.ycyw.chat.support.RestClient;
import com.ycyw.chat.support.RestClient.Response;
import com.ycyw.chat.support.TestTokens;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.postgresql.PostgreSQLContainer;
import tools.jackson.databind.JsonNode;

/** REST contract (protocol.md §4): auth (A5), idempotent open (A6), lists and paging (P1), claim race (test 4). */
@Testcontainers
class RestApiIT {

    @Container
    static final PostgreSQLContainer POSTGRES = new PostgreSQLContainer("postgres:17-alpine");

    static ChatInstance chat;
    static RestClient api;
    static final String TIMESTAMP = "\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z";

    @BeforeAll
    static void start() {
        chat = ChatInstance.on(POSTGRES, "rest-1").startReady();
        api = new RestClient(chat.port());
    }

    @AfterAll
    static void stop() {
        chat.close();
    }

    static String openBody() {
        return "{\"clientRequestId\":\"" + UUID.randomUUID() + "\"}";
    }

    static long openConversation(Actor customer) {
        Response r = api.post(TestTokens.token(customer), "/api/conversations", openBody());
        assertThat(r.status()).isEqualTo(201);
        return r.body().get("id").asLong();
    }

    @Nested
    class Authentication {

        @Test
        void missingInvalidAndExpiredTokens() {
            Actor customer = Actors.customer();
            Response none = api.get(null, "/api/conversations");
            assertThat(none.status()).isEqualTo(401);
            assertThat(none.code()).isEqualTo("UNAUTHORIZED");
            assertThat(none.raw().headers().firstValue("X-Instance-Id")).hasValue("rest-1");

            Response expired = api.get(TestTokens.expired(customer), "/api/conversations");
            assertThat(expired.status()).isEqualTo(401);
            assertThat(expired.code()).isEqualTo("TOKEN_EXPIRED");

            Response forged = api.get(TestTokens.foreignSignature(customer), "/api/conversations");
            assertThat(forged.status()).isEqualTo(401);
            assertThat(forged.code()).isEqualTo("UNAUTHORIZED");

            Response ok = api.get(TestTokens.token(customer), "/api/conversations");
            assertThat(ok.status()).isEqualTo(200);
            assertThat(ok.raw().headers().firstValue("X-Instance-Id")).hasValue("rest-1");
        }

        @Test
        void otherPathsAreNotExposed() {
            assertThat(api.get(TestTokens.token(Actors.agent()), "/actuator/env").status()).isIn(401, 403, 404);
        }
    }

    @Nested
    class Open {

        @Test
        void doublePostWithTheSameClientRequestIdReturnsTheSameConversation() {
            Actor customer = Actors.customer();
            String token = TestTokens.token(customer);
            String body = "{\"clientRequestId\":\"" + UUID.randomUUID() + "\",\"reservationReference\":\"YCYW-9\"}";

            Response first = api.post(token, "/api/conversations", body);
            assertThat(first.status()).isEqualTo(201);
            long id = first.body().get("id").asLong();
            assertThat(first.raw().headers().firstValue("Location")).hasValue("/api/conversations/" + id);
            JsonNode c = first.body();
            assertThat(c.get("status").asString()).isEqualTo("en_attente");
            assertThat(c.get("customerRef").asString()).isEqualTo(customer.ref());
            assertThat(c.get("customerKind").asString()).isEqualTo("compte");
            assertThat(c.get("reservationReference").asString()).isEqualTo("YCYW-9");
            assertThat(c.get("agentRef").isNull()).isTrue();
            assertThat(c.get("lastSeq").asInt()).isZero();
            assertThat(c.get("createdAt").asString()).matches(TIMESTAMP);
            assertThat(c.get("claimedAt").isNull()).isTrue();
            assertThat(c.get("closedAt").isNull()).isTrue();

            Response replay = api.post(token, "/api/conversations", body);
            assertThat(replay.status()).isEqualTo(200);
            assertThat(replay.body().get("id").asLong()).isEqualTo(id);
        }

        @Test
        void invalidOpenRequests() {
            String customer = TestTokens.token(Actors.customer());
            assertThat(api.post(customer, "/api/conversations", "{\"clientRequestId\":\"nope\"}").code())
                    .isEqualTo("INVALID_REQUEST");
            assertThat(api.post(customer, "/api/conversations", "{}").status()).isEqualTo(400);
            assertThat(api.post(customer, "/api/conversations", "not json").code()).isEqualTo("INVALID_REQUEST");
            assertThat(api.post(customer, "/api/conversations", "{\"clientRequestId\":\"" + UUID.randomUUID()
                    + "\",\"reservationReference\":\"" + "x".repeat(65) + "\"}").code()).isEqualTo("INVALID_REQUEST");
            Response agent = api.post(TestTokens.token(Actors.agent()), "/api/conversations", openBody());
            assertThat(agent.status()).isEqualTo(403);
            assertThat(agent.code()).isEqualTo("FORBIDDEN");
        }
    }

    @Nested
    class Lists {

        @Test
        void myConversationsAndTheAgentQueue() {
            Actor customer = Actors.customer();
            long mine = openConversation(customer);
            long other = openConversation(Actors.customer());

            Response list = api.get(TestTokens.token(customer), "/api/conversations");
            assertThat(list.status()).isEqualTo(200);
            assertThat(ids(list)).containsExactly(mine);
            assertThat(list.body().get("total").asLong()).isEqualTo(1);

            Actor agent = Actors.agent();
            String agentToken = TestTokens.token(agent);
            api.post(agentToken, "/api/conversations/" + other + "/claim", null);
            assertThat(ids(api.get(agentToken, "/api/conversations"))).containsExactly(other);
            assertThat(ids(api.get(agentToken, "/api/conversations?status=en_attente"))).contains(mine)
                    .doesNotContain(other);

            assertThat(api.get(TestTokens.token(customer), "/api/conversations?status=en_attente").status())
                    .isEqualTo(403);
            assertThat(api.get(agentToken, "/api/conversations?status=cloturee").code()).isEqualTo("INVALID_REQUEST");
        }

        @Test
        void queueIsCappedAtTheOldest50WithTheTotal() {
            for (int i = 0; i < 55; i++) {
                openConversation(Actors.customer());
            }
            Response queue = api.get(TestTokens.token(Actors.agent()), "/api/conversations?status=en_attente");
            List<Long> expected = chat.bean(JdbcClient.class).sql(
                    "SELECT id FROM conversation WHERE status = 'en_attente' ORDER BY created_at, id LIMIT 50")
                    .query(Long.class).list();
            long total = chat.bean(JdbcClient.class).sql("SELECT count(*) FROM conversation WHERE status = 'en_attente'")
                    .query(Long.class).single();
            assertThat(ids(queue)).hasSize(50).containsExactlyElementsOf(expected);
            assertThat(queue.body().get("total").asLong()).isEqualTo(total).isGreaterThanOrEqualTo(55);
        }
    }

    @Nested
    class Paging {

        @Test
        void fourHundredFiftyItemsArriveInThreeContiguousPages() {
            Actor customer = Actors.customer();
            long id = openConversation(customer);
            MessageWriteService writer = chat.bean(MessageWriteService.class);
            for (int i = 1; i <= 450; i++) {
                writer.send(customer, id, UUID.randomUUID(), "m" + i);
            }
            String token = TestTokens.token(customer);
            List<Integer> seqs = new ArrayList<>();
            List<Integer> pageSizes = new ArrayList<>();
            int afterSeq = 0;
            boolean hasMore = true;
            while (hasMore) {
                Response page = api.get(token, "/api/conversations/" + id + "/messages?afterSeq=" + afterSeq);
                assertThat(page.status()).isEqualTo(200);
                JsonNode items = page.body().get("items");
                pageSizes.add(items.size());
                for (JsonNode item : items) {
                    seqs.add(item.get("seq").asInt());
                }
                afterSeq = seqs.getLast();
                hasMore = page.body().get("hasMore").asBoolean();
            }
            assertThat(pageSizes).containsExactly(200, 200, 50);
            for (int i = 0; i < seqs.size(); i++) {
                assertThat(seqs.get(i)).isEqualTo(i + 1);
            }
        }

        @Test
        void limitAndInvalidParameters() {
            Actor customer = Actors.customer();
            long id = openConversation(customer);
            for (int i = 0; i < 3; i++) {
                chat.bean(MessageWriteService.class).send(customer, id, UUID.randomUUID(), "m");
            }
            String token = TestTokens.token(customer);
            Response two = api.get(token, "/api/conversations/" + id + "/messages?afterSeq=0&limit=2");
            assertThat(two.body().get("items").size()).isEqualTo(2);
            assertThat(two.body().get("hasMore").asBoolean()).isTrue();
            Response rest = api.get(token, "/api/conversations/" + id + "/messages?afterSeq=2&limit=2");
            assertThat(rest.body().get("items").size()).isEqualTo(1);
            assertThat(rest.body().get("hasMore").asBoolean()).isFalse();
            JsonNode item = rest.body().get("items").get(0);
            assertThat(item.get("createdAt").asString()).matches(TIMESTAMP);
            assertThat(item.get("type").asString()).isEqualTo("texte");

            for (String query : List.of("limit=201", "limit=0", "afterSeq=-1", "afterSeq=abc")) {
                assertThat(api.get(token, "/api/conversations/" + id + "/messages?" + query).code()).as(query)
                        .isEqualTo("INVALID_REQUEST");
            }
        }
    }

    @Nested
    class ClaimRace {

        @Test
        void concurrentClaimsOverRestHaveOneWinnerAndOnePriseEnCharge() throws Exception {
            Actor customer = Actors.customer();
            long id = openConversation(customer);
            int agents = 5;
            ExecutorService pool = Executors.newFixedThreadPool(agents);
            CountDownLatch start = new CountDownLatch(1);
            List<Future<Response>> responses = new ArrayList<>();
            for (int i = 0; i < agents; i++) {
                String token = TestTokens.token(Actors.agent());
                responses.add(pool.submit(() -> {
                    start.await();
                    return api.post(token, "/api/conversations/" + id + "/claim", null);
                }));
            }
            start.countDown();
            List<Response> results = new ArrayList<>();
            for (Future<Response> f : responses) {
                results.add(f.get(30, TimeUnit.SECONDS));
            }
            pool.shutdown();

            assertThat(results).filteredOn(r -> r.status() == 200).hasSize(1);
            assertThat(results).filteredOn(r -> r.status() == 409)
                    .hasSize(agents - 1).allMatch(r -> "ALREADY_CLAIMED".equals(r.code()));
            Response winner = results.stream().filter(r -> r.status() == 200).findFirst().orElseThrow();
            assertThat(winner.body().get("status").asString()).isEqualTo("en_cours");
            assertThat(winner.body().get("claimedAt").asString()).matches(TIMESTAMP);

            JsonNode items = api.get(TestTokens.token(customer), "/api/conversations/" + id + "/messages")
                    .body().get("items");
            assertThat(items.size()).isEqualTo(1);
            assertThat(items.get(0).get("type").asString()).isEqualTo("prise_en_charge");
            assertThat(items.get(0).get("senderRef").asString()).isEqualTo(winner.body().get("agentRef").asString());
        }
    }

    private static List<Long> ids(Response list) {
        List<Long> ids = new ArrayList<>();
        list.body().get("items").forEach(n -> ids.add(n.get("id").asLong()));
        return ids;
    }
}
