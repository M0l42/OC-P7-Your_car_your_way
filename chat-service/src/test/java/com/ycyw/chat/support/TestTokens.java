package com.ycyw.chat.support;

import com.nimbusds.jose.JOSEException;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.crypto.RSASSASigner;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import com.ycyw.chat.security.Actor;
import java.security.GeneralSecurityException;
import java.security.KeyPairGenerator;
import java.security.PrivateKey;
import java.time.Duration;
import java.time.Instant;
import java.util.Date;
import java.util.UUID;
import java.util.function.Consumer;
import org.springframework.messaging.simp.stomp.StompHeaders;

/** Signs tokens like auth-stub, with the per-JVM test key ({@link TestKeys}). */
public final class TestTokens {

    private TestTokens() {
    }

    /** Valid 8 h token for the actor. */
    public static String token(Actor actor) {
        return token(actor, b -> { });
    }

    public static String token(Actor actor, Consumer<JWTClaimsSet.Builder> customizer) {
        Instant now = Instant.now();
        JWTClaimsSet.Builder claims = new JWTClaimsSet.Builder()
                .issuer("ycyw-auth-stub").audience("ycyw-chat").subject(actor.ref())
                .claim("role", actor.role().claim()).claim("name", actor.ref())
                .issueTime(Date.from(now)).expirationTime(Date.from(now.plus(Duration.ofHours(8))))
                .jwtID(UUID.randomUUID().toString());
        if (actor.reservationReference() != null) {
            claims.claim("reservation_reference", actor.reservationReference());
        }
        customizer.accept(claims);
        return sign(claims.build(), TestKeys.privateKey());
    }

    public static String expired(Actor actor) {
        return token(actor, b -> b.issueTime(Date.from(Instant.now().minusSeconds(3600)))
                .expirationTime(Date.from(Instant.now().minusSeconds(1))));
    }

    /** Correct claims, signed by a key chat-service does not know. */
    public static String foreignSignature(Actor actor) {
        try {
            KeyPairGenerator generator = KeyPairGenerator.getInstance("RSA");
            generator.initialize(2048);
            Instant now = Instant.now();
            return sign(new JWTClaimsSet.Builder().issuer("ycyw-auth-stub").audience("ycyw-chat")
                    .subject(actor.ref()).claim("role", actor.role().claim())
                    .issueTime(Date.from(now)).expirationTime(Date.from(now.plusSeconds(3600))).build(),
                    generator.generateKeyPair().getPrivate());
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
    }

    public static String bearer(String token) {
        return "Bearer " + token;
    }

    public static StompHeaders connectHeaders(String token) {
        StompHeaders headers = new StompHeaders();
        headers.add("Authorization", bearer(token));
        return headers;
    }

    public static StompHeaders connectHeaders(Actor actor) {
        return connectHeaders(token(actor));
    }

    private static String sign(JWTClaimsSet claims, PrivateKey key) {
        try {
            SignedJWT jwt = new SignedJWT(new JWSHeader.Builder(JWSAlgorithm.RS256).keyID("test").build(), claims);
            jwt.sign(new RSASSASigner(key));
            return jwt.serialize();
        } catch (JOSEException e) {
            throw new IllegalStateException(e);
        }
    }
}
