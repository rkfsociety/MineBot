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

fn is_cursor_node(p: &Path) -> bool {
  let s = p.to_string_lossy().to_lowercase();
  // Cursor/VSCode могут подсовывать свой node.exe (без npm), что ломает установку зависимостей.
  s.contains("\\cursor\\") && s.contains("\\resources\\app\\resources\\helpers\\node.exe")
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

fn pick_system_node() -> Option<PathBuf> {
  for p in where_exe("node") {
    if p.exists() && !is_cursor_node(&p) {
      return Some(p);
    }
  }
  None
}

fn pick_system_npm() -> Option<PathBuf> {
  for p in where_exe("npm") {
    if p.exists() {
      return Some(p);
    }
  }
  for p in where_exe("npm.cmd") {
    if p.exists() {
      return Some(p);
    }
  }
  None
}

fn has_node(system_node: &Option<PathBuf>) -> bool {
  let node = match system_node {
    Some(p) => p,
    None => return false,
  };
  Command::new(node)
    .arg("--version")
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null())
    .creation_flags(CREATE_NO_WINDOW)
    .status()
    .map(|s| s.success())
    .unwrap_or(false)
}

fn has_npm(system_npm: &Option<PathBuf>) -> bool {
  let npm = match system_npm {
    Some(p) => p,
    None => return false,
  };
  Command::new(npm)
    .arg("--version")
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null())
    .creation_flags(CREATE_NO_WINDOW)
    .status()
    .map(|s| s.success())
    .unwrap_or(false)
}

fn node_exec_path(system_node: &Option<PathBuf>) -> Option<PathBuf> {
  let node = system_node.as_ref()?;
  let out = Command::new(node)
    .args(["-p", "process.execPath"])
    .stdin(Stdio::null())
    .creation_flags(CREATE_NO_WINDOW)
    .output()
    .ok()?;
  if !out.status.success() {
    return None;
  }
  let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
  if s.is_empty() {
    return None;
  }
  Some(PathBuf::from(s))
}

fn npm_via_node_exists(system_node: &Option<PathBuf>) -> bool {
  // npm обычно поставляется вместе с Node и лежит рядом в:
  // <node_dir>\node_modules\npm\bin\npm-cli.js
  let node = match node_exec_path(system_node) {
    Some(p) => p,
    None => return false,
  };
  let dir = match node.parent() {
    Some(d) => d,
    None => return false,
  };
  dir.join("node_modules")
    .join("npm")
    .join("bin")
    .join("npm-cli.js")
    .exists()
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
  let ok = ps_exec(&script);
  if !ok {
    append_log(app_root, "ensure_app_latest: PowerShell download/extract failed");
  }
}

fn ensure_node_modules(app_root: &Path, system_node: &Option<PathBuf>, system_npm: &Option<PathBuf>) {
  let app_dir = app_root.join("app");
  if !app_dir.exists() {
    append_log(app_root, "ensure_node_modules: app dir missing");
    return;
  }

  // Если уже установлено — ничего не делаем.
  if app_dir.join("node_modules").exists() {
    return;
  }

  // Prefer системный npm, иначе fallback: npm-cli.js рядом с системным node.exe.
  if let Some(npm) = system_npm {
    append_log(app_root, "ensure_node_modules: running npm ci --omit=dev");
    let st = Command::new(npm)
      .current_dir(&app_dir)
      .args(["ci", "--omit=dev"])
      .stdin(Stdio::null())
      .stdout(Stdio::null())
      .stderr(Stdio::null())
      .creation_flags(CREATE_NO_WINDOW)
      .status();
    if st.map(|s| s.success()).unwrap_or(false) {
      append_log(app_root, "ensure_node_modules: npm ci success");
    } else {
      append_log(app_root, "ensure_node_modules: npm ci failed");
    }
    return;
  }

  // Fallback: node + npm-cli.js
  let node = match node_exec_path(system_node) {
    Some(p) => p,
    None => {
      append_log(app_root, "ensure_node_modules: node execPath not found");
      return;
    }
  };
  let node_dir = match node.parent() {
    Some(d) => d.to_path_buf(),
    None => {
      append_log(app_root, "ensure_node_modules: node dir not found");
      return;
    }
  };
  let npm_cli = node_dir
    .join("node_modules")
    .join("npm")
    .join("bin")
    .join("npm-cli.js");
  if !npm_cli.exists() {
    append_log(app_root, "ensure_node_modules: npm-cli.js missing near node.exe");
    return;
  }

  append_log(app_root, "ensure_node_modules: running node <npm-cli.js> ci --omit=dev");
  let st = Command::new(&node)
    .current_dir(&app_dir)
    .arg(npm_cli)
    .args(["ci", "--omit=dev"])
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null())
    .creation_flags(CREATE_NO_WINDOW)
    .status();
  if st.map(|s| s.success()).unwrap_or(false) {
    append_log(app_root, "ensure_node_modules: npm ci success");
  } else {
    append_log(app_root, "ensure_node_modules: npm ci failed");
  }
}

fn start_runner(app_root: &Path, system_node: &Option<PathBuf>) {
  // Если панель уже слушает — не трогаем.
  if is_listening(3847) {
    return;
  }

  let app_dir = app_root.join("app");
  if !app_dir.exists() {
    return;
  }

  let node = match system_node {
    Some(p) => p,
    None => return,
  };
  let mut cmd = Command::new(node);
  cmd.current_dir(&app_dir)
    .arg("runner.js")
    .env("MINEBOT_DATA_DIR", app_root.to_string_lossy().to_string())
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null())
    .creation_flags(CREATE_NO_WINDOW);

  // Не ждём: пусть живёт отдельно, а окно панели само подключится.
  let _ = cmd.spawn();
}

fn main() {
  let app_root = appdata_dir();
  ensure_dir(&app_root);

  let system_node = pick_system_node();
  let system_npm = pick_system_npm();
  let node_ok = has_node(&system_node);
  let npm_ok = has_npm(&system_npm) || npm_via_node_exists(&system_node);

  tauri::Builder::default()
    .setup(move |app| {
      let win = app.get_webview_window("main");

      append_log(
        &app_root,
        &format!(
          "launcher: start node_ok={} npm_ok={} app_root={} node={:?} npm={:?}",
          node_ok,
          npm_ok,
          app_root.to_string_lossy(),
          system_node.as_ref().map(|p| p.to_string_lossy().to_string()),
          system_npm.as_ref().map(|p| p.to_string_lossy().to_string())
        ),
      );

      // Минимальная проверка требований: без node мы не сможем запустить runner.js.
      if !node_ok || !npm_ok {
        if let Some(w) = win {
          let mut missing = vec!["webview2"];
          if !node_ok {
            missing.push("node");
          } else if !npm_ok {
            // Обычно npm ставится вместе с Node, но на практике может отсутствовать.
            missing.push("npm");
          }
          let hash = requirements_hash(&missing);
          let _ = w.eval(&format!(
            "location.replace('requirements.html{}')",
            hash.replace('\'', "%27")
          ));
        }
        return Ok(());
      }

      // Стартуем/обновляем Node-часть и поднимаем runner как можно раньше.
      // Это позволяет редко перекомпилировать Tauri exe: вся логика обновляется в AppData.
      let app_root_bg = app_root.clone();
      let system_node_bg = system_node.clone();
      let system_npm_bg = system_npm.clone();
      thread::spawn(move || {
        ensure_app_latest(&app_root_bg);
        ensure_node_modules(&app_root_bg, &system_node_bg, &system_npm_bg);
        start_runner(&app_root_bg, &system_node_bg);

        // Дадим runner пару секунд поднять панель, чтобы splash быстрее переключился.
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(6) {
          if is_listening(3847) {
            break;
          }
          thread::sleep(Duration::from_millis(200));
        }
      });

      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

