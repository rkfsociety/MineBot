'use strict'

const express = require('express')
const path = require('path')
const config = require('./config')
const https = require('https')
const { execFile } = require('child_process')
const { getDataDir } = require('./lib/paths')
const { repairMineBotPortsWin32 } = require('./lib/portRepair')
const fs = require('fs')

const PANEL_RESTART_CODE = 42
const FULL_RESTART_CODE = 43
const GITHUB_RAW_PACKAGE_JSON =
  'https://raw.githubusercontent.com/rkfsociety/MineBot/main/package.json'

const webCfg = (config && config.web) || {}
const host = process.env.WEB_HOST || webCfg.host || '127.0.0.1'
const port = parseInt(process.env.WEB_PORT || String(webCfg.port ?? 3847), 10)

const app = express()
app.use(express.json({ limit: '8kb' }))

const publicDir = path.join(__dirname, 'public')
const indexFile = path.join(publicDir, 'index.html')

function sendIndex(_req, res) {
  res.sendFile(indexFile)
}

app.get('/', sendIndex)
app.get('/home', sendIndex)

function readLocalVersion() {
  try {
    // В dev режиме читаем из проекта.
    // В packaged (asar) это тоже доступно как файл рядом, если он включён.
    // eslint-disable-next-line global-require
    const pkg = require('./package.json')
    return String((pkg && pkg.version) || '0.0.0')
  } catch {
    return '0.0.0'
  }
}

function parseSemver(v) {
  const m = String(v || '').trim().match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/)
  if (!m) return null
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)]
}

function cmpSemver(a, b) {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  if (!pa || !pb) return 0
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1
    if (pa[i] < pb[i]) return -1
  }
  return 0
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}`))
          res.resume()
          return
        }
        let data = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (data += c))
        res.on('end', () => {
          try {
            resolve(JSON.parse(data))
          } catch (e) {
            reject(e)
          }
        })
      })
      .on('error', reject)
  })
}

function fetchJsonWithHeaders(url, headers) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers }, (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}`))
          res.resume()
          return
        }
        let data = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (data += c))
        res.on('end', () => {
          try {
            resolve(JSON.parse(data))
          } catch (e) {
            reject(e)
          }
        })
      })
      .on('error', reject)
  })
}

function downloadToFile(url, filePath, headers) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(filePath)
    https
      .get(url, { headers }, (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}`))
          res.resume()
          return
        }
        res.pipe(out)
        out.on('finish', () => out.close(() => resolve()))
      })
      .on('error', (e) => {
        try { out.close() } catch {}
        reject(e)
      })
  })
}

function spawnDetachedPwsh(scriptPath) {
  try {
    const { spawn } = require('child_process')
    const p = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      { detached: true, stdio: 'ignore', windowsHide: true },
    )
    p.unref()
    return true
  } catch {
    return false
  }
}

function getAppDir() {
  return __dirname
}

function parseTagVersion(tag) {
  const raw = String(tag || '').trim()
  const m = raw.match(/v?(\d+\.\d+\.\d+)/)
  return m ? m[1] : null
}

const GITHUB_REPO = 'rkfsociety/MineBot'
const GITHUB_RELEASES_LATEST = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`

app.get('/api/version', (_req, res) => {
  res.json({ version: readLocalVersion(), dataDir: getDataDir() })
})

app.get('/api/update/check', async (_req, res) => {
  const localV = readLocalVersion()
  try {
    const remotePkg = await fetchJson(GITHUB_RAW_PACKAGE_JSON)
    const remoteV = String((remotePkg && remotePkg.version) || '0.0.0')
    const cmp = cmpSemver(localV, remoteV)
    res.json({
      ok: true,
      local: localV,
      remote: remoteV,
      updateAvailable: cmp < 0,
      reason: cmp < 0 ? 'remote_newer' : cmp > 0 ? 'local_newer' : 'same',
    })
  } catch (e) {
    res.status(502).json({
      ok: false,
      local: localV,
      error: e instanceof Error ? e.message : String(e),
    })
  }
})

// Обновление AppData-кода (панель+бот) без обновления exe:
// скачиваем zip ветки main, заменяем %APPDATA%\MineBot\app и перезапускаем runner.
app.post('/api/app/update/apply', async (_req, res) => {
  if (process.platform !== 'win32') {
    res.status(400).json({ ok: false, error: 'unsupported_platform' })
    return
  }

  const localV = readLocalVersion()
  let remoteV = null
  try {
    const remotePkg = await fetchJson(GITHUB_RAW_PACKAGE_JSON)
    remoteV = String((remotePkg && remotePkg.version) || '0.0.0')
    const cmp = cmpSemver(localV, remoteV)
    if (cmp >= 0) {
      res.json({ ok: true, updated: false, local: localV, remote: remoteV })
      return
    }

    const dataDir = getDataDir()
    const updatesDir = path.join(dataDir, 'updates')
    fs.mkdirSync(updatesDir, { recursive: true })

    const ps1 = path.join(updatesDir, 'apply-app-update.ps1')
    const zip = path.join(updatesDir, `main-${remoteV}.zip`)
    const tmp = path.join(updatesDir, `app-tmp-${remoteV}`)
    const appDir = getAppDir()
    const appNew = path.join(updatesDir, `app-new-${remoteV}`)

    const script = `
$ErrorActionPreference = 'Stop'
$zip = "${zip.replace(/"/g, '""')}"
$tmp = "${tmp.replace(/"/g, '""')}"
$appNew = "${appNew.replace(/"/g, '""')}"
$appDir = "${appDir.replace(/"/g, '""')}"
$dataDir = "${dataDir.replace(/"/g, '""')}"

try { if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp } } catch {}
try { if (Test-Path $appNew) { Remove-Item -Recurse -Force $appNew } } catch {}

Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/rkfsociety/MineBot/archive/refs/heads/main.zip" -OutFile $zip
Expand-Archive -Force -Path $zip -DestinationPath $tmp
Move-Item -Force (Join-Path $tmp "MineBot-main") $appNew

# Останавливаем наши процессы (панель+бот), затем заменяем app и запускаем runner.
$ports = @(3847,3848)
foreach ($pt in $ports) {
  $lines = (netstat -ano | Select-String (':' + $pt) | Select-String 'LISTENING')
  foreach ($ln in $lines) {
    $p = ($ln.ToString() -split '\\s+')[-1]
    if ($p -match '^\\d+$') { try { Stop-Process -Id ([int]$p) -Force } catch {} }
  }
}
Start-Sleep -Milliseconds 700

try { if (Test-Path $appDir) { Remove-Item -Recurse -Force $appDir } } catch {}
Move-Item -Force $appNew $appDir

try { Remove-Item -Force $zip } catch {}
try { if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp } } catch {}

# Запускаем runner, передав MINEBOT_DATA_DIR через переменную окружения.
$env:MINEBOT_DATA_DIR = $dataDir
Start-Process -WindowStyle Hidden -WorkingDirectory $appDir -FilePath "node" -ArgumentList "runner.js"
`
    fs.writeFileSync(ps1, script, 'utf8')

    const ok = spawnDetachedPwsh(ps1)
    if (!ok) {
      res.status(500).json({ ok: false, error: 'spawn_failed' })
      return
    }

    res.json({ ok: true, updated: true, localBefore: localV, remote: remoteV })
    // Процесс панели скоро будет убит скриптом — runner поднимется заново.
  } catch (e) {
    res.status(500).json({
      ok: false,
      local: localV,
      remote: remoteV,
      error: e instanceof Error ? e.message : String(e),
    })
  }
})

function hasGitRepo() {
  try {
    const fs = require('fs')
    return fs.existsSync(path.join(__dirname, '.git'))
  } catch {
    return false
  }
}

function gitPullFfOnly() {
  return new Promise((resolve, reject) => {
    execFile('git', ['pull', '--ff-only'], { cwd: __dirname, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error((stderr || stdout || err.message || 'git pull failed').toString()))
      } else {
        resolve(String(stdout || '').trim())
      }
    })
  })
}

app.post('/api/update/apply', async (_req, res) => {
  const localV = readLocalVersion()
  let remoteV = null
  try {
    const remotePkg = await fetchJson(GITHUB_RAW_PACKAGE_JSON)
    remoteV = String((remotePkg && remotePkg.version) || '0.0.0')
    const cmp = cmpSemver(localV, remoteV)
    if (cmp >= 0) {
      res.json({ ok: true, updated: false, local: localV, remote: remoteV })
      return
    }

    if (!hasGitRepo()) {
      res.status(400).json({
        ok: false,
        error: 'no_git_repo',
        message:
          'Авто-обновление без релизов работает только из git-клона. В exe-сборке обновляйте, заменив папку приложения на новую.',
        local: localV,
        remote: remoteV,
      })
      return
    }

    const out = await gitPullFfOnly()
    res.json({ ok: true, updated: true, localBefore: localV, remote: remoteV, git: out })
    // Полный рестарт: runner перезапустит и панель, и botService (обновится код).
    setTimeout(() => process.exit(FULL_RESTART_CODE), 200)
  } catch (e) {
    res.status(500).json({
      ok: false,
      local: localV,
      remote: remoteV,
      error: e instanceof Error ? e.message : String(e),
    })
  }
})

// Обновление по GitHub Releases (для exe).
app.get('/api/update/release/check', async (_req, res) => {
  const localV = readLocalVersion()
  try {
    const j = await fetchJsonWithHeaders(GITHUB_RELEASES_LATEST, {
      'User-Agent': 'MineBot',
      Accept: 'application/vnd.github+json',
    })
    const remoteV = parseTagVersion(j && j.tag_name) || '0.0.0'
    const cmp = cmpSemver(localV, remoteV)
    res.json({
      ok: true,
      local: localV,
      remote: remoteV,
      updateAvailable: cmp < 0,
      reason: cmp < 0 ? 'remote_newer' : cmp > 0 ? 'local_newer' : 'same',
      assets: Array.isArray(j && j.assets) ? j.assets.map((a) => ({ name: a.name, size: a.size })) : [],
    })
  } catch (e) {
    res.status(502).json({ ok: false, local: localV, error: e instanceof Error ? e.message : String(e) })
  }
})

app.post('/api/update/release/apply', async (_req, res) => {
  const localV = readLocalVersion()
  const exePath = process.env.MINEBOT_EXE_PATH
  const electronPid = parseInt(process.env.MINEBOT_ELECTRON_PID || '0', 10)
  if (!exePath || !electronPid) {
    res.status(400).json({ ok: false, error: 'not_running_in_exe' })
    return
  }
  try {
    const rel = await fetchJsonWithHeaders(GITHUB_RELEASES_LATEST, {
      'User-Agent': 'MineBot',
      Accept: 'application/vnd.github+json',
    })
    const remoteV = parseTagVersion(rel && rel.tag_name) || '0.0.0'
    const cmp = cmpSemver(localV, remoteV)
    if (cmp >= 0) {
      res.json({ ok: true, updated: false, local: localV, remote: remoteV })
      return
    }

    const assets = Array.isArray(rel && rel.assets) ? rel.assets : []
    const asset =
      assets.find((a) => a && typeof a.name === 'string' && a.name.toLowerCase() === 'minebot.exe') ||
      assets.find((a) => a && typeof a.name === 'string' && a.name.toLowerCase().includes('minebot') && a.name.toLowerCase().endsWith('.exe'))
    if (!asset || !asset.browser_download_url) {
      res.status(404).json({ ok: false, error: 'no_exe_asset' })
      return
    }

    const updatesDir = path.join(getDataDir(), 'updates')
    fs.mkdirSync(updatesDir, { recursive: true })
    const tmpExe = path.join(updatesDir, `MineBot-${remoteV}.exe.download`)
    const finalExe = path.join(updatesDir, `MineBot-${remoteV}.exe`)

    await downloadToFile(asset.browser_download_url, tmpExe, { 'User-Agent': 'MineBot' })
    fs.renameSync(tmpExe, finalExe)

    // Стартуем updater в фоне: убивает текущий exe, заменяет, запускает новый.
    const ps1 = path.join(updatesDir, 'apply-update.ps1')
    const script = `
$pid = ${electronPid}
$target = "${exePath.replace(/"/g, '""')}"
$new = "${finalExe.replace(/"/g, '""')}"
try { Stop-Process -Id $pid -Force } catch {}
try { Wait-Process -Id $pid -Timeout 15 } catch {}
try { Copy-Item -Force $new $target } catch {}
Start-Process -FilePath $target
`
    fs.writeFileSync(ps1, script, 'utf8')
    execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1], { windowsHide: true })

    res.json({ ok: true, updated: true, localBefore: localV, remote: remoteV })
  } catch (e) {
    res.status(500).json({ ok: false, local: localV, error: e instanceof Error ? e.message : String(e) })
  }
})

// Перезапуск только панели (runner её поднимет заново).
app.post('/api/panel/restart', (_req, res) => {
  res.json({ ok: true })
  setTimeout(() => process.exit(PANEL_RESTART_CODE), 150)
})

// Починка "порты заняты": убиваем только старые процессы MineBot, затем полный рестарт.
app.post('/api/repair', async (_req, res) => {
  try {
    if (process.platform === 'win32') {
      const r = await repairMineBotPortsWin32([3847, 3848])
      res.json({ ok: true, killedPids: r.killedPids || [] })
    } else {
      res.status(400).json({ ok: false, error: 'unsupported_platform' })
      return
    }
  } catch (e) {
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) })
    return
  }
  setTimeout(() => process.exit(FULL_RESTART_CODE), 200)
})

app.use(express.static(publicDir, { index: false }))

app.listen(port, host, () => {
  const openHost = host === '0.0.0.0' ? '127.0.0.1' : host
  console.log(`Панель: http://${openHost}:${port}/home`)
})

