package rkfsociety.minebot.server;

import com.sun.net.httpserver.Headers;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;

public final class Main {
  public static void main(String[] args) throws Exception {
    int port = Integer.parseInt(System.getenv().getOrDefault("MINEBOT_PORT", "3847"));
    HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", port), 0);

    // Simple health
    server.createContext("/api/status", ex -> {
      String body = "{\"ok\":true,\"service\":\"minebot-java\",\"port\":" + port + "}";
      send(ex, 200, "application/json; charset=utf-8", body);
    });

    // Serve embedded UI
    server.createContext("/home", ex -> {
      try {
        String html = readResource("/public/index.html");
        send(ex, 200, "text/html; charset=utf-8", html);
      } catch (Exception e) {
        send(ex, 500, "text/plain; charset=utf-8", "UI load failed: " + e.getMessage());
      }
    });

    server.createContext("/", ex -> {
      Headers h = ex.getResponseHeaders();
      h.set("Location", "/home");
      ex.sendResponseHeaders(302, -1);
      ex.close();
    });

    server.start();
    System.out.println("MineBotServer started on http://127.0.0.1:" + port + "/home");
  }

  private static String readResource(String path) throws Exception {
    try (InputStream is = Main.class.getResourceAsStream(path)) {
      if (is == null) {
        throw new IllegalStateException("Missing resource: " + path);
      }
      return new String(is.readAllBytes(), StandardCharsets.UTF_8);
    }
  }

  private static void send(HttpExchange ex, int code, String contentType, String body) throws IOException {
    byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
    ex.getResponseHeaders().set("Content-Type", contentType);
    ex.sendResponseHeaders(code, bytes.length);
    ex.getResponseBody().write(bytes);
    ex.close();
  }
}

