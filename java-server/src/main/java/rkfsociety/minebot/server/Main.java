package rkfsociety.minebot.server;

import com.sun.net.httpserver.Headers;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;

public final class Main {
  public static void main(String[] args) throws Exception {
    int port = Integer.parseInt(System.getenv().getOrDefault("MINEBOT_PORT", "3847"));
    HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", port), 0);

    Path settingsPath = AppPaths.settingsPath();
    Settings settings = Settings.load(settingsPath);
    SseHub sse = new SseHub();
    BotManager bot = new BotManager(sse);

    // Simple health
    server.createContext("/api/status", ex -> {
      send(ex, 200, "application/json; charset=utf-8", bot.statusJson(settings));
    });

    server.createContext("/api/config", ex -> {
      if ("GET".equalsIgnoreCase(ex.getRequestMethod())) {
        // Пароль хранится локально, поэтому можно отдавать его в UI.
        send(ex, 200, "application/json; charset=utf-8", settings.toJson(true));
        return;
      }
      if ("POST".equalsIgnoreCase(ex.getRequestMethod())) {
        String body = readBody(ex);
        // patch known fields
        settings.host = JsonMini.getString(body, "host", settings.host);
        settings.port = JsonMini.getInt(body, "port", settings.port);
        settings.username = JsonMini.getString(body, "username", settings.username);
        settings.version = JsonMini.getString(body, "version", settings.version);
        String pass = JsonMini.getString(body, "password", null);
        if (pass != null) settings.password = pass;
        settings.registerFirst = JsonMini.getBool(body, "registerFirst", settings.registerFirst);
        settings.save(settingsPath);
        send(ex, 200, "application/json; charset=utf-8", "{\"ok\":true,\"config\":" + settings.toJson(true) + "}");
        return;
      }
      send(ex, 405, "application/json; charset=utf-8", "{\"ok\":false,\"error\":\"method_not_allowed\"}");
    });

    server.createContext("/api/connect", ex -> {
      if (!"POST".equalsIgnoreCase(ex.getRequestMethod())) {
        send(ex, 405, "application/json; charset=utf-8", "{\"ok\":false,\"error\":\"method_not_allowed\"}");
        return;
      }
      bot.start(settings);
      send(ex, 200, "application/json; charset=utf-8", "{\"ok\":true}");
    });

    server.createContext("/api/disconnect", ex -> {
      if (!"POST".equalsIgnoreCase(ex.getRequestMethod())) {
        send(ex, 405, "application/json; charset=utf-8", "{\"ok\":false,\"error\":\"method_not_allowed\"}");
        return;
      }
      bot.stop();
      send(ex, 200, "application/json; charset=utf-8", "{\"ok\":true}");
    });

    server.createContext("/api/restart", ex -> {
      if (!"POST".equalsIgnoreCase(ex.getRequestMethod())) {
        send(ex, 405, "application/json; charset=utf-8", "{\"ok\":false,\"error\":\"method_not_allowed\"}");
        return;
      }
      bot.stop();
      bot.start(settings);
      send(ex, 200, "application/json; charset=utf-8", "{\"ok\":true}");
    });

    server.createContext("/api/chat", ex -> {
      if (!"POST".equalsIgnoreCase(ex.getRequestMethod())) {
        send(ex, 405, "application/json; charset=utf-8", "{\"ok\":false,\"error\":\"method_not_allowed\"}");
        return;
      }
      String body = readBody(ex);
      String text = JsonMini.getString(body, "text", "");
      if (text == null || text.isBlank()) {
        send(ex, 400, "application/json; charset=utf-8", "{\"ok\":false,\"error\":\"empty\"}");
        return;
      }
      bot.sendChat(text);
      send(ex, 200, "application/json; charset=utf-8", "{\"ok\":true}");
    });

    server.createContext("/api/stream", sse::handleStream);

    server.createContext("/api/update/check", ex -> {
      if (!"GET".equalsIgnoreCase(ex.getRequestMethod())) {
        send(ex, 405, "application/json; charset=utf-8", "{\"ok\":false,\"error\":\"method_not_allowed\"}");
        return;
      }
      var r = UpdateManager.check();
      String body =
        "{"
          + "\"ok\":" + r.ok()
          + ",\"jarPath\":" + JsonMini.q(r.jarPath())
          + ",\"sha256\":" + (r.sha256() == null ? "null" : JsonMini.q(r.sha256()))
          + ",\"latestTag\":" + (r.latestTag() == null ? "null" : JsonMini.q(r.latestTag()))
          + "}";
      send(ex, 200, "application/json; charset=utf-8", body);
    });

    server.createContext("/api/update/apply", ex -> {
      if (!"POST".equalsIgnoreCase(ex.getRequestMethod())) {
        send(ex, 405, "application/json; charset=utf-8", "{\"ok\":false,\"error\":\"method_not_allowed\"}");
        return;
      }
      var r = UpdateManager.applyAndRelaunch(port);
      String body =
        "{"
          + "\"ok\":" + r.ok()
          + ",\"updated\":" + (r.updated() == null ? "null" : r.updated())
          + (r.error() == null ? "" : ",\"error\":" + JsonMini.q(r.error()))
          + "}";
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
    ex.getResponseHeaders().set("Access-Control-Allow-Origin", "*");
    ex.getResponseHeaders().set("Access-Control-Allow-Headers", "Content-Type");
    ex.getResponseHeaders().set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    ex.sendResponseHeaders(code, bytes.length);
    ex.getResponseBody().write(bytes);
    ex.close();
  }

  private static String readBody(HttpExchange ex) throws IOException {
    try (InputStream is = ex.getRequestBody()) {
      return new String(is.readAllBytes(), StandardCharsets.UTF_8);
    }
  }
}

