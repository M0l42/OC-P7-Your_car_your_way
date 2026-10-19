package com.ycyw.chat.config;

import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import org.springframework.boot.jackson.JacksonComponent;
import tools.jackson.core.JsonGenerator;
import tools.jackson.databind.SerializationContext;
import tools.jackson.databind.ValueSerializer;

/**
 * Every {@link Instant} on the wire (REST and STOMP) is ISO-8601 UTC with exactly three fraction
 * digits, e.g. {@code 2026-10-19T10:15:30.000Z} (protocol.md §1). Jackson's default ISO_INSTANT
 * would drop a zero fraction and print sub-millisecond digits.
 */
@JacksonComponent
public class WireTimeSerializer extends ValueSerializer<Instant> {

    public static final DateTimeFormatter FORMAT =
            DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC);

    @Override
    public void serialize(Instant value, JsonGenerator gen, SerializationContext context) {
        gen.writeString(FORMAT.format(value));
    }

    @Override
    public Class<Instant> handledType() {
        return Instant.class;
    }
}
