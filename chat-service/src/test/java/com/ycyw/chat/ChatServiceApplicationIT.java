package com.ycyw.chat;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.postgresql.PostgreSQLContainer;

/** Scaffold smoke test: the app boots against Postgres 17 and exposes its probes. */
@Testcontainers
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = "INSTANCE_ID=it-1")
class ChatServiceApplicationIT {

    @Container
    @ServiceConnection
    static final PostgreSQLContainer POSTGRES = new PostgreSQLContainer("postgres:17-alpine");

    @LocalServerPort
    int port;

    private final HttpClient http = HttpClient.newHttpClient();

    private HttpResponse<String> get(String path) throws Exception {
        return http.send(HttpRequest.newBuilder(URI.create("http://localhost:" + port + path)).build(),
                HttpResponse.BodyHandlers.ofString());
    }

    @Test
    void readinessIsUpOnceListenIsActive() throws Exception {
        // Readiness includes the LISTEN connection (ListenerReadiness), which starts after the web server.
        HttpResponse<String> response = get("/actuator/health/readiness");
        for (int i = 0; i < 100 && response.statusCode() != 200; i++) {
            Thread.sleep(100);
            response = get("/actuator/health/readiness");
        }
        assertThat(response.statusCode()).isEqualTo(200);
        assertThat(response.body()).contains("\"UP\"");
    }

    @Test
    void infoExposesInstanceId() throws Exception {
        assertThat(get("/actuator/info").body()).contains("it-1");
    }

    @Test
    void otherEndpointsAreNotPublic() throws Exception {
        assertThat(get("/api/conversations").statusCode()).isIn(401, 403);
    }
}
