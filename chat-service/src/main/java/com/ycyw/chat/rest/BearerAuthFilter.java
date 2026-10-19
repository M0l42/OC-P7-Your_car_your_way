package com.ycyw.chat.rest;

import com.ycyw.chat.conversation.ChatException;
import com.ycyw.chat.security.TokenVerifier;
import com.ycyw.chat.stomp.ActorPrincipal;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.List;
import org.springframework.http.HttpHeaders;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.filter.OncePerRequestFilter;
import tools.jackson.databind.json.JsonMapper;

/**
 * REST authentication: the same RS256 verification as STOMP CONNECT, on every {@code /api} request.
 * An expired token answers 401 {@code TOKEN_EXPIRED} (client renews and retries, A5); an invalid one
 * 401 {@code UNAUTHORIZED}. No header → left unauthenticated, the entry point answers 401 UNAUTHORIZED.
 */
public class BearerAuthFilter extends OncePerRequestFilter {

    private final TokenVerifier tokens;
    private final JsonMapper json;

    public BearerAuthFilter(TokenVerifier tokens, JsonMapper json) {
        this.tokens = tokens;
        this.json = json;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String authorization = request.getHeader(HttpHeaders.AUTHORIZATION);
        if (authorization != null) {
            try {
                ActorPrincipal principal = new ActorPrincipal(tokens.verify(authorization));
                SecurityContextHolder.getContext().setAuthentication(
                        UsernamePasswordAuthenticationToken.authenticated(principal, null, List.of()));
            } catch (ChatException e) {
                write(response, e, json);
                return;
            }
        }
        chain.doFilter(request, response);
    }

    static void write(HttpServletResponse response, ChatException e, JsonMapper json) throws IOException {
        response.setStatus(e.code().httpStatus().value());
        response.setContentType("application/json");
        response.getWriter().write(json.writeValueAsString(new ApiError(e.code(), e.reason())));
    }
}
