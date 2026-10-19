package com.ycyw.chat.config;

import com.ycyw.chat.conversation.ChatError;
import com.ycyw.chat.rest.ApiError;
import com.ycyw.chat.rest.BearerAuthFilter;
import com.ycyw.chat.security.TokenVerifier;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.AnonymousAuthenticationFilter;
import org.springframework.security.web.session.DisableEncodeUrlFilter;
import org.springframework.web.filter.OncePerRequestFilter;
import tools.jackson.databind.json.JsonMapper;

/**
 * HTTP security: probes and the {@code /ws} upgrade are public (STOMP authenticates at CONNECT,
 * StompAuthInterceptor); {@code /api/**} needs a valid bearer token (BearerAuthFilter). Per-conversation
 * authorization is the ConversationAccessPolicy inside the services (O4), not URL rules.
 */
@Configuration
public class SecurityConfig {

    @Bean
    SecurityFilterChain securityFilterChain(HttpSecurity http, TokenVerifier tokens, JsonMapper json,
            @Value("${chat.instance-id}") String instanceId) throws Exception {
        return http
                .addFilterBefore(instanceIdHeader(instanceId), DisableEncodeUrlFilter.class)
                .csrf(csrf -> csrf.disable())
                .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .addFilterBefore(new BearerAuthFilter(tokens, json), AnonymousAuthenticationFilter.class)
                .exceptionHandling(e -> e.authenticationEntryPoint((request, response, ex) -> {
                    response.setStatus(401);
                    response.setContentType("application/json");
                    response.getWriter().write(json.writeValueAsString(new ApiError(
                            ChatError.UNAUTHORIZED, "Missing Authorization: Bearer <jwt>")));
                }))
                .authorizeHttpRequests(auth -> auth
                        .requestMatchers("/actuator/health/**", "/actuator/info").permitAll()
                        .requestMatchers("/ws", "/error").permitAll()
                        .requestMatchers("/api/**").authenticated()
                        .anyRequest().denyAll())
                .build();
    }

    /** {@code X-Instance-Id} on every HTTP response, 401s included (debug, protocol.md §4). */
    private static OncePerRequestFilter instanceIdHeader(String instanceId) {
        return new OncePerRequestFilter() {
            @Override
            protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
                    FilterChain chain) throws ServletException, IOException {
                response.setHeader("X-Instance-Id", instanceId);
                chain.doFilter(request, response);
            }
        };
    }
}
