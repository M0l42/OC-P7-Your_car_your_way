package com.ycyw.authstub;

import com.nimbusds.jose.JOSEException;
import com.nimbusds.jose.JOSEObjectType;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.crypto.RSASSASigner;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.time.temporal.ChronoUnit;
import java.util.Date;
import java.util.HexFormat;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ThreadLocalRandom;
import java.util.regex.Pattern;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/**
 * DEV-ONLY stand-in for the monolith's token issuer (A5, protocol.md §6): {@code POST /dev/tokens}
 * returns an RS256 JWT for a customer, guest or agent persona. No credentials are checked.
 */
@RestController
public class TokenController {

    private static final Set<String> ROLES = Set.of("customer", "guest", "agent");
    private static final DateTimeFormatter WIRE_TIME =
            DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC);
    private static final Pattern SUBJECT = Pattern.compile("[A-Za-z0-9._@-]{1,64}");

    private final SigningKey key;
    private final AuthStubProperties properties;
    private final Clock clock;

    public TokenController(SigningKey key, AuthStubProperties properties, Clock clock) {
        this.key = key;
        this.properties = properties;
        this.clock = clock;
    }

    public record TokenRequest(String role, String subject, String name, String email, String reservationReference,
            Integer ttlSeconds) {
    }

    /** {@code expiresAt}: ISO-8601 UTC with milliseconds, the contract's timestamp format (protocol.md §1). */
    public record TokenResponse(String token, String tokenType, String expiresAt, String subject, String role) {
    }

    public record ApiError(String code, String reason) {
    }

    static final class InvalidRequest extends RuntimeException {
        InvalidRequest(String reason) {
            super(reason);
        }
    }

    @PostMapping("/dev/tokens")
    public TokenResponse issue(@RequestBody TokenRequest request) throws JOSEException {
        String role = request.role();
        if (role == null || !ROLES.contains(role)) {
            throw new InvalidRequest("role must be one of " + ROLES);
        }
        String subject = request.subject() == null
                ? role + "-" + HexFormat.of().toHexDigits(ThreadLocalRandom.current().nextInt())
                : request.subject();
        if (!SUBJECT.matcher(subject).matches()) {
            throw new InvalidRequest("subject must match " + SUBJECT.pattern());
        }
        long maxTtl = properties.maxTtl().toSeconds();
        long ttl = request.ttlSeconds() == null ? maxTtl : request.ttlSeconds();
        if (ttl < 1 || ttl > maxTtl) {
            throw new InvalidRequest("ttlSeconds must be between 1 and " + maxTtl);
        }
        requireMaxLength("name", request.name(), 100);
        requireMaxLength("email", request.email(), 254);
        requireMaxLength("reservationReference", request.reservationReference(), 64);

        Instant now = clock.instant().truncatedTo(ChronoUnit.SECONDS);
        Instant expiresAt = now.plusSeconds(ttl);
        JWTClaimsSet.Builder claims = new JWTClaimsSet.Builder()
                .issuer(properties.issuer())
                .audience(properties.audience())
                .subject(subject)
                .claim("role", role)
                .claim("name", request.name() == null ? subject : request.name())
                .issueTime(Date.from(now))
                .expirationTime(Date.from(expiresAt))
                .jwtID(UUID.randomUUID().toString());
        if ("guest".equals(role)) {
            if (request.email() != null) {
                claims.claim("email", request.email());
            }
            if (request.reservationReference() != null) {
                claims.claim("reservation_reference", request.reservationReference());
            }
        }
        SignedJWT jwt = new SignedJWT(
                new JWSHeader.Builder(JWSAlgorithm.RS256).type(JOSEObjectType.JWT).keyID(key.keyId()).build(),
                claims.build());
        jwt.sign(new RSASSASigner(key.privateKey()));
        return new TokenResponse(jwt.serialize(), "Bearer", WIRE_TIME.format(expiresAt), subject, role);
    }

    private static void requireMaxLength(String field, String value, int max) {
        if (value != null && value.length() > max) {
            throw new InvalidRequest(field + " longer than " + max);
        }
    }

    @ExceptionHandler(InvalidRequest.class)
    ResponseEntity<ApiError> invalid(InvalidRequest e) {
        return ResponseEntity.badRequest().body(new ApiError("INVALID_REQUEST", e.getMessage()));
    }

    @ExceptionHandler(HttpMessageNotReadableException.class)
    ResponseEntity<ApiError> unreadable(HttpMessageNotReadableException e) {
        return ResponseEntity.badRequest().body(new ApiError("INVALID_REQUEST", "body must be a JSON object"));
    }
}
