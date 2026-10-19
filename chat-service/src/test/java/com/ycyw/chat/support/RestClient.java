package com.ycyw.chat.support;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** Thin JSON-over-HTTP client for the REST tests. */
public final class RestClient {

    /** Status, parsed body (null if empty) and the raw response. */
    public record Response(int status, JsonNode body, HttpResponse<String> raw) {
        public String code() {
            return body == null || body.get("code") == null ? null : body.get("code").asString();
        }
    }

    private static final JsonMapper JSON = JsonMapper.builder().build();
    private final HttpClient http = HttpClient.newHttpClient();
    private final String base;

    public RestClient(int port) {
        this.base = "http://localhost:" + port;
    }

    public Response get(String token, String path) {
        return send(token, "GET", path, null);
    }

    public Response post(String token, String path, String json) {
        return send(token, "POST", path, json);
    }

    public Response send(String token, String method, String path, String json) {
        HttpRequest.Builder request = HttpRequest.newBuilder(URI.create(base + path))
                .method(method, json == null ? HttpRequest.BodyPublishers.noBody()
                        : HttpRequest.BodyPublishers.ofString(json));
        if (json != null) {
            request.header("Content-Type", "application/json");
        }
        if (token != null) {
            request.header("Authorization", "Bearer " + token);
        }
        try {
            HttpResponse<String> response = http.send(request.build(), HttpResponse.BodyHandlers.ofString());
            JsonNode body = response.body().isBlank() ? null : JSON.readTree(response.body());
            return new Response(response.statusCode(), body, response);
        } catch (java.io.IOException e) {
            throw new IllegalStateException(e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException(e);
        }
    }
}
