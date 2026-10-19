package com.ycyw.authstub;

import static org.assertj.core.api.Assertions.assertThat;

import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.crypto.RSASSAVerifier;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.interfaces.RSAPublicKey;
import java.security.spec.X509EncodedKeySpec;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * POST /dev/tokens with a key file laid out like compose's jwt-keys volume (PKCS#8 private key for
 * auth-stub, X.509 SPKI public key for chat-service): every token verifies with the public PEM alone.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class TokenControllerTests {

    @TempDir
    static Path keys;

    static Path publicPem;

    @DynamicPropertySource
    static void keyFiles(DynamicPropertyRegistry registry) throws Exception {
        KeyPairGenerator generator = KeyPairGenerator.getInstance("RSA");
        generator.initialize(2048);
        KeyPair pair = generator.generateKeyPair();
        Path privatePem = keys.resolve("private.pem");
        publicPem = keys.resolve("public.pem");
        Files.writeString(privatePem, pem("PRIVATE KEY", pair.getPrivate().getEncoded()));
        Files.writeString(publicPem, pem("PUBLIC KEY", pair.getPublic().getEncoded()));
        registry.add("auth.private-key-location", () -> "file:" + privatePem);
    }

    private static String pem(String type, byte[] der) {
        return "-----BEGIN " + type + "-----\n" + Base64.getMimeEncoder(64, new byte[] {'\n'}).encodeToString(der)
                + "\n-----END " + type + "-----\n";
    }

    @LocalServerPort
    int port;

    private final HttpClient http = HttpClient.newHttpClient();
    private final JsonMapper json = JsonMapper.builder().build();

    private HttpResponse<String> post(String body) throws Exception {
        return http.send(HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/dev/tokens"))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(body)).build(), HttpResponse.BodyHandlers.ofString());
    }

    private JWTClaimsSet verifiedClaims(String token) throws Exception {
        String base64 = Files.readString(publicPem).replaceAll("-----(BEGIN|END) PUBLIC KEY-----", "")
                .replaceAll("\\s", "");
        RSAPublicKey publicKey = (RSAPublicKey) KeyFactory.getInstance("RSA")
                .generatePublic(new X509EncodedKeySpec(Base64.getDecoder().decode(base64)));
        SignedJWT jwt = SignedJWT.parse(token);
        assertThat(jwt.getHeader().getAlgorithm()).isEqualTo(JWSAlgorithm.RS256);
        assertThat(jwt.getHeader().getKeyID()).isNotBlank();
        assertThat(jwt.verify(new RSASSAVerifier(publicKey))).as("signature verifies with the public PEM").isTrue();
        return jwt.getJWTClaimsSet();
    }

    @Test
    void customerTokenLasts8HoursAndCarriesTheContractClaims() throws Exception {
        HttpResponse<String> response = post("{\"role\":\"customer\"}");
        assertThat(response.statusCode()).isEqualTo(200);
        JsonNode body = json.readTree(response.body());
        assertThat(body.get("tokenType").asString()).isEqualTo("Bearer");
        assertThat(body.get("role").asString()).isEqualTo("customer");
        assertThat(body.get("subject").asString()).matches("customer-[0-9a-f]{8}");

        JWTClaimsSet claims = verifiedClaims(body.get("token").asString());
        assertThat(claims.getIssuer()).isEqualTo("ycyw-auth-stub");
        assertThat(claims.getAudience()).containsExactly("ycyw-chat");
        assertThat(claims.getSubject()).isEqualTo(body.get("subject").asString());
        assertThat(claims.getStringClaim("role")).isEqualTo("customer");
        assertThat(claims.getStringClaim("name")).isEqualTo(claims.getSubject());
        assertThat(claims.getJWTID()).isNotBlank();
        Duration ttl = Duration.between(claims.getIssueTime().toInstant(), claims.getExpirationTime().toInstant());
        assertThat(ttl).isEqualTo(Duration.ofHours(8));
        assertThat(Instant.parse(body.get("expiresAt").asString())).isEqualTo(claims.getExpirationTime().toInstant());
    }

    @Test
    void guestTokenCarriesReservationReferenceAndEmail() throws Exception {
        JsonNode body = json.readTree(post("""
                {"role":"guest","name":"Alice","email":"alice@example.com","reservationReference":"YCYW-2026-000123"}
                """).body());
        JWTClaimsSet claims = verifiedClaims(body.get("token").asString());
        assertThat(claims.getStringClaim("role")).isEqualTo("guest");
        assertThat(claims.getStringClaim("name")).isEqualTo("Alice");
        assertThat(claims.getStringClaim("email")).isEqualTo("alice@example.com");
        assertThat(claims.getStringClaim("reservation_reference")).isEqualTo("YCYW-2026-000123");
    }

    @Test
    void renewalWithTheSameSubjectKeepsTheIdentityAndShortTtlIsAllowed() throws Exception {
        JsonNode body = json.readTree(post("{\"role\":\"agent\",\"subject\":\"agent-1\",\"ttlSeconds\":5}").body());
        JWTClaimsSet claims = verifiedClaims(body.get("token").asString());
        assertThat(claims.getSubject()).isEqualTo("agent-1");
        assertThat(claims.getStringClaim("role")).isEqualTo("agent");
        assertThat(claims.getStringClaim("reservation_reference")).isNull();
        assertThat(Duration.between(claims.getIssueTime().toInstant(), claims.getExpirationTime().toInstant()))
                .isEqualTo(Duration.ofSeconds(5));
    }

    @Test
    void invalidRequestsGet400InvalidRequest() throws Exception {
        for (String body : new String[] {
                "{}",
                "{\"role\":\"admin\"}",
                "{\"role\":\"customer\",\"ttlSeconds\":0}",
                "{\"role\":\"customer\",\"ttlSeconds\":28801}",
                "{\"role\":\"customer\",\"subject\":\"has spaces\"}",
                "not json"}) {
            HttpResponse<String> response = post(body);
            assertThat(response.statusCode()).as(body).isEqualTo(400);
            assertThat(json.readTree(response.body()).get("code").asString()).as(body).isEqualTo("INVALID_REQUEST");
        }
    }
}
