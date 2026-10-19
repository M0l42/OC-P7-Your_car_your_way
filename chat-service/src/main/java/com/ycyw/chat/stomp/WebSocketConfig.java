package com.ycyw.chat.stomp;

import com.ycyw.chat.fanout.WebSocketSessionRegistry;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.messaging.simp.config.ChannelRegistration;
import org.springframework.messaging.simp.config.MessageBrokerRegistry;
import org.springframework.scheduling.TaskScheduler;
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler;
import org.springframework.web.socket.config.annotation.EnableWebSocketMessageBroker;
import org.springframework.web.socket.config.annotation.StompEndpointRegistry;
import org.springframework.web.socket.config.annotation.WebSocketMessageBrokerConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketTransportRegistration;
import org.springframework.web.socket.server.standard.ServletServerContainerFactoryBean;

/** STOMP over WebSocket on {@code /ws} with the in-memory simple broker (protocol.md §3). */
@Configuration
@EnableWebSocketMessageBroker
public class WebSocketConfig implements WebSocketMessageBrokerConfigurer {

    /** A7: largest inbound STOMP frame / WebSocket message. */
    public static final int MESSAGE_SIZE_LIMIT = 16 * 1024;

    private final WebSocketSessionRegistry sessions;
    private final ReceiptInterceptor receipts;
    private final StompAuthInterceptor auth;
    private final StompErrorHandler errors;
    private final InstanceIdHeader instanceIdHeader;
    private final String[] allowedOrigins;

    public WebSocketConfig(WebSocketSessionRegistry sessions, ReceiptInterceptor receipts, StompAuthInterceptor auth,
            StompErrorHandler errors, InstanceIdHeader instanceIdHeader,
            @Value("${chat.allowed-origins:}") String[] allowedOrigins) {
        this.sessions = sessions;
        this.receipts = receipts;
        this.auth = auth;
        this.errors = errors;
        this.instanceIdHeader = instanceIdHeader;
        this.allowedOrigins = allowedOrigins;
    }

    @Override
    public void registerStompEndpoints(StompEndpointRegistry registry) {
        // A7: a foreign Origin gets 403; no Origin (non-browser clients) is accepted by Spring.
        registry.addEndpoint("/ws").setAllowedOrigins(allowedOrigins).addInterceptors(sessions);
        // A1 layer (a): inbound frames of one session are handled in order (SUBSCRIBE before what follows).
        registry.setPreserveReceiveOrder(true);
        registry.setErrorHandler(errors);
    }

    @Override
    public void configureMessageBroker(MessageBrokerRegistry registry) {
        registry.enableSimpleBroker("/topic", "/queue")
                .setHeartbeatValue(new long[] {10_000, 10_000})
                .setTaskScheduler(heartbeatScheduler());
        registry.setApplicationDestinationPrefixes("/app");
        registry.setUserDestinationPrefix("/user");
        // O9: messages to one session leave in the order they were published.
        registry.setPreservePublishOrder(true);
    }

    @Override
    public void configureClientInboundChannel(ChannelRegistration registration) {
        // Authentication first: nothing reaches the broker or controllers unauthenticated (A7).
        registration.interceptors(auth, receipts);
    }

    @Override
    public void configureWebSocketTransport(WebSocketTransportRegistration registration) {
        registration.setMessageSizeLimit(MESSAGE_SIZE_LIMIT);
        registration.addDecoratorFactory(sessions);
        registration.addDecoratorFactory(instanceIdHeader);
    }

    /** Container-level limit (Tomcat closes a larger message with 1009). */
    @Bean
    ServletServerContainerFactoryBean webSocketContainer() {
        ServletServerContainerFactoryBean container = new ServletServerContainerFactoryBean();
        container.setMaxTextMessageBufferSize(MESSAGE_SIZE_LIMIT);
        container.setMaxBinaryMessageBufferSize(MESSAGE_SIZE_LIMIT);
        return container;
    }

    @Bean
    TaskScheduler heartbeatScheduler() {
        ThreadPoolTaskScheduler scheduler = new ThreadPoolTaskScheduler();
        scheduler.setPoolSize(1);
        scheduler.setThreadNamePrefix("stomp-heartbeat-");
        return scheduler;
    }
}
