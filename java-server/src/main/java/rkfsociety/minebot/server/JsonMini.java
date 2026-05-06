package rkfsociety.minebot.server;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

final class JsonMini {
  private JsonMini() {}

  static String q(String s) {
    if (s == null) s = "";
    return "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
  }

  static String getString(String json, String key, String def) {
    String v = matchGroup(json, "\""+Pattern.quote(key)+"\"\\s*:\\s*\"([^\"]*)\"");
    if (v == null) return def;
    return v.replace("\\\"", "\"").replace("\\\\", "\\");
  }

  static int getInt(String json, String key, int def) {
    String v = matchGroup(json, "\""+Pattern.quote(key)+"\"\\s*:\\s*(\\d+)");
    if (v == null) return def;
    try { return Integer.parseInt(v); } catch (Exception e) { return def; }
  }

  static boolean getBool(String json, String key, boolean def) {
    String v = matchGroup(json, "\""+Pattern.quote(key)+"\"\\s*:\\s*(true|false)");
    if (v == null) return def;
    return "true".equalsIgnoreCase(v);
  }

  static String matchGroup(String s, String regex) {
    if (s == null) return null;
    Matcher m = Pattern.compile(regex, Pattern.CASE_INSENSITIVE | Pattern.MULTILINE).matcher(s);
    if (!m.find()) return null;
    return m.group(1);
  }
}

