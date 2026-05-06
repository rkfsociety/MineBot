package rkfsociety.minebot.server;

import java.io.*;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

final class BotManager {
  private final SseHub sse;
  private final ScheduledExecutorService exec = Executors.newSingleThreadScheduledExecutor();

  private volatile Process proc;
  private volatile long startedAtMs = 0;
  private volatile String lastError = null;
  private volatile String lastExit = null;
  private volatile boolean connecting = false;
  private volatile boolean connected = false;
  private volatile boolean spawned = false;

  BotManager(SseHub sse) {
    this.sse = sse;
  }

  synchronized boolean isRunning() {
    return proc != null && proc.isAlive();
  }

  synchronized void start(Settings cfg) {
    if (isRunning()) return;
    lastError = null;
    lastExit = null;
    connecting = true;
    connected = false;
    spawned = false;
    startedAtMs = System.currentTimeMillis();

    Path runtime = AppPaths.runtimeDir();
    Path jar = runtime.resolve("MineBot.jar");
    ensureEngineJar(runtime, jar);
    if (!Files.exists(jar)) return;

    Path cfgPath = runtime.resolve("minebot-config.json");
    writeEngineConfig(cfg, cfgPath);

    try {
      ProcessBuilder pb = new ProcessBuilder(
        "java",
        "-jar",
        jar.toString(),
        "-nogui",
        "-config",
        cfgPath.toString(),
        "-logsdir",
        AppPaths.logsDir().resolve("MineBot").toString()
      );
      pb.directory(runtime.toFile());
      pb.redirectErrorStream(true);
      proc = pb.start();
      sse.send("status", statusJson(cfg));
      pumpLogs(proc.getInputStream());

      exec.scheduleAtFixedRate(() -> sse.send("status", statusJson(cfg)), 250, 750, TimeUnit.MILLISECONDS);
    } catch (Exception e) {
      lastError = "spawn_failed: " + e.getMessage();
      sse.send("log", "{\"level\":\"error\",\"message\":" + JsonMini.q(lastError) + ",\"t\":" + System.currentTimeMillis() + "}");
      proc = null;
    }
  }

  synchronized void stop() {
    if (!isRunning()) return;
    try {
      proc.destroy();
    } catch (Exception ignored) {}
    try {
      proc.waitFor(1200, TimeUnit.MILLISECONDS);
    } catch (Exception ignored) {}
    try {
      proc.destroyForcibly();
    } catch (Exception ignored) {}
    try {
      lastExit = "stopped@" + Instant.now();
    } catch (Exception ignored) {}
    proc = null;
    connecting = false;
    connected = false;
    spawned = false;
  }

  synchronized void sendChat(String text) {
    if (!isRunning()) return;
    try {
      OutputStream os = proc.getOutputStream();
      os.write((text + "\n").getBytes(StandardCharsets.UTF_8));
      os.flush();
    } catch (Exception ignored) {}
  }

  String statusJson(Settings cfg) {
    boolean running = isRunning();
    long now = System.currentTimeMillis();
    StringBuilder sb = new StringBuilder();
    sb.append("{");
    sb.append("\"service\":{");
    sb.append("\"ok\":true,");
    sb.append("\"engine\":\"minebot-java\",");
    sb.append("\"pid\":").append(ProcessHandle.current().pid()).append(",");
    sb.append("\"uptimeMs\":").append(Math.max(0, (long) (java.lang.management.ManagementFactory.getRuntimeMXBean().getUptime()))).append(",");
    sb.append("\"now\":").append(now);
    sb.append("},");
    sb.append("\"host\":").append(JsonMini.q(cfg.host)).append(",");
    sb.append("\"port\":").append(cfg.port).append(",");
    sb.append("\"username\":").append(JsonMini.q(cfg.username)).append(",");
    sb.append("\"version\":").append(JsonMini.q(cfg.version == null ? "auto" : cfg.version)).append(",");
    sb.append("\"hasPassword\":").append(cfg.password != null && !cfg.password.isEmpty()).append(",");
    sb.append("\"running\":").append(running).append(",");
    sb.append("\"connecting\":").append(connecting).append(",");
    sb.append("\"connected\":").append(connected).append(",");
    sb.append("\"spawned\":").append(spawned).append(",");
    sb.append("\"startedAt\":").append(startedAtMs == 0 ? "null" : String.valueOf(startedAtMs)).append(",");
    sb.append("\"lastError\":").append(lastError == null ? "null" : JsonMini.q(lastError)).append(",");
    sb.append("\"lastExit\":").append(lastExit == null ? "null" : JsonMini.q(lastExit));
    sb.append("}");
    return sb.toString();
  }

  private void pumpLogs(InputStream in) {
    Thread t = new Thread(() -> {
      try (BufferedReader br = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
        String line;
        while ((line = br.readLine()) != null) {
          if (line.isBlank()) continue;
          // basic rebrand and drop noise
          if (line.contains("Удочка не найдена") || line.contains("No rod has been found")) continue;
          String branded = line.replace("FishingBot", "MineBot");
          sse.send("log", "{\"level\":\"info\",\"message\":" + JsonMini.q(branded) + ",\"t\":" + System.currentTimeMillis() + "}");

          // crude state hints
          String l = line.toLowerCase();
          if (l.contains("connected")) {
            connecting = false;
            connected = true;
          }
          if (l.contains("spawn") || l.contains("in game") || l.contains("joined")) {
            spawned = true;
          }
          if (l.contains("kicked") || l.contains("disconnect") || l.contains("disconnected")) {
            connecting = false;
            connected = false;
            spawned = false;
          }
        }
      } catch (Exception e) {
        lastError = "log_pump_failed: " + e.getMessage();
      } finally {
        synchronized (BotManager.this) {
          if (proc != null) {
            try {
              int code = proc.exitValue();
              lastExit = "exit_code=" + code;
            } catch (Exception ignored) {}
          }
          proc = null;
          connecting = false;
          connected = false;
          spawned = false;
        }
      }
    }, "minebot-log-pump");
    t.setDaemon(true);
    t.start();
  }

  private void ensureEngineJar(Path runtime, Path jarPath) {
    try {
      if (Files.exists(jarPath) && Files.size(jarPath) > 1_000_000) return;
    } catch (Exception ignored) {}

    // Если уже есть старое имя (FishingBot.jar) — используем его без скачивания.
    try {
      Path legacy = runtime.resolve("FishingBot.jar");
      if (Files.exists(legacy) && Files.size(legacy) > 1_000_000) {
        Files.copy(legacy, jarPath, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
        sse.send("log", "{\"level\":\"info\",\"message\":" + JsonMini.q("Нашёл FishingBot.jar, использую его как MineBot.jar") + ",\"t\":" + System.currentTimeMillis() + "}");
        return;
      }
    } catch (Exception ignored) {}

    // Download latest FishingBot jar as engine fallback (until we ship our own engine jar)
    try {
      String url = "https://github.com/MrKinau/FishingBot/releases/latest/download/FishingBot.jar";
      sse.send("log", "{\"level\":\"warn\",\"message\":" + JsonMini.q("Скачиваю движок в " + jarPath) + ",\"t\":" + System.currentTimeMillis() + "}");
      Path tmp = Path.of(jarPath.toString() + ".download");
      downloadTo(url, tmp);
      long size = Files.size(tmp);
      if (size < 1_000_000) {
        Files.deleteIfExists(tmp);
        lastError = "engine_download_too_small";
        sse.send("log", "{\"level\":\"error\",\"message\":" + JsonMini.q(lastError) + ",\"t\":" + System.currentTimeMillis() + "}");
        return;
      }
      Files.move(tmp, jarPath, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
    } catch (Exception e) {
      lastError = "engine_download_failed: " + e.getMessage();
      sse.send("log", "{\"level\":\"error\",\"message\":" + JsonMini.q(lastError) + ",\"t\":" + System.currentTimeMillis() + "}");
    }
  }

  private static void downloadTo(String urlStr, Path out) throws Exception {
    String cur = urlStr;
    for (int i = 0; i < 6; i++) {
      URL url = new URL(cur);
      HttpURLConnection conn = (HttpURLConnection) url.openConnection();
      conn.setInstanceFollowRedirects(false);
      conn.setRequestProperty("User-Agent", "MineBot");
      conn.setRequestProperty("Accept", "application/octet-stream");
      conn.connect();
      int code = conn.getResponseCode();
      if (code >= 300 && code < 400) {
        String loc = conn.getHeaderField("Location");
        conn.disconnect();
        if (loc == null || loc.isBlank()) throw new IOException("redirect_without_location");
        URL next = new URL(url, loc); // supports relative redirects
        cur = next.toString();
        continue;
      }
      if (code >= 400) {
        conn.disconnect();
        throw new IOException("HTTP " + code);
      }
      try (InputStream is = conn.getInputStream(); OutputStream os = Files.newOutputStream(out)) {
        is.transferTo(os);
      } finally {
        conn.disconnect();
      }
      return;
    }
    throw new IOException("too_many_redirects");
  }

  private static void writeEngineConfig(Settings cfg, Path cfgPath) {
    String versionStr = (cfg.version == null || cfg.version.isBlank() || "auto".equalsIgnoreCase(cfg.version))
      ? "AUTOMATIC"
      : cfg.version;

    String json =
      "{\n" +
      "  \"server\": {\n" +
      "    \"ip\": " + JsonMini.q(cfg.host) + ",\n" +
      "    \"port\": " + cfg.port + ",\n" +
      "    \"online-mode\": false,\n" +
      "    \"default-protocol\": " + JsonMini.q(versionStr) + "\n" +
      "  },\n" +
      "  \"account\": {\n" +
      "    \"mail\": " + JsonMini.q(cfg.username) + "\n" +
      "  },\n" +
      "  \"auto\": { \"auto-reconnect\": false },\n" +
      "  \"logs\": { \"log-packets\": false },\n" +
      "  \"misc\": { \"disable-rod-checking\": true }\n" +
      "}\n";
    try {
      Files.writeString(cfgPath, json, StandardCharsets.UTF_8);
    } catch (Exception ignored) {}
  }
}

