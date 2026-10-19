package com.ycyw.chat;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.ycyw.chat.support.PostgresTestConfiguration;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.simple.JdbcClient;

/** Schema-level invariants of the data model deliverable (C3, A4, A6), straight SQL on the migrated schema. */
@SpringBootTest
@Import(PostgresTestConfiguration.class)
class SchemaConstraintsIT {

    @Autowired
    JdbcClient jdbc;

    private long conversation(String status, String agentRef) {
        return jdbc.sql("""
                INSERT INTO conversation (customer_ref, customer_kind, client_request_id, status, agent_ref)
                VALUES ('c', 'compte', ?, ?::statut_conversation, ?) RETURNING id""")
                .params(UUID.randomUUID(), status, agentRef).query(Long.class).single();
    }

    private void message(long conversationId, int seq, String type, String role, String content) {
        jdbc.sql("""
                INSERT INTO message (conversation_id, seq, client_message_id, type, sender_role, sender_ref, content)
                VALUES (?, ?, ?, ?::type_message, ?::role_emetteur, 'x', ?)""")
                .params(conversationId, seq, UUID.randomUUID(), type, role, content).update();
    }

    @Test
    void systemEventWithContentIsRejected() {
        long id = conversation("en_cours", "agent-1");
        assertThatThrownBy(() -> message(id, 1, "prise_en_charge", "systeme", "hello"))
                .isInstanceOf(DataIntegrityViolationException.class)
                .hasMessageContaining("message_system_content_ck");
    }

    @Test
    void systemEventMustBeSentBySysteme() {
        long id = conversation("en_cours", "agent-1");
        assertThatThrownBy(() -> message(id, 1, "cloture", "agent", null))
                .hasMessageContaining("message_system_sender_ck");
        message(id, 1, "cloture", "systeme", null);
    }

    @Test
    void texteContentMustBe1To2000CharactersAndNotFromSysteme() {
        long id = conversation("en_attente", null);
        assertThatThrownBy(() -> message(id, 1, "texte", "client", null))
                .hasMessageContaining("message_texte_content_ck");
        assertThatThrownBy(() -> message(id, 1, "texte", "client", ""))
                .hasMessageContaining("message_texte_content_ck");
        assertThatThrownBy(() -> message(id, 1, "texte", "client", "a".repeat(2001)))
                .hasMessageContaining("message_texte_content_ck");
        assertThatThrownBy(() -> message(id, 1, "texte", "systeme", "hi"))
                .hasMessageContaining("message_texte_sender_ck");
        // 2000 code points, 4000 UTF-16 units: char_length counts characters.
        message(id, 1, "texte", "client", "😀".repeat(2000));
    }

    @Test
    void enCoursRequiresAnAgentButAClosedUnclaimedConversationIsAllowed() {
        assertThatThrownBy(() -> conversation("en_cours", null))
                .hasMessageContaining("conversation_agent_ck");
        assertThat(conversation("cloturee", null)).isPositive();
    }

    @Test
    void clientRequestIdIsUniquePerCustomer() {
        UUID requestId = UUID.randomUUID();
        String insert = "INSERT INTO conversation (customer_ref, customer_kind, client_request_id) VALUES (?, 'compte', ?)";
        jdbc.sql(insert).params("cust-a", requestId).update();
        jdbc.sql(insert).params("cust-b", requestId).update();
        assertThatThrownBy(() -> jdbc.sql(insert).params("cust-a", requestId).update())
                .hasMessageContaining("conversation_client_request_uk");
    }

    @Test
    void clientMessageIdIsUniquePerConversation() {
        long id = conversation("en_attente", null);
        UUID clientMessageId = UUID.randomUUID();
        String insert = """
                INSERT INTO message (conversation_id, seq, client_message_id, type, sender_role, sender_ref, content)
                VALUES (?, ?, ?, 'texte', 'client', 'c', 'hi')""";
        jdbc.sql(insert).params(id, 1, clientMessageId).update();
        assertThatThrownBy(() -> jdbc.sql(insert).params(id, 2, clientMessageId).update())
                .hasMessageContaining("message_client_message_uk");
    }
}
