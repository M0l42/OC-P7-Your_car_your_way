TEST-ONLY RSA keypair used by chat-service integration tests to sign and verify JWTs
(`chat.jwt.public-key-location` in `src/test/resources/application.properties`, `TestTokens`).
It protects nothing and is never used by the compose stack, which generates its own dev keypair
in the `jwt-keys` volume.
