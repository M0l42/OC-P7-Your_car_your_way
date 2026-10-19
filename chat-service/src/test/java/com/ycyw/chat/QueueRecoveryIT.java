package com.ycyw.chat;

import static org.assertj.core.api.Assertions.assertThat;

import com.ycyw.chat.security.Actor;
import com.ycyw.chat.support.Actors;
import com.ycyw.chat.support.ChatInstance;
import com.ycyw.chat.support.RestClient;
import com.ycyw.chat.support.RestClient.Response;
import com.ycyw.chat.support.StompTestClient;
import com.ycyw.chat.support.TestTokens;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.postgresql.PostgreSQLContainer;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * Test 4d: an agent disconnected while one conversation is opened and another claimed recovers the
 * exact queue after reconnecting (SUBSCRIBE /topic/queue with receipt → GET queue → replace), with
 * the conversations created through instance B while the agent's sessions are on instance A.
 */
@Testcontainers
class QueueRecoveryIT {

    @Container
    static final PostgreSQLContainer POSTGRES = new PostgreSQLContainer("postgres:17-alpine");

    static ChatInstance a;
    static ChatInstance b;
    static final Duration WAIT = Duration.ofSeconds(5);
    final JsonMapper json = JsonMapper.builder().build();

    @BeforeAll
    static void start() {
        a = ChatInstance.on(POSTGRES, "queue-a").startReady();
        b = ChatInstance.on(POSTGRES, "queue-b").startReady();
    }

    @AfterAll
    static void stop() {
        b.close();
        a.close();
    }

    static long open(RestClient api) {
        Response r = api.post(TestTokens.token(Actors.customer()), "/api/conversations",
                "{\"clientRequestId\":\"" + UUID.randomUUID() + "\"}");
        assertThat(r.status()).isEqualTo(201);
        return r.body().get("id").asLong();
    }

    @Test
    void queueAfterReconnectEqualsTheDatabase() throws Exception {
        RestClient apiA = new RestClient(a.port());
        RestClient apiB = new RestClient(b.port());
        Actor agent = Actors.agent();
        String token = TestTokens.token(agent);
        long alreadyWaiting = open(apiB);

        StompTestClient first = StompTestClient.connect(a.wsUrl(), TestTokens.connectHeaders(token));
        first.subscribeWithReceipt("/topic/queue", WAIT);
        assertThat(ids(apiA.get(token, "/api/conversations?status=en_attente"))).contains(alreadyWaiting);
        first.close();

        // While the agent is away: one conversation opened, the waiting one claimed by a colleague.
        long openedMeanwhile = open(apiB);
        assertThat(apiB.post(TestTokens.token(Actors.agent()), "/api/conversations/" + alreadyWaiting + "/claim", null)
                .status()).isEqualTo(200);

        try (StompTestClient again = StompTestClient.connect(a.wsUrl(), TestTokens.connectHeaders(token))) {
            again.subscribeWithReceipt("/topic/queue", WAIT);
            Response queue = apiA.get(token, "/api/conversations?status=en_attente");
            List<Long> db = a.bean(JdbcClient.class).sql(
                    "SELECT id FROM conversation WHERE status = 'en_attente' ORDER BY created_at, id LIMIT 50")
                    .query(Long.class).list();
            assertThat(ids(queue)).containsExactlyElementsOf(db).contains(openedMeanwhile).doesNotContain(alreadyWaiting);
            assertThat(queue.body().get("total").asLong()).isEqualTo(db.size());

            // Live again: opened then claimed elsewhere, each event carrying the conversation as read.
            long live = open(apiB);
            JsonNode opened = nextEventFor(again, live);
            assertThat(opened.get("t").asString()).isEqualTo("opened");
            assertThat(opened.get("conversation").get("status").asString()).isEqualTo("en_attente");
            apiB.post(TestTokens.token(Actors.agent()), "/api/conversations/" + live + "/claim", null);
            JsonNode claimed = nextEventFor(again, live);
            assertThat(claimed.get("t").asString()).isEqualTo("claimed");
            assertThat(claimed.get("conversation").get("status").asString()).isEqualTo("en_cours");
        }
    }

    private JsonNode nextEventFor(StompTestClient client, long conversationId) throws Exception {
        while (true) {
            StompTestClient.Frame frame = client.next("/topic/queue", WAIT);
            assertThat(frame).as("queue event for " + conversationId).isNotNull();
            JsonNode event = json.readTree(frame.body());
            if (event.get("conversationId").asLong() == conversationId) {
                return event;
            }
        }
    }

    private static List<Long> ids(Response list) {
        List<Long> ids = new ArrayList<>();
        list.body().get("items").forEach(n -> ids.add(n.get("id").asLong()));
        return ids;
    }
}
