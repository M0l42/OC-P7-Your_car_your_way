package com.ycyw.chat.support;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import org.testcontainers.toxiproxy.ToxiproxyContainer;

/** Minimal Toxiproxy HTTP API client: one TCP proxy, enable/disable, add/remove toxics. */
public final class Toxiproxy {

    /** First of the proxy ports exposed by {@link ToxiproxyContainer} (8666-8697). */
    public static final int PROXY_PORT = 8666;

    private final ToxiproxyContainer container;
    private final String name;
    private final HttpClient http = HttpClient.newHttpClient();

    private Toxiproxy(ToxiproxyContainer container, String name) {
        this.container = container;
        this.name = name;
    }

    /** Creates proxy {@code name} listening on {@link #PROXY_PORT} inside the container. */
    public static Toxiproxy create(ToxiproxyContainer container, String name, String upstream) {
        Toxiproxy proxy = new Toxiproxy(container, name);
        proxy.call("POST", "/proxies", "{\"name\":\"" + name + "\",\"listen\":\"0.0.0.0:" + PROXY_PORT
                + "\",\"upstream\":\"" + upstream + "\",\"enabled\":true}");
        return proxy;
    }

    public String host() {
        return container.getHost();
    }

    public int port() {
        return container.getMappedPort(PROXY_PORT);
    }

    /** Disabled = every connection refused/closed (like a dead database host). */
    public void setEnabled(boolean enabled) {
        call("POST", "/proxies/" + name, "{\"enabled\":" + enabled + "}");
    }

    /** Half-open connection: data stops flowing both ways, nothing is closed (timeout 0 = forever). */
    public void blackhole() {
        for (String stream : new String[] {"upstream", "downstream"}) {
            call("POST", "/proxies/" + name + "/toxics", "{\"name\":\"blackhole-" + stream
                    + "\",\"type\":\"timeout\",\"stream\":\"" + stream + "\",\"attributes\":{\"timeout\":0}}");
        }
    }

    public void heal() {
        for (String stream : new String[] {"upstream", "downstream"}) {
            call("DELETE", "/proxies/" + name + "/toxics/blackhole-" + stream, null);
        }
    }

    private void call(String method, String path, String body) {
        try {
            HttpRequest.Builder request = HttpRequest.newBuilder(URI.create("http://" + container.getHost() + ":"
                    + container.getControlPort() + path)).header("Content-Type", "application/json");
            request.method(method, body == null ? HttpRequest.BodyPublishers.noBody()
                    : HttpRequest.BodyPublishers.ofString(body));
            HttpResponse<String> response = http.send(request.build(), HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() >= 300) {
                throw new IllegalStateException(method + " " + path + " → " + response.statusCode() + " "
                        + response.body());
            }
        } catch (java.io.IOException e) {
            throw new IllegalStateException(e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException(e);
        }
    }
}
