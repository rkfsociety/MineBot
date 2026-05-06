package rkfsociety.minebot.server;

import com.sun.net.httpserver.HttpExchange;

import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

final class SseHub {
  private final Set<OutputStream> clients = ConcurrentHashMap.newKeySet();

  void handleStream(HttpExchange ex) {
    try {
      ex.getResponseHeaders().set("Content-Type", "text/event-stream; charset=utf-8");
      ex.getResponseHeaders().set("Cache-Control", "no-cache");
      ex.getResponseHeaders().set("Connection", "keep-alive");
      ex.sendResponseHeaders(200, 0);
      OutputStream os = ex.getResponseBody();
      clients.add(os);
      // initial ping
      writeRaw(os, "event: ping\ndata: {}\n\n");
      os.flush();
      // keep open; do not close exchange here
    } catch (Exception e) {
      try { ex.close(); } catch (Exception ignored) {}
    }
  }

  void send(String event, String dataJson) {
    String payload = "event: " + event + "\n" + "data: " + dataJson + "\n\n";
    byte[] bytes = payload.getBytes(StandardCharsets.UTF_8);
    for (OutputStream os : clients) {
      try {
        os.write(bytes);
        os.flush();
      } catch (Exception e) {
        clients.remove(os);
        try { os.close(); } catch (Exception ignored) {}
      }
    }
  }

  private static void writeRaw(OutputStream os, String s) throws Exception {
    os.write(s.getBytes(StandardCharsets.UTF_8));
  }
}

