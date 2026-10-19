package com.ycyw.authstub;

import com.nimbusds.jose.JOSEException;
import com.nimbusds.jose.jwk.RSAKey;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.KeyPairGenerator;
import java.security.interfaces.RSAPrivateCrtKey;
import java.security.interfaces.RSAPublicKey;
import java.security.spec.PKCS8EncodedKeySpec;
import java.security.spec.RSAPublicKeySpec;
import java.util.Base64;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.io.Resource;

/** The RS256 signing key with its public half and {@code kid} (RFC 7638 thumbprint). */
public final class SigningKey {

    private static final Logger log = LoggerFactory.getLogger(SigningKey.class);

    private final RSAPrivateCrtKey privateKey;
    private final RSAPublicKey publicKey;
    private final String keyId;

    private SigningKey(RSAPrivateCrtKey privateKey) {
        try {
            this.privateKey = privateKey;
            this.publicKey = (RSAPublicKey) KeyFactory.getInstance("RSA")
                    .generatePublic(new RSAPublicKeySpec(privateKey.getModulus(), privateKey.getPublicExponent()));
            this.keyId = new RSAKey.Builder(publicKey).build().computeThumbprint().toString();
        } catch (GeneralSecurityException | JOSEException e) {
            throw new IllegalStateException("cannot derive the public key", e);
        }
    }

    /** Loads a PKCS#8 PEM ("BEGIN PRIVATE KEY"), or generates an ephemeral key when none is configured. */
    public static SigningKey load(Resource location) {
        if (location == null) {
            log.warn("auth.private-key-location not set: using an EPHEMERAL dev key (tokens die with this process)");
            return generate();
        }
        try (InputStream in = location.getInputStream()) {
            String pem = new String(in.readAllBytes(), StandardCharsets.US_ASCII);
            String base64 = pem.replaceAll("-----(BEGIN|END) PRIVATE KEY-----", "").replaceAll("\\s", "");
            byte[] der = Base64.getDecoder().decode(base64);
            RSAPrivateCrtKey key = (RSAPrivateCrtKey) KeyFactory.getInstance("RSA")
                    .generatePrivate(new PKCS8EncodedKeySpec(der));
            log.info("Loaded DEV-ONLY signing key from {}", location);
            return new SigningKey(key);
        } catch (IOException | GeneralSecurityException | IllegalArgumentException | ClassCastException e) {
            throw new IllegalStateException("cannot read PKCS#8 RSA private key from " + location, e);
        }
    }

    public static SigningKey generate() {
        try {
            KeyPairGenerator generator = KeyPairGenerator.getInstance("RSA");
            generator.initialize(2048);
            return new SigningKey((RSAPrivateCrtKey) generator.generateKeyPair().getPrivate());
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
    }

    public RSAPrivateCrtKey privateKey() {
        return privateKey;
    }

    public RSAPublicKey publicKey() {
        return publicKey;
    }

    public String keyId() {
        return keyId;
    }
}
