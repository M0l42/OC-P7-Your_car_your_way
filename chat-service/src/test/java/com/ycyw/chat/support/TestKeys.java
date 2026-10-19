package com.ycyw.chat.support;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.GeneralSecurityException;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.PrivateKey;
import java.util.Base64;
import java.util.Map;
import org.springframework.boot.EnvironmentPostProcessor;
import org.springframework.boot.SpringApplication;
import org.springframework.core.env.ConfigurableEnvironment;
import org.springframework.core.env.MapPropertySource;

/**
 * Test-only RS256 keypair, generated once per test JVM (no private key in the repository). Every
 * chat-service context started by a test verifies tokens with its public half: this class is also an
 * EnvironmentPostProcessor (src/test/resources/META-INF/spring.factories) that points
 * {@code chat.jwt.public-key-location} at a temp PEM file. {@link TestTokens} signs with the private half.
 */
public final class TestKeys implements EnvironmentPostProcessor {

    private static final KeyPair PAIR;
    private static final Path PUBLIC_PEM;

    static {
        try {
            KeyPairGenerator generator = KeyPairGenerator.getInstance("RSA");
            generator.initialize(2048);
            PAIR = generator.generateKeyPair();
            PUBLIC_PEM = Files.createTempFile("chat-test-jwt-", ".pem");
            PUBLIC_PEM.toFile().deleteOnExit();
            Files.writeString(PUBLIC_PEM, "-----BEGIN PUBLIC KEY-----\n"
                    + Base64.getMimeEncoder(64, new byte[] {'\n'}).encodeToString(PAIR.getPublic().getEncoded())
                    + "\n-----END PUBLIC KEY-----\n");
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException(e);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    public static PrivateKey privateKey() {
        return PAIR.getPrivate();
    }

    @Override
    public void postProcessEnvironment(ConfigurableEnvironment environment, SpringApplication application) {
        environment.getPropertySources().addFirst(new MapPropertySource("testJwtKeys",
                Map.of("chat.jwt.public-key-location", "file:" + PUBLIC_PEM)));
    }
}
