package com.ycyw.chat.security;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.core.io.Resource;

/**
 * {@code chat.jwt.*}: the token issuer's RSA public key (X.509 SPKI PEM, env
 * {@code CHAT_JWT_PUBLIC_KEY_LOCATION}) plus expected issuer and audience. The service never calls the
 * issuer at runtime (premise 3).
 */
@ConfigurationProperties("chat.jwt")
public record JwtProperties(Resource publicKeyLocation, String issuer, String audience) {

    public JwtProperties {
        issuer = issuer == null ? "ycyw-auth-stub" : issuer;
        audience = audience == null ? "ycyw-chat" : audience;
    }
}
