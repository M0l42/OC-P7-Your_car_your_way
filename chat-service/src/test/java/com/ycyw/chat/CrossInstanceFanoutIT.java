package com.ycyw.chat;

import static org.assertj.core.api.Assertions.assertThat;

import com.ycyw.chat.conversation.Conversation;
import com.ycyw.chat.conversation.ConversationService;
import com.ycyw.chat.message.MessageWriteService;
import com.ycyw.chat.security.Actor;
import com.ycyw.chat.support.Actors;
import com.ycyw.chat.support.ChatInstance;
import com.ycyw.chat.support.StompTestClient;
import com.ycyw.chat.support.StompTestClient.Frame;
import java.time.Duration;
import java.util.UUID;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.messaging.simp.stomp.StompHeaders;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.postgresql.PostgreSQLContainer;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * Test 2: two chat-service instances on one Postgres. A client subscribed on instance A receives
 * what is committed through instance B (and vice versa), via LISTEN/NOTIFY → local simple broker.
 */
@Testcontainers
class CrossInstanceFanoutIT {

    @Container
    static final PostgreSQLContainer POSTGRES = new PostgreSQLContainer("postgres:17-alpine");

    static ChatInstance a;
    static ChatInstance b;

    static final Duration WAIT = Duration.ofSeconds(5);
    static final String TIMESTAMP = "\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z";
    final JsonMapper json = JsonMapper.builder().build();

    @BeforeAll
    static void startInstances() {
        a = ChatInstance.on(POSTGRES, "chat-a").startReady();
        b = ChatInstance.on(POSTGRES, "chat-b").startReady();
    }

    @AfterAll
    static void stopInstances() {
        b.close();
        a.close();
    }

    private static StompTestClient client(ChatInstance instance) {
        return StompTestClient.connect(instance.wsUrl(), new StompHeaders());
    }

    private JsonNode body(Frame frame) {
        assertThat(frame).as("frame received").isNotNull();
        return json.readTree(frame.body());
    }

    @Test
    void itemsCommittedOnOneInstanceReachSubscribersOfTheOther() throws Exception {
        Actor customer = Actors.customer();
        Actor agent = Actors.agent();
        try (StompTestClient onA = client(a); StompTestClient onB = client(b)) {
            onB.subscribeWithReceipt("/topic/queue", WAIT);

            // Customer opens through A: the agent's queue on B hears about it.
            Conversation c = a.bean(ConversationService.class).open(customer, UUID.randomUUID(), "YCYW-7").conversation();
            String topic = "/topic/conversations/" + c.id();
            JsonNode opened = body(nextQueueEventFor(onB, c.id()));
            assertThat(opened.get("t").asString()).isEqualTo("opened");
            assertThat(opened.get("conversation").get("status").asString()).isEqualTo("en_attente");
            assertThat(opened.get("conversation").get("reservationReference").asString()).isEqualTo("YCYW-7");
            assertThat(opened.get("conversation").get("createdAt").asString()).matches(TIMESTAMP);

            onA.subscribeWithReceipt(topic, WAIT);
            onB.subscribeWithReceipt(topic, WAIT);

            // Agent claims through B: the customer on A gets the prise_en_charge item.
            b.bean(ConversationService.class).claim(agent, c.id());
            JsonNode claim = body(onA.next(topic, WAIT));
            assertThat(claim.get("seq").asInt()).isEqualTo(1);
            assertThat(claim.get("type").asString()).isEqualTo("prise_en_charge");
            assertThat(claim.get("senderRole").asString()).isEqualTo("systeme");
            assertThat(claim.get("senderRef").asString()).isEqualTo(agent.ref());
            assertThat(claim.get("content").isNull()).isTrue();

            // Agent writes through B → customer on A; customer writes through A → agent on B.
            UUID fromAgent = UUID.randomUUID();
            b.bean(MessageWriteService.class).send(agent, c.id(), fromAgent, "Bonjour, je regarde.");
            JsonNode item = body(onA.next(topic, WAIT));
            assertThat(item.get("conversationId").asLong()).isEqualTo(c.id());
            assertThat(item.get("seq").asInt()).isEqualTo(2);
            assertThat(item.get("clientMessageId").asString()).isEqualTo(fromAgent.toString());
            assertThat(item.get("type").asString()).isEqualTo("texte");
            assertThat(item.get("senderRole").asString()).isEqualTo("agent");
            assertThat(item.get("content").asString()).isEqualTo("Bonjour, je regarde.");
            assertThat(item.get("createdAt").asString()).matches(TIMESTAMP);

            a.bean(MessageWriteService.class).send(customer, c.id(), UUID.randomUUID(), "Merci !");
            assertThat(body(onB.next(topic, WAIT)).get("seq").asInt()).isEqualTo(1);
            assertThat(body(onB.next(topic, WAIT)).get("seq").asInt()).isEqualTo(2);
            JsonNode reply = body(onB.next(topic, WAIT));
            assertThat(reply.get("seq").asInt()).isEqualTo(3);
            assertThat(reply.get("senderRole").asString()).isEqualTo("client");
            assertThat(reply.get("content").asString()).isEqualTo("Merci !");
        }
    }

    @Test
    void aBurstFromOneInstanceArrivesInSeqOrderOnTheOther() throws Exception {
        Actor customer = Actors.customer();
        Conversation c = a.bean(ConversationService.class).open(customer, UUID.randomUUID(), null).conversation();
        String topic = "/topic/conversations/" + c.id();
        try (StompTestClient onA = client(a)) {
            onA.subscribeWithReceipt(topic, WAIT);
            MessageWriteService writerOnB = b.bean(MessageWriteService.class);
            for (int i = 1; i <= 100; i++) {
                writerOnB.send(customer, c.id(), UUID.randomUUID(), "m" + i);
            }
            for (int seq = 1; seq <= 100; seq++) {
                JsonNode item = body(onA.next(topic, WAIT));
                assertThat(item.get("seq").asInt()).isEqualTo(seq);
                assertThat(item.get("content").asString()).isEqualTo("m" + seq);
            }
        }
    }

    private static Frame nextQueueEventFor(StompTestClient client, long conversationId) throws Exception {
        JsonMapper mapper = JsonMapper.builder().build();
        while (true) {
            Frame frame = client.next("/topic/queue", WAIT);
            if (frame == null || mapper.readTree(frame.body()).get("conversationId").asLong() == conversationId) {
                return frame;
            }
        }
    }
}
