package com.ycyw.authstub;

import java.time.Clock;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;

@SpringBootApplication
@EnableConfigurationProperties(AuthStubProperties.class)
public class AuthStubApplication {

    public static void main(String[] args) {
        SpringApplication.run(AuthStubApplication.class, args);
    }

    @Bean
    SigningKey signingKey(AuthStubProperties properties) {
        return SigningKey.load(properties.privateKeyLocation());
    }

    @Bean
    Clock clock() {
        return Clock.systemUTC();
    }
}
