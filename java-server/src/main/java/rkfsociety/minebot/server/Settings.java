package rkfsociety.minebot.server;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

final class Settings {
  String host = "localhost";
  int port = 25565;
  String username = "tester";
  String version = "auto";
  String password = "";
  boolean registerFirst = false;

  static Settings load(Path p) {
    Settings s = new Settings();
    try {
      if (!Files.exists(p)) return s;
      String raw = Files.readString(p, StandardCharsets.UTF_8);
      s.host = JsonMini.getString(raw, "host", s.host);
      s.port = JsonMini.getInt(raw, "port", s.port);
      s.username = JsonMini.getString(raw, "username", s.username);
      s.version = JsonMini.getString(raw, "version", s.version);
      s.password = JsonMini.getString(raw, "password", s.password);
      s.registerFirst = JsonMini.getBool(raw, "registerFirst", s.registerFirst);
    } catch (Exception ignored) {}
    return s;
  }

  void save(Path p) {
    String json = toJson(true);
    Path tmp = Path.of(p.toString() + ".tmp");
    try {
      Files.writeString(tmp, json, StandardCharsets.UTF_8);
      Files.move(tmp, p, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
    } catch (Exception ignored) {}
  }

  String toJson(boolean includePassword) {
    StringBuilder sb = new StringBuilder();
    sb.append("{");
    sb.append("\"host\":").append(JsonMini.q(host)).append(",");
    sb.append("\"port\":").append(port).append(",");
    sb.append("\"username\":").append(JsonMini.q(username)).append(",");
    sb.append("\"version\":").append(JsonMini.q(version)).append(",");
    sb.append("\"registerFirst\":").append(registerFirst).append(",");
    sb.append("\"hasPassword\":").append(password != null && !password.isEmpty());
    if (includePassword) {
      sb.append(",\"password\":").append(JsonMini.q(password == null ? "" : password));
    }
    sb.append("}");
    return sb.toString();
  }
}

