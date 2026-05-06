#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;

use std::{
  env,
  fs,
  io::Write,
  net::TcpStream,
  os::windows::process::CommandExt,
  path::{Path, PathBuf},
  process::{Command, Stdio},
  thread,
  time::{Duration, Instant},
};

const CREATE_NO_WINDOW: u32 = 0x08000000;

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
    .creation_flags(CREATE_NO_WINDOW)
    .status()
    .map(|s| s.success())
    .unwrap_or(false)
}

fn where_exe(name: &str) -> Vec<PathBuf> {
  let out = Command::new("where.exe")
    .arg(name)
    .stdin(Stdio::null())
    .creation_flags(CREATE_NO_WINDOW)
    .output();
  let out = match out {
    Ok(o) => o,
    Err(_) => return vec![],
  };
  if !out.status.success() {
    return vec![];
  }
  let text = String::from_utf8_lossy(&out.stdout);
  text
    .lines()
    .map(|l| l.trim())
    .filter(|l| !l.is_empty())
    .map(PathBuf::from)
    .collect()
}

fn pick_system_java() -> Option<PathBuf> {
  for p in where_exe("java") {
    if p.exists() {
      return Some(p);
    }
  }
  None
}

fn has_java(system_java: &Option<PathBuf>) -> bool {
  let java = match system_java {
    Some(p) => p,
    None => return false,
  };
  Command::new(java)
    .arg("-version")
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null())
    .creation_flags(CREATE_NO_WINDOW)
    .status()
    .map(|s| s.success())
    .unwrap_or(false)
}

fn requirements_hash(missing: &[&str]) -> String {
  // Передаём список через hash, чтобы не плодить IPC.
  // Пример: #missing=node,webview2
  let mut s = String::from("#missing=");
  s.push_str(&missing.join(","));
  s
}

fn append_log(app_root: &Path, line: &str) {
  let updates = app_root.join("updates");
  ensure_dir(&updates);
  let p = updates.join("launcher.log");
  if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(p) {
    let _ = writeln!(f, "{}", line);
  }
}

fn ps_output(script: &str) -> Option<String> {
  let out = Command::new("powershell.exe")
    .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script])
    .stdin(Stdio::null())
    .stderr(Stdio::null())
    .creation_flags(CREATE_NO_WINDOW)
    .output()
    .ok()?;
  if !out.status.success() {
    return None;
  }
  Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn kill_listeners_win32(ports: &[u16]) {
  if ports.is_empty() {
    return;
  }
  let list = ports
    .iter()
    .map(|p| p.to_string())
    .collect::<Vec<_>>()
    .join(",");
  let script = format!(
    "$ErrorActionPreference='SilentlyContinue'; \
     $ports=@({list}); \
     foreach($pt in $ports) {{ \
       $lines=(netstat -ano | Select-String (':' + $pt) | Select-String 'LISTENING'); \
       foreach($ln in $lines) {{ \
         $pid=($ln.ToString() -split '\\\\s+')[-1]; \
         if($pid -match '^\\\\d+$') {{ Stop-Process -Id ([int]$pid) -Force -ErrorAction SilentlyContinue }} \
       }} \
     }};"
  );
  let _ = ps_exec(&script);
}

fn ensure_server_latest(app_root: &Path) -> bool {
  // Скачиваем jar из Releases. Если изменился — заменяем и просим рестарт.
  let updates = app_root.join("updates");
  ensure_dir(&updates);

  let jar_dst = app_root.join("app").join("MineBotServer.jar");
  let jar_tmp = updates.join("MineBotServer.jar.download");

  let dst = jar_dst.to_string_lossy().replace('\'', "''");
  let tmp = jar_tmp.to_string_lossy().replace('\'', "''");
  let url = "https://github.com/rkfsociety/MineBot/releases/latest/download/MineBotServer.jar";

  let script = format!(
    "$ErrorActionPreference='Stop'; \
     $tmp='{tmp}'; $dst='{dst}'; \
     Invoke-WebRequest -UseBasicParsing -Uri '{url}' -OutFile $tmp; \
     $new=(Get-FileHash -Algorithm SHA256 -Path $tmp).Hash; \
     $old=''; if (Test-Path $dst) {{ $old=(Get-FileHash -Algorithm SHA256 -Path $dst).Hash }}; \
     if ($old -ne $new) {{ \
       if (!(Test-Path (Split-Path -Parent $dst))) {{ New-Item -ItemType Directory -Force (Split-Path -Parent $dst) | Out-Null }}; \
       Move-Item -Force $tmp $dst; \
       Write-Output 'updated'; \
     }} else {{ Remove-Item -Force $tmp; Write-Output 'same'; }}"
  );

  match ps_output(&script).as_deref() {
    Some("updated") => {
      append_log(app_root, "ensure_server_latest: updated MineBotServer.jar");
      true
    }
    Some("same") => false,
    _ => {
      append_log(app_root, "ensure_server_latest: download failed");
      false
    }
  }
}

fn ensure_app_latest(app_root: &Path) {
  // Минимальная логика: если app/ отсутствует — качаем main.zip и распаковываем.
  // Дальше обновлением будет заниматься панель/раннер (в AppData), без перекомпиляции Tauri.
  let app_dir = app_root.join("app");
  // Новый режим: серверный jar лежит в app/MineBotServer.jar (обновляется из Releases).
  if app_dir.join("MineBotServer.jar").exists() {
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
  let ok = ps_exec(&script);
  if !ok {
    append_log(app_root, "ensure_app_latest: PowerShell download/extract failed");
  }
}

fn start_java_server(app_root: &Path, system_java: &Option<PathBuf>) {
  // Если панель уже слушает — не трогаем.
  if is_listening(3847) {
    return;
  }

  let java = match system_java {
    Some(p) => p,
    None => return,
  };

  let jar = app_root.join("app").join("MineBotServer.jar");
  if !jar.exists() {
    append_log(app_root, "start_java_server: MineBotServer.jar missing");
    return;
  }

  let mut cmd = Command::new(java);
  cmd.arg("-jar")
    .arg(jar.to_string_lossy().to_string())
    .env("MINEBOT_PORT", "3847")
    .env("MINEBOT_DATA_DIR", app_root.to_string_lossy().to_string())
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null())
    .creation_flags(CREATE_NO_WINDOW);

  let _ = cmd.spawn();
}

fn main() {
  let app_root = appdata_dir();
  ensure_dir(&app_root);

  let system_java = pick_system_java();
  let java_ok = has_java(&system_java);

  tauri::Builder::default()
    .setup(move |app| {
      let win = app.get_webview_window("main");

      append_log(
        &app_root,
        &format!(
          "launcher: start java_ok={} app_root={} java={:?}",
          java_ok,
          app_root.to_string_lossy(),
          system_java.as_ref().map(|p| p.to_string_lossy().to_string()),
        ),
      );

      // Минимальная проверка требований: без Java мы не сможем запустить MineBotServer.jar.
      if !java_ok {
        if let Some(w) = win {
          let mut missing = vec!["webview2"];
          missing.push("java");
          let hash = requirements_hash(&missing);
          let _ = w.eval(&format!(
            "location.replace('requirements.html{}')",
            hash.replace('\'', "%27")
          ));
        }
        return Ok(());
      }

      // Стартуем/обновляем Java-сервер как можно раньше.
      let app_root_bg = app_root.clone();
      let system_java_bg = system_java.clone();
      thread::spawn(move || {
        // 1) Гарантируем, что код есть (fallback: main.zip)
        ensure_app_latest(&app_root_bg);
        // 2) Однократный апдейт при старте.
        let updated = ensure_server_latest(&app_root_bg);
        if updated {
          kill_listeners_win32(&[3847]);
        }
        start_java_server(&app_root_bg, &system_java_bg);

        // Дадим серверу пару секунд поднять панель, чтобы splash быстрее переключился.
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(6) {
          if is_listening(3847) {
            break;
          }
          thread::sleep(Duration::from_millis(200));
        }

        // Проверку обновлений делаем только при запуске (без постоянного опроса).
      });

      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

