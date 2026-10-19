package com.ycyw.chat;

import static org.assertj.core.api.Assertions.assertThat;

import com.ycyw.chat.conversation.ChatError;
import com.ycyw.chat.conversation.ChatException;
import com.ycyw.chat.conversation.Conversation;
import com.ycyw.chat.conversation.ConversationService;
import com.ycyw.chat.conversation.ConversationStatus;
import com.ycyw.chat.message.Item;
import com.ycyw.chat.message.ItemType;
import com.ycyw.chat.message.MessageWriteService;
import com.ycyw.chat.message.MessageWriteService.SendResult;
import com.ycyw.chat.message.SenderRole;
import com.ycyw.chat.security.Actor;
import com.ycyw.chat.support.Actors;
import com.ycyw.chat.support.NotificationRecorder;
import com.ycyw.chat.support.PostgresTestConfiguration;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import javax.sql.DataSource;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.simple.JdbcClient;

/**
 * Write path at service level: test 3 (idempotency), test 4b (ack/error contract incl. retry after
 * close, A2), test 4 (claim race) and the NOTIFY side effects. STOMP-level delivery of acks/errors is
 * covered by the STOMP tests.
 */
@SpringBootTest
@Import(PostgresTestConfiguration.class)
class WritePathIT {

    @Autowired
    ConversationService conversations;
    @Autowired
    MessageWriteService writer;
    @Autowired
    JdbcClient jdbc;
    @Autowired
    DataSource dataSource;

    NotificationRecorder notifications;
    Actor customer;
    Actor agent;

    @BeforeEach
    void setUp() throws Exception {
        notifications = new NotificationRecorder(dataSource);
        customer = Actors.customer();
        agent = Actors.agent();
    }

    @AfterEach
    void tearDown() throws Exception {
        notifications.close();
    }

    private Conversation open() {
        return conversations.open(customer, UUID.randomUUID(), null).conversation();
    }

    private int rows(long conversationId) {
        return jdbc.sql("SELECT count(*) FROM message WHERE conversation_id = ?").param(conversationId)
                .query(Integer.class).single();
    }

    private ChatError rejection(Runnable call) {
        try {
            call.run();
        } catch (ChatException e) {
            return e.code();
        }
        throw new AssertionError("expected a ChatException");
    }

    // ---- test 3: idempotency -----------------------------------------------------------------

    @Nested
    class Idempotency {

        @Test
        void sameClientMessageIdTwiceGivesOneRowAndOneSeq() throws Exception {
            long id = open().id();
            notifications.drain(200);
            UUID clientMessageId = UUID.randomUUID();

            SendResult first = writer.send(customer, id, clientMessageId, "Bonjour");
            SendResult retry = writer.send(customer, id, clientMessageId, "Bonjour (retry)");

            assertThat(first.seq()).isEqualTo(1);
            assertThat(first.duplicate()).isFalse();
            assertThat(retry.seq()).isEqualTo(1);
            assertThat(retry.duplicate()).isTrue();
            assertThat(rows(id)).isEqualTo(1);
            assertThat(conversations.get(customer, id).lastSeq()).as("no seq consumed by the retry").isEqualTo(1);
            assertThat(notifications.drain(500)).as("one NOTIFY for the new item, none for the retry")
                    .containsExactly("{\"t\":\"msg\",\"c\":" + id + ",\"s\":1}");
            assertThat(conversations.items(customer, id, 0, 200).items()).extracting(Item::content)
                    .containsExactly("Bonjour");
        }

        @Test
        void concurrentRetriesOfOneMessageStillGiveOneRow() throws Exception {
            long id = open().id();
            UUID clientMessageId = UUID.randomUUID();
            List<SendResult> results = race(8, () -> writer.send(customer, id, clientMessageId, "hi"));
            assertThat(results).extracting(SendResult::seq).containsOnly(1);
            assertThat(results).filteredOn(r -> !r.duplicate()).hasSize(1);
            assertThat(rows(id)).isEqualTo(1);
        }

        @Test
        void doubleOpenWithSameClientRequestIdGivesOneConversation() throws Exception {
            UUID requestId = UUID.randomUUID();
            List<ConversationService.OpenResult> results =
                    race(4, () -> conversations.open(customer, requestId, "YCYW-1"));
            assertThat(results).extracting(r -> r.conversation().id()).containsOnly(results.getFirst().conversation().id());
            assertThat(results).filteredOn(ConversationService.OpenResult::created).hasSize(1);
            assertThat(jdbc.sql("SELECT count(*) FROM conversation WHERE customer_ref = ?").param(customer.ref())
                    .query(Integer.class).single()).isEqualTo(1);
        }

        @Test
        void sameClientRequestIdFromAnotherCustomerIsAnotherConversation() {
            UUID requestId = UUID.randomUUID();
            long a = conversations.open(customer, requestId, null).conversation().id();
            long b = conversations.open(Actors.customer(), requestId, null).conversation().id();
            assertThat(a).isNotEqualTo(b);
        }

        @Test
        void openEmitsOneQueueEventAndGuestGetsTokenReservation() throws Exception {
            notifications.drain(200);
            Actor guest = Actors.guest("YCYW-2026-42");
            UUID requestId = UUID.randomUUID();
            Conversation c = conversations.open(guest, requestId, null).conversation();
            conversations.open(guest, requestId, null);
            assertThat(c.customerKind()).isEqualTo("invite");
            assertThat(c.reservationReference()).isEqualTo("YCYW-2026-42");
            assertThat(c.status()).isEqualTo(ConversationStatus.EN_ATTENTE);
            assertThat(notifications.drain(500))
                    .containsExactly("{\"t\":\"queue\",\"c\":" + c.id() + ",\"e\":\"opened\"}");
        }
    }

    // ---- test 4b: ack / error contract ---------------------------------------------------------

    @Nested
    class AckAndErrors {

        @Test
        void retryOfAMessageStoredJustBeforeCloseIsAckedWithItsSeq() {
            long id = open().id();
            UUID clientMessageId = UUID.randomUUID();
            int seq = writer.send(customer, id, clientMessageId, "stored before close").seq();
            conversations.close(customer, id);

            SendResult retry = writer.send(customer, id, clientMessageId, "stored before close");

            assertThat(retry.seq()).isEqualTo(seq);
            assertThat(retry.duplicate()).isTrue();
        }

        @Test
        void sendToAClosedConversationIsRejectedWithoutARow() throws Exception {
            long id = open().id();
            conversations.close(customer, id);
            int before = rows(id);
            notifications.drain(300);

            assertThat(rejection(() -> writer.send(customer, id, UUID.randomUUID(), "too late")))
                    .isEqualTo(ChatError.CONVERSATION_CLOSED);
            assertThat(rows(id)).isEqualTo(before);
            assertThat(notifications.drain(300)).isEmpty();
        }

        @Test
        void invalidContentIsRejectedWithoutConsumingASeq() {
            long id = open().id();
            assertThat(rejection(() -> writer.send(customer, id, UUID.randomUUID(), "   ")))
                    .isEqualTo(ChatError.INVALID_CONTENT);
            assertThat(rejection(() -> writer.send(customer, id, UUID.randomUUID(), null)))
                    .isEqualTo(ChatError.INVALID_CONTENT);
            assertThat(rejection(() -> writer.send(customer, id, UUID.randomUUID(), "x".repeat(2001))))
                    .isEqualTo(ChatError.INVALID_CONTENT);
            assertThat(writer.send(customer, id, UUID.randomUUID(), "😀".repeat(2000)).seq()).isEqualTo(1);
        }

        @Test
        void contentIsStoredExactlyAsSent() {
            long id = open().id();
            writer.send(customer, id, UUID.randomUUID(), "  padded  ");
            assertThat(conversations.items(customer, id, 0, 200).items().getFirst().content()).isEqualTo("  padded  ");
        }

        @Test
        void unknownOrForeignConversationIsNotFound() {
            long id = open().id();
            assertThat(rejection(() -> writer.send(customer, Long.MAX_VALUE, UUID.randomUUID(), "x")))
                    .isEqualTo(ChatError.NOT_FOUND);
            assertThat(rejection(() -> writer.send(Actors.customer(), id, UUID.randomUUID(), "x")))
                    .isEqualTo(ChatError.NOT_FOUND);
        }

        @Test
        void agentMustClaimBeforePosting() {
            long id = open().id();
            assertThat(rejection(() -> writer.send(agent, id, UUID.randomUUID(), "hello")))
                    .isEqualTo(ChatError.FORBIDDEN);
            conversations.claim(agent, id);
            assertThat(writer.send(agent, id, UUID.randomUUID(), "hello").seq()).isEqualTo(2);
        }

        @Test
        void reusingAnotherSendersClientMessageIdIsForbidden() {
            long id = open().id();
            conversations.claim(agent, id);
            UUID clientMessageId = UUID.randomUUID();
            writer.send(customer, id, clientMessageId, "mine");
            assertThat(rejection(() -> writer.send(agent, id, clientMessageId, "not yours")))
                    .isEqualTo(ChatError.FORBIDDEN);
        }
    }

    // ---- test 4: claim race + lifecycle events --------------------------------------------------

    @Nested
    class ClaimAndClose {

        @Test
        void concurrentClaimsHaveExactlyOneWinnerAndOnePriseEnChargeEvent() throws Exception {
            long id = open().id();
            List<Actor> agents = new ArrayList<>();
            for (int i = 0; i < 6; i++) {
                agents.add(Actors.agent());
            }
            List<Object> outcomes = race(agents.size(), index -> {
                try {
                    return conversations.claim(agents.get(index), id);
                } catch (ChatException e) {
                    return e.code();
                }
            });

            assertThat(outcomes).filteredOn(Conversation.class::isInstance).hasSize(1);
            assertThat(outcomes).filteredOn(ChatError.ALREADY_CLAIMED::equals).hasSize(agents.size() - 1);
            Conversation winner = (Conversation) outcomes.stream().filter(Conversation.class::isInstance)
                    .findFirst().orElseThrow();
            List<Item> stream = conversations.items(customer, id, 0, 200).items();
            assertThat(stream).extracting(Item::type).containsExactly(ItemType.PRISE_EN_CHARGE);
            Item event = stream.getFirst();
            assertThat(event.senderRole()).isEqualTo(SenderRole.SYSTEME);
            assertThat(event.senderRef()).isEqualTo(winner.agentRef());
            assertThat(event.content()).isNull();
            assertThat(event.clientMessageId()).isNotNull();
        }

        @Test
        void claimNotifiesItemAndQueueEventAndIsIdempotentForTheHolder() throws Exception {
            long id = open().id();
            notifications.drain(300);
            Conversation claimed = conversations.claim(agent, id);
            assertThat(claimed.status()).isEqualTo(ConversationStatus.EN_COURS);
            assertThat(claimed.agentRef()).isEqualTo(agent.ref());
            assertThat(claimed.lastSeq()).isEqualTo(1);
            assertThat(notifications.drain(500)).containsExactly(
                    "{\"t\":\"msg\",\"c\":" + id + ",\"s\":1}",
                    "{\"t\":\"queue\",\"c\":" + id + ",\"e\":\"claimed\"}");

            assertThat(conversations.claim(agent, id).lastSeq()).as("re-claim appends nothing").isEqualTo(1);
            assertThat(rejection(() -> conversations.claim(Actors.agent(), id))).isEqualTo(ChatError.ALREADY_CLAIMED);
        }

        @Test
        void closeAppendsClotureWithTheActorAsSenderRef() {
            long id = open().id();
            conversations.claim(agent, id);
            Conversation closed = conversations.close(agent, id);
            assertThat(closed.status()).isEqualTo(ConversationStatus.CLOTUREE);
            assertThat(closed.closedAt()).isNotNull();
            Item last = conversations.items(customer, id, 0, 200).items().getLast();
            assertThat(last.type()).isEqualTo(ItemType.CLOTURE);
            assertThat(last.seq()).isEqualTo(2);
            assertThat(last.senderRef()).isEqualTo(agent.ref());
            assertThat(rejection(() -> conversations.close(customer, id))).isEqualTo(ChatError.CONVERSATION_CLOSED);
            assertThat(rejection(() -> conversations.claim(Actors.agent(), id))).isEqualTo(ChatError.ALREADY_CLAIMED);
        }

        @Test
        void customerMayCloseAnUnclaimedConversation() {
            long id = open().id();
            Conversation closed = conversations.close(customer, id);
            assertThat(closed.status()).isEqualTo(ConversationStatus.CLOTUREE);
            assertThat(closed.agentRef()).isNull();
        }
    }

    // ---- helpers -----------------------------------------------------------------------------------

    private interface IndexedCall<T> {
        T call(int index) throws Exception;
    }

    private static <T> List<T> race(int n, Callable<T> call) throws Exception {
        return race(n, index -> call.call());
    }

    /** Starts n calls at the same instant (latch) and returns their results. */
    private static <T> List<T> race(int n, IndexedCall<T> call) throws Exception {
        ExecutorService pool = Executors.newFixedThreadPool(n);
        try {
            CountDownLatch start = new CountDownLatch(1);
            List<Future<T>> futures = new ArrayList<>();
            for (int i = 0; i < n; i++) {
                int index = i;
                futures.add(pool.submit(() -> {
                    start.await();
                    return call.call(index);
                }));
            }
            start.countDown();
            List<T> results = new ArrayList<>();
            for (Future<T> f : futures) {
                results.add(f.get(30, TimeUnit.SECONDS));
            }
            return results;
        } finally {
            pool.shutdownNow();
        }
    }
}
