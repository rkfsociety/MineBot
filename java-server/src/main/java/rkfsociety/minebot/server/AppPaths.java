package rkfsociety.minebot.server;

import java.nio.file.Files;
import java.nio.file.Path;

final class AppPaths {
  private AppPaths() {}

  static Path appRoot() {
    String appdata = System.getenv("APPDATA");
    if (appdata != null && !appdata.trim().isEmpty()) {
      return Path.of(appdata).resolve("MineBot");
    }
    // fallback
    return Path.of(".").resolve(".minebot-data");
  }

  static Path ensureDir(Path p) {
    try {
      Files.createDirectories(p);
    } catch (Exception ignored) {}
    return p;
  }

  static Path settingsPath() {
    return ensureDir(appRoot()).resolve("settings.local.json");
  }

  static Path runtimeDir() {
    return ensureDir(appRoot().resolve("runtime"));
  }

  static Path logsDir() {
    return ensureDir(appRoot().resolve("logs"));
  }
}

