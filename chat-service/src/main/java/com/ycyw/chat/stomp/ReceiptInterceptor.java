package com.ycyw.chat.stomp;

import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.context.annotation.Lazy;
import org.springframework.messaging.Message;
import org.springframework.messaging.MessageChannel;
import org.springframework.messaging.MessageHandler;
import org.springframework.messaging.simp.broker.SimpleBrokerMessageHandler;
import org.springframework.messaging.simp.stomp.StompCommand;
import org.springframework.messaging.simp.stomp.StompHeaderAccessor;
import org.springframework.messaging.support.ExecutorChannelInterceptor;
import org.springframework.messaging.support.MessageBuilder;
import org.springframework.stereotype.Component;

/**
 * Emits the STOMP RECEIPT for a {@code /topic/**} SUBSCRIBE only once the simple broker has
 * registered the subscription (A1, O7). The simple broker itself never sends RECEIPT frames.
 *
 * <pre>
 *  client ── SUBSCRIBE /topic/conversations/42, receipt:r1 ──▶ clientInboundChannel (ordered per session)
 *                                                                 │
 *                         ┌───────────────────────────────────────┼─────────────────────────────┐
 *                         ▼                                       ▼                             ▼
 *           SimpAnnotationMethodMessageHandler        SimpleBrokerMessageHandler     UserDestinationMessageHandler
 *                                                     registers the subscription
 *                                                                 │ handleMessage returned
 *                                                                 ▼
 *                                   afterMessageHandled(handler = SimpleBroker, ex = null)   ◀── this class
 *                                                                 │
 *                                   RECEIPT receipt-id:r1 ──▶ clientOutboundChannel ──▶ client
 *
 *  client: on RECEIPT → backfill afterSeq=lastSeq. Anything committed after the backfill snapshot is
 *  already routed to the registered subscription, so nothing falls between backfill and live.
 * </pre>
 *
 * This relies on afterMessageHandled running per handler after handleMessage returns; integration
 * test 4e (subscribe → receipt → immediate commit on the other instance, safety net off) pins it.
 * Fallback if 4e ever fails: the topic probe (A1 option B). {@code /user/queue/**} subscriptions get
 * no receipt (O7): the client never waits for one there.
 */
@Component
public class ReceiptInterceptor implements ExecutorChannelInterceptor {

    static final String TOPIC_PREFIX = "/topic/";

    private final MessageChannel clientOutboundChannel;

    public ReceiptInterceptor(@Lazy @Qualifier("clientOutboundChannel") MessageChannel clientOutboundChannel) {
        this.clientOutboundChannel = clientOutboundChannel;
    }

    @Override
    public void afterMessageHandled(Message<?> message, MessageChannel channel, MessageHandler handler,
            Exception ex) {
        if (ex != null || !(handler instanceof SimpleBrokerMessageHandler)) {
            return;
        }
        StompHeaderAccessor subscribe = StompHeaderAccessor.wrap(message);
        String receiptId = subscribe.getReceipt();
        String destination = subscribe.getDestination();
        if (subscribe.getCommand() != StompCommand.SUBSCRIBE || receiptId == null || destination == null
                || !destination.startsWith(TOPIC_PREFIX)) {
            return;
        }
        StompHeaderAccessor receipt = StompHeaderAccessor.create(StompCommand.RECEIPT);
        receipt.setReceiptId(receiptId);
        receipt.setSessionId(subscribe.getSessionId());
        receipt.setLeaveMutable(false);
        clientOutboundChannel.send(MessageBuilder.createMessage(new byte[0], receipt.getMessageHeaders()));
    }
}
