package rkfsociety.minebot.server;

import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;

final class UpdateManager {
  private UpdateManager() {}

  static final String LATEST_RELEASE_API = "https://api.github.com/repos/rkfsociety/MineBot/releases/latest";
  static final String SERVER_JAR_URL = "https://github.com/rkfsociety/MineBot/releases/latest/download/MineBot.jar";

  static Path serverJarPath() {
    // Для пользователя это главный файл: MineBot.jar.
    return AppPaths.appDir().resolve("MineBot.jar");
  }

  static String currentSha256OrNull(Path p) {
    try {
      if (!Files.exists(p)) return null;
      return sha256Hex(Files.readAllBytes(p));
    } catch (Exception e) {
      return null;
    }
  }

  static String fetchLatestTagOrNull() {
    try {
      String json = httpGetText(LATEST_RELEASE_API);
      return JsonMini.matchGroup(json, "\"tag_name\"\\s*:\\s*\"([^\"]+)\"");
    } catch (Exception e) {
      return null;
    }
  }

  static CheckResult check() {
    Path jar = serverJarPath();
    String sha = currentSha256OrNull(jar);
    String tag = fetchLatestTagOrNull();
    return new CheckResult(true, jar.toString(), sha, tag, null);
  }

  static ApplyResult applyAndRelaunch(int port) {
    Path jarDst = serverJarPath();
    Path tmp = jarDst.resolveSibling("MineBot.jar.download");
    try {
      downloadTo(SERVER_JAR_URL, tmp);
      if (!Files.exists(tmp) || Files.size(tmp) < 50_000) {
        return new ApplyResult(false, "download_too_small", null);
      }
      String newSha = sha256Hex(Files.readAllBytes(tmp));
      String oldSha = currentSha256OrNull(jarDst);
      boolean changed = oldSha == null || !oldSha.equalsIgnoreCase(newSha);
      if (!changed) {
        Files.deleteIfExists(tmp);
        return new ApplyResult(true, null, false);
      }
      Files.move(tmp, jarDst, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
      relaunchAndExit(port, jarDst);
      return new ApplyResult(true, null, true);
    } catch (Exception e) {
      try { Files.deleteIfExists(tmp); } catch (Exception ignored) {}
      return new ApplyResult(false, e.getMessage(), null);
    }
  }

  private static void relaunchAndExit(int port, Path jar) throws IOException {
    String javaBin = Path.of(System.getProperty("java.home")).resolve("bin").resolve("java.exe").toString();
    // Нельзя стартовать сразу — порт ещё занят. Стартуем через cmd с небольшой задержкой.
    String cmd = "timeout /t 1 >nul & \"" + javaBin + "\" -jar \"" + jar.toString() + "\"";
    new ProcessBuilder("cmd.exe", "/c", cmd)
      .redirectErrorStream(true)
      .start();
    // Дадим ответ клиенту, затем выходим.
    new Thread(() -> {
      try { Thread.sleep(300); } catch (InterruptedException ignored) {}
      System.exit(0);
    }, "minebot-self-restart").start();
  }

  private static String httpGetText(String urlStr) throws Exception {
    URL url = new URL(urlStr);
    HttpURLConnection conn = (HttpURLConnection) url.openConnection();
    conn.setInstanceFollowRedirects(false);
    conn.setRequestProperty("User-Agent", "MineBot");
    conn.setRequestProperty("Accept", "application/vnd.github+json");
    conn.connect();
    int code = conn.getResponseCode();
    if (code >= 400) throw new IOException("HTTP " + code);
    try (InputStream is = conn.getInputStream()) {
      return new String(is.readAllBytes(), StandardCharsets.UTF_8);
    } finally {
      conn.disconnect();
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
        URL next = new URL(url, loc);
        cur = next.toString();
        continue;
      }
      if (code >= 400) {
        conn.disconnect();
        throw new IOException("HTTP " + code);
      }
      try (InputStream is = conn.getInputStream()) {
        Files.copy(is, out, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
      } finally {
        conn.disconnect();
      }
      return;
    }
    throw new IOException("too_many_redirects");
  }

  private static String sha256Hex(byte[] bytes) throws Exception {
    MessageDigest md = MessageDigest.getInstance("SHA-256");
    byte[] dig = md.digest(bytes);
    StringBuilder sb = new StringBuilder(dig.length * 2);
    for (byte b : dig) sb.append(String.format("%02x", b));
    return sb.toString();
  }

  record CheckResult(boolean ok, String jarPath, String sha256, String latestTag, String error) {}
  record ApplyResult(boolean ok, String error, Boolean updated) {}
}

