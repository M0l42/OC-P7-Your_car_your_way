package com.ycyw.chat.security;

import com.ycyw.chat.conversation.ChatError;
import com.ycyw.chat.conversation.ChatException;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.interfaces.RSAPublicKey;
import java.security.spec.X509EncodedKeySpec;
import java.time.Clock;
import java.time.Instant;
import java.util.Base64;
import java.util.List;
import org.springframework.security.oauth2.core.DelegatingOAuth2TokenValidator;
import org.springframework.security.oauth2.jose.jws.SignatureAlgorithm;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtClaimNames;
import org.springframework.security.oauth2.jwt.JwtClaimValidator;
import org.springframework.security.oauth2.jwt.JwtException;
import org.springframework.security.oauth2.jwt.JwtIssuerValidator;
import org.springframework.security.oauth2.jwt.NimbusJwtDecoder;
import org.springframework.stereotype.Component;

/**
 * Verifies an RS256 bearer token (signature, {@code iss}, {@code aud}, {@code exp}) and turns it into an
 * {@link Actor}. Used at STOMP CONNECT and on every REST request (A5). Expiry is checked separately,
 * without clock skew, so it can be reported as {@code TOKEN_EXPIRED} rather than {@code UNAUTHORIZED}.
 */
@Component
public class TokenVerifier {

    private final NimbusJwtDecoder decoder;
    private final Clock clock;

    public TokenVerifier(JwtProperties properties) {
        this.clock = Clock.systemUTC();
        this.decoder = NimbusJwtDecoder.withPublicKey(readPublicKey(properties))
                .signatureAlgorithm(SignatureAlgorithm.RS256).build();
        decoder.setJwtValidator(new DelegatingOAuth2TokenValidator<>(
                new JwtIssuerValidator(properties.issuer()),
                new JwtClaimValidator<List<String>>(JwtClaimNames.AUD,
                        aud -> aud != null && aud.contains(properties.audience())),
                new JwtClaimValidator<Instant>(JwtClaimNames.EXP, exp -> exp != null)));
    }

    /** @param authorization the raw {@code Authorization} header value ("Bearer …"), may be null */
    public Actor verify(String authorization) {
        if (authorization == null || !authorization.regionMatches(true, 0, "Bearer ", 0, 7)) {
            throw new ChatException(ChatError.UNAUTHORIZED, "Missing Authorization: Bearer <jwt>");
        }
        Jwt jwt;
        try {
            jwt = decoder.decode(authorization.substring(7).trim());
        } catch (JwtException e) {
            throw new ChatException(ChatError.UNAUTHORIZED, "Invalid token: " + e.getMessage());
        }
        Instant expiresAt = jwt.getExpiresAt();
        if (!clock.instant().isBefore(expiresAt)) {
            throw new ChatException(ChatError.TOKEN_EXPIRED, "Token expired at " + expiresAt);
        }
        Role role;
        try {
            role = Role.fromClaim(jwt.getClaimAsString("role"));
        } catch (IllegalArgumentException e) {
            throw new ChatException(ChatError.UNAUTHORIZED, "Invalid role claim");
        }
        String subject = jwt.getSubject();
        if (subject == null || subject.isBlank()) {
            throw new ChatException(ChatError.UNAUTHORIZED, "Missing sub claim");
        }
        String reservation = role == Role.GUEST ? jwt.getClaimAsString("reservation_reference") : null;
        return new Actor(subject, role, reservation);
    }

    private static RSAPublicKey readPublicKey(JwtProperties properties) {
        if (properties.publicKeyLocation() == null) {
            throw new IllegalStateException(
                    "chat.jwt.public-key-location (CHAT_JWT_PUBLIC_KEY_LOCATION) must point at the issuer's public key PEM");
        }
        try (InputStream in = properties.publicKeyLocation().getInputStream()) {
            String pem = new String(in.readAllBytes(), StandardCharsets.US_ASCII);
            String base64 = pem.replaceAll("-----(BEGIN|END) PUBLIC KEY-----", "").replaceAll("\\s", "");
            return (RSAPublicKey) KeyFactory.getInstance("RSA")
                    .generatePublic(new X509EncodedKeySpec(Base64.getDecoder().decode(base64)));
        } catch (IOException | GeneralSecurityException | IllegalArgumentException | ClassCastException e) {
            throw new IllegalStateException("cannot read RSA public key from " + properties.publicKeyLocation(), e);
        }
    }
}
