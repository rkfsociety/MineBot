#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
  env,
  fs,
  net::TcpStream,
  path::{Path, PathBuf},
  process::{Command, Stdio},
  thread,
  time::{Duration, Instant},
};

fn appdata_dir() -> PathBuf {
  if let Ok(v) = env::var("APPDATA") {
    if !v.trim().is_empty() {
      return PathBuf::from(v).join("MineBot");
    }
  }
  // fallback: рядом с exe (на всякий случай)
  env::current_exe()
    .ok()
    .and_then(|p| p.parent().map(|d| d.to_path_buf()))
    .unwrap_or_else(|| PathBuf::from("."))
    .join(".minebot-data")
}

fn ensure_dir(p: &Path) {
  let _ = fs::create_dir_all(p);
}

fn is_listening(port: u16) -> bool {
  TcpStream::connect_timeout(
    &format!("127.0.0.1:{}", port).parse().unwrap(),
    Duration::from_millis(200),
  )
  .is_ok()
}

fn ps_exec(script: &str) -> bool {
  Command::new("powershell.exe")
    .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script])
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null())
    .status()
    .map(|s| s.success())
    .unwrap_or(false)
}

fn ensure_app_latest(app_root: &Path) {
  // Минимальная логика: если app/ отсутствует — качаем main.zip и распаковываем.
  // Дальше обновлением будет заниматься панель/раннер (в AppData), без перекомпиляции Tauri.
  let app_dir = app_root.join("app");
  if app_dir.join("runner.js").exists() && app_dir.join("panelServer.js").exists() {
    return;
  }

  let updates = app_root.join("updates");
  ensure_dir(&updates);
  let zip_path = updates.join("main.zip");
  let tmp_dir = updates.join("app-tmp");

  let zip = zip_path.to_string_lossy().replace('\'', "''");
  let tmp = tmp_dir.to_string_lossy().replace('\'', "''");
  let root = app_dir.to_string_lossy().replace('\'', "''");

  // Берём код с GitHub без git: zip-архив ветки main.
  // Распаковываем во временную папку, затем переносим содержимое в %APPDATA%\MineBot\app.
  let script = format!(
    "$ErrorActionPreference='Stop'; \
     $zip='{zip}'; $tmp='{tmp}'; $dst='{root}'; \
     if (Test-Path $tmp) {{ Remove-Item -Recurse -Force $tmp }}; \
     if (Test-Path $dst) {{ Remove-Item -Recurse -Force $dst }}; \
     Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/rkfsociety/MineBot/archive/refs/heads/main.zip' -OutFile $zip; \
     Expand-Archive -Force -Path $zip -DestinationPath $tmp; \
     $src = Join-Path $tmp 'MineBot-main'; \
     Move-Item -Force $src $dst; \
     Remove-Item -Force $zip; \
     if (Test-Path $tmp) {{ Remove-Item -Recurse -Force $tmp }};"
  );
  let _ = ps_exec(&script);
}

fn start_runner(app_root: &Path) {
  // Если панель уже слушает — не трогаем.
  if is_listening(3847) {
    return;
  }

  let app_dir = app_root.join("app");
  if !app_dir.exists() {
    return;
  }

  let mut cmd = Command::new("node");
  cmd.current_dir(&app_dir)
    .arg("runner.js")
    .env("MINEBOT_DATA_DIR", app_root.to_string_lossy().to_string())
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null());

  // Не ждём: пусть живёт отдельно, а окно панели само подключится.
  let _ = cmd.spawn();
}

fn main() {
  let app_root = appdata_dir();
  ensure_dir(&app_root);

  // Стартуем/обновляем Node-часть и поднимаем runner как можно раньше.
  // Это позволяет редко перекомпилировать Tauri exe: вся логика обновляется в AppData.
  {
    let app_root_bg = app_root.clone();
    thread::spawn(move || {
      ensure_app_latest(&app_root_bg);
      start_runner(&app_root_bg);

      // Дадим runner пару секунд поднять панель, чтобы splash быстрее переключился.
      let start = Instant::now();
      while start.elapsed() < Duration::from_secs(6) {
        if is_listening(3847) {
          break;
        }
        thread::sleep(Duration::from_millis(200));
      }
    });
  }

  tauri::Builder::default()
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

