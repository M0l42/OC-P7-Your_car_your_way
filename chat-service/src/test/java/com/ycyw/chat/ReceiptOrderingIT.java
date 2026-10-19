package com.ycyw.chat;

import static org.assertj.core.api.Assertions.assertThat;

import com.ycyw.chat.conversation.ConversationService;
import com.ycyw.chat.message.MessageWriteService;
import com.ycyw.chat.security.Actor;
import com.ycyw.chat.support.Actors;
import com.ycyw.chat.support.ChatInstance;
import com.ycyw.chat.support.StompTestClient;
import com.ycyw.chat.support.StompTestClient.Frame;
import com.ycyw.chat.support.TestTokens;
import java.time.Duration;
import java.util.UUID;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.postgresql.PostgreSQLContainer;
import tools.jackson.databind.json.JsonMapper;

/**
 * Test 4e (A1 layer a, O7): N × (SUBSCRIBE on instance A with receipt → RECEIPT → commit through
 * instance B immediately) → the item arrives live on A. This client has no safety-net backfill, so a
 * RECEIPT sent before the broker registered the subscription would show up as a missing item.
 *
 * <p>N = {@code -Dreceipt.iterations} (default 100; 1,000 is the Could-tier run).
 */
@Testcontainers
class ReceiptOrderingIT {

    @Container
    static final PostgreSQLContainer POSTGRES = new PostgreSQLContainer("postgres:17-alpine");

    static ChatInstance a;
    static ChatInstance b;
    static final Duration WAIT = Duration.ofSeconds(5);

    @BeforeAll
    static void startInstances() {
        a = ChatInstance.on(POSTGRES, "receipt-a").startReady();
        b = ChatInstance.on(POSTGRES, "receipt-b").startReady();
    }

    @AfterAll
    static void stopInstances() {
        b.close();
        a.close();
    }

    @Test
    void everyItemCommittedRightAfterTheReceiptIsDeliveredLive() throws Exception {
        int iterations = Integer.getInteger("receipt.iterations", 100);
        JsonMapper json = JsonMapper.builder().build();
        Actor customer = Actors.customer();
        ConversationService conversations = a.bean(ConversationService.class);
        MessageWriteService writerOnB = b.bean(MessageWriteService.class);
        try (StompTestClient client = StompTestClient.connect(a.wsUrl(), TestTokens.connectHeaders(customer))) {
            for (int i = 0; i < iterations; i++) {
                long id = conversations.open(customer, UUID.randomUUID(), null).conversation().id();
                String topic = "/topic/conversations/" + id;

                client.subscribeWithReceipt(topic, WAIT);
                writerOnB.send(customer, id, UUID.randomUUID(), "right after receipt " + i);

                Frame frame = client.next(topic, WAIT);
                assertThat(frame).as("iteration %d: item committed after RECEIPT delivered live", i).isNotNull();
                assertThat(json.readTree(frame.body()).get("seq").asInt()).isEqualTo(1);
            }
        }
        System.out.println("test 4e: " + iterations + " iterations, every item delivered live");
    }

    @Test
    void userQueueSubscriptionsGetNoReceipt() {
        try (StompTestClient client = StompTestClient.connect(a.wsUrl(), TestTokens.connectHeaders(Actors.agent()))) {
            assertThat(client.subscribeAndAwaitReceipt("/user/queue/acks", Duration.ofSeconds(1))).isFalse();
            assertThat(client.subscribeAndAwaitReceipt("/topic/queue", WAIT)).isTrue();
        }
    }
}
