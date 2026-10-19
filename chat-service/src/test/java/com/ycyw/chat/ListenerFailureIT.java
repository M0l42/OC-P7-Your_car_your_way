package com.ycyw.chat;

import static com.ycyw.chat.support.ChatInstance.await;
import static org.assertj.core.api.Assertions.assertThat;

import com.ycyw.chat.conversation.ConversationService;
import com.ycyw.chat.fanout.WebSocketSessionRegistry;
import com.ycyw.chat.message.Item;
import com.ycyw.chat.message.MessageRepository;
import com.ycyw.chat.message.MessageWriteService;
import com.ycyw.chat.security.Actor;
import com.ycyw.chat.support.Actors;
import com.ycyw.chat.support.ChatInstance;
import com.ycyw.chat.support.StompTestClient;
import com.ycyw.chat.support.Toxiproxy;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.Statement;
import java.time.Duration;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.messaging.simp.stomp.StompHeaders;
import org.testcontainers.containers.Network;
import org.testcontainers.postgresql.PostgreSQLContainer;
import org.testcontainers.toxiproxy.ToxiproxyContainer;
import tools.jackson.databind.json.JsonMapper;

/**
 * Test 4c (readiness gate, killed and half-open LISTEN connection, A3/F9) and the O1 load-failure
 * path. Each case runs its own instance whose listener goes through Toxiproxy (F9: only the
 * listener, the pool talks to Postgres directly).
 *
 * <p>Half-open detection bound = liveness interval (5 s) + one poll (1 s) + socketTimeout (10 s) = 16 s.
 */
class ListenerFailureIT {

    static final Network NETWORK = Network.newNetwork();
    static final PostgreSQLContainer POSTGRES = new PostgreSQLContainer("postgres:17-alpine")
            .withNetwork(NETWORK).withNetworkAliases("postgres");
    static final ToxiproxyContainer TOXIPROXY = new ToxiproxyContainer("ghcr.io/shopify/toxiproxy:2.12.0")
            .withNetwork(NETWORK);
    static Toxiproxy proxy;

    static final Duration WAIT = Duration.ofSeconds(5);
    final JsonMapper json = JsonMapper.builder().build();

    @BeforeAll
    static void start() {
        POSTGRES.start();
        TOXIPROXY.start();
        proxy = Toxiproxy.create(TOXIPROXY, "listener", "postgres:5432");
    }

    @AfterAll
    static void stop() {
        TOXIPROXY.stop();
        POSTGRES.stop();
        NETWORK.close();
    }

    static ChatInstance.Builder viaProxy(String id) {
        return ChatInstance.on(POSTGRES, id).property("chat.listener.jdbc-url",
                "jdbc:postgresql://" + proxy.host() + ":" + proxy.port() + "/" + POSTGRES.getDatabaseName());
    }

    static StompTestClient subscribed(ChatInstance instance, long conversationId) {
        StompTestClient client = StompTestClient.connect(instance.wsUrl(), new StompHeaders());
        client.subscribeWithReceipt("/topic/conversations/" + conversationId, WAIT);
        return client;
    }

    static long openConversation(ChatInstance instance, Actor customer) {
        return instance.bean(ConversationService.class).open(customer, UUID.randomUUID(), null).conversation().id();
    }

    static void sql(String statement) throws Exception {
        try (Connection c = DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()); Statement s = c.createStatement()) {
            s.execute(statement);
        }
    }

    @Nested
    class Readiness {

        @Test
        void handshakeIsRefusedWith503UntilListenIsActive() {
            proxy.setEnabled(false);
            try (ChatInstance instance = viaProxy("gate").start()) {
                assertThat(instance.readinessStatus()).isEqualTo(503);
                assertThat(instance.handshakeStatus()).isEqualTo(503);

                proxy.setEnabled(true);
                instance.awaitReadiness(200, Duration.ofSeconds(15));
                assertThat(instance.handshakeStatus()).isEqualTo(101);
            } finally {
                proxy.setEnabled(true);
            }
        }

        @Test
        void killingTheListenerConnectionClosesSessionsAndReadinessGoesDownThenUp() throws Exception {
            try (ChatInstance instance = viaProxy("killed").property("chat.listener.backoff-min", "2s").startReady()) {
                Actor customer = Actors.customer();
                long id = openConversation(instance, customer);
                StompTestClient client = subscribed(instance, id);

                sql("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'chat-listener-killed'");

                assertThat(client.awaitClosed(WAIT)).as("session closed by the server").isTrue();
                instance.awaitReadiness(503, WAIT);
                assertThat(instance.bean(WebSocketSessionRegistry.class).size()).isZero();
                instance.awaitReadiness(200, Duration.ofSeconds(15));

                // Listener is back: a new subscriber receives live items again.
                try (StompTestClient again = subscribed(instance, id)) {
                    instance.bean(MessageWriteService.class).send(customer, id, UUID.randomUUID(), "after restart");
                    assertThat(again.next("/topic/conversations/" + id, WAIT)).isNotNull();
                }
            }
        }

        @Test
        void halfOpenListenerConnectionIsDetectedWithin16Seconds() throws Exception {
            try (ChatInstance instance = viaProxy("halfopen").startReady()) {
                long id = openConversation(instance, Actors.customer());
                StompTestClient client = subscribed(instance, id);

                long start = System.nanoTime();
                proxy.blackhole();
                try {
                    await(() -> !client.isConnected(), Duration.ofSeconds(16), "session closed after half-open");
                    Duration detected = Duration.ofNanos(System.nanoTime() - start);
                    assertThat(instance.readinessStatus()).isEqualTo(503);
                    assertThat(instance.handshakeStatus()).isEqualTo(503);
                    assertThat(detected).isLessThanOrEqualTo(Duration.ofSeconds(16));
                } finally {
                    proxy.heal();
                }
                instance.awaitReadiness(200, Duration.ofSeconds(30));
            }
        }
    }

    // ---- O1: load/publish failure after a NOTIFY ---------------------------------------------------

    /** Test-only: a message repository whose next findBySeq (the listener's load) fails once. */
    static class FailingLoads extends MessageRepository {
        final AtomicBoolean failNext = new AtomicBoolean();

        FailingLoads(JdbcClient jdbc) {
            super(jdbc);
        }

        /** A method, not the field: the bean is a CGLIB proxy (@Repository exception translation). */
        public void failNextLoad() {
            failNext.set(true);
        }

        @Override
        public Optional<Item> findBySeq(long conversationId, int seq) {
            if (failNext.getAndSet(false)) {
                throw new DataAccessResourceFailureException("injected load failure");
            }
            return super.findBySeq(conversationId, seq);
        }
    }

    @TestConfiguration(proxyBeanMethods = false)
    static class FailingLoadsConfiguration {
        @Bean
        @Primary
        FailingLoads failingLoads(JdbcClient jdbc) {
            return new FailingLoads(jdbc);
        }
    }

    @Nested
    class LoadFailure {

        @Test
        void loadFailureClosesSessionsAndTheClientRecoversTheMessageByBackfill() throws Exception {
            try (ChatInstance instance = viaProxy("o1").with(FailingLoadsConfiguration.class).startReady()) {
                Actor customer = Actors.customer();
                long id = openConversation(instance, customer);
                String topic = "/topic/conversations/" + id;
                StompTestClient client = subscribed(instance, id);

                instance.bean(FailingLoads.class).failNextLoad();
                instance.bean(MessageWriteService.class).send(customer, id, UUID.randomUUID(), "lost on the wire");

                assertThat(client.awaitClosed(WAIT)).as("fail-fast: session closed, not silently skipped").isTrue();
                assertThat(client.pending(topic)).isEmpty();
                instance.awaitReadiness(200, Duration.ofSeconds(15));

                // Client recovery path: reconnect, re-subscribe with receipt, backfill afterSeq=lastSeq (0).
                try (StompTestClient again = subscribed(instance, id)) {
                    assertThat(instance.bean(ConversationService.class).items(customer, id, 0, 200).items())
                            .extracting(Item::content).containsExactly("lost on the wire");
                    instance.bean(MessageWriteService.class).send(customer, id, UUID.randomUUID(), "live again");
                    assertThat(json.readTree(again.next(topic, WAIT).body()).get("seq").asInt()).isEqualTo(2);
                }
            }
        }

        @Test
        void notificationForAMissingRowIsALoadFailureToo() throws Exception {
            try (ChatInstance instance = viaProxy("o1-missing").startReady()) {
                long id = openConversation(instance, Actors.customer());
                StompTestClient client = subscribed(instance, id);
                sql("SELECT pg_notify('chat_events', '{\"t\":\"msg\",\"c\":" + id + ",\"s\":999}')");
                assertThat(client.awaitClosed(WAIT)).isTrue();
                instance.awaitReadiness(200, Duration.ofSeconds(15));
            }
        }
    }
}
