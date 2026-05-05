'use strict'

const fs = require('fs')
const path = require('path')
const https = require('https')
const { spawn } = require('child_process')
const AdmZip = require('adm-zip')

const APP_NAME = 'MineBot'
const REPO = 'rkfsociety/MineBot'
const RELEASES_LATEST = `https://api.github.com/repos/${REPO}/releases/latest`

function dataDir() {
  const appdata = process.env.APPDATA
  if (appdata && String(appdata).trim()) return path.join(String(appdata).trim(), APP_NAME)
  return path.join(process.cwd(), '.minebot-data')
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true })
}

function logPath() {
  const dir = path.join(dataDir(), 'logs')
  ensureDir(dir)
  return path.join(dir, 'launcher.log')
}

function appendLog(line) {
  try {
    fs.appendFileSync(logPath(), `[${new Date().toISOString()}] ${line}\r\n`, 'utf8')
  } catch {}
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(
        url,
        {
          headers: {
            'User-Agent': APP_NAME,
            Accept: 'application/vnd.github+json',
          },
        },
        (res) => {
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
        },
      )
      .on('error', reject)
  })
}

function downloadToFile(url, filePath) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(filePath)
    https
      .get(
        url,
        { headers: { 'User-Agent': APP_NAME } },
        (res) => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}`))
            res.resume()
            return
          }
          res.pipe(out)
          out.on('finish', () => out.close(() => resolve()))
        },
      )
      .on('error', (e) => {
        try {
          out.close()
        } catch {}
        reject(e)
      })
  })
}

function parseTagVersion(tag) {
  const raw = String(tag || '').trim()
  const m = raw.match(/v?(\d+\.\d+\.\d+)/)
  return m ? m[1] : null
}

function runtimeDir(version) {
  const dir = path.join(dataDir(), 'runtime', String(version))
  ensureDir(dir)
  return dir
}

function runtimeExePath(version) {
  return path.join(runtimeDir(version), 'MineBot.exe')
}

function isRuntimeInstalled(version) {
  try {
    return fs.existsSync(runtimeExePath(version))
  } catch {
    return false
  }
}

async function ensureRuntimeLatest() {
  const rel = await fetchJson(RELEASES_LATEST)
  const version = parseTagVersion(rel && rel.tag_name)
  if (!version) throw new Error('bad_release_tag')

  if (isRuntimeInstalled(version)) return { version, installed: true }

  const assets = Array.isArray(rel && rel.assets) ? rel.assets : []
  const zipAsset =
    assets.find((a) => a && typeof a.name === 'string' && a.name.toLowerCase() === 'minebot-win32-x64.zip') ||
    assets.find((a) => a && typeof a.name === 'string' && a.name.toLowerCase().endsWith('.zip') && a.name.toLowerCase().includes('win32'))
  if (!zipAsset || !zipAsset.browser_download_url) throw new Error('no_runtime_zip')

  const updates = path.join(dataDir(), 'updates')
  ensureDir(updates)
  const zipTmp = path.join(updates, `runtime-${version}.zip.download`)
  const zipFinal = path.join(updates, `runtime-${version}.zip`)

  appendLog(`Downloading runtime zip ${version}`)
  await downloadToFile(zipAsset.browser_download_url, zipTmp)
  fs.renameSync(zipTmp, zipFinal)

  appendLog(`Extracting runtime to ${runtimeDir(version)}`)
  const zip = new AdmZip(zipFinal)
  zip.extractAllTo(runtimeDir(version), true)

  // В архиве у нас лежит содержимое папки, включая MineBot.exe.
  if (!isRuntimeInstalled(version)) {
    // Иногда zip может содержать вложенную папку. Попробуем найти MineBot.exe глубже.
    const maybe = path.join(runtimeDir(version), 'MineBot-win32-x64', 'MineBot.exe')
    if (fs.existsSync(maybe)) {
      // перенесём “вверх” в runtime/<ver>/
      appendLog('Flattening nested MineBot-win32-x64 folder')
      // простое перемещение: оставим как есть, но запускать будем из nested
      return { version, installed: true, nested: true }
    }
    throw new Error('runtime_missing_exe')
  }

  return { version, installed: true }
}

function startRuntime(version, nested) {
  const exe = nested
    ? path.join(runtimeDir(version), 'MineBot-win32-x64', 'MineBot.exe')
    : runtimeExePath(version)

  appendLog(`Starting runtime: ${exe}`)
  const p = spawn(exe, [], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    env: { ...process.env, MINEBOT_DATA_DIR: dataDir() },
  })
  p.unref()
}

async function main() {
  appendLog('Launcher start')
  ensureDir(dataDir())

  const { version, nested } = await ensureRuntimeLatest()
  startRuntime(version, Boolean(nested))
}

main().catch((e) => {
  appendLog(`Launcher error: ${e && e.stack ? e.stack : String(e)}`)
  // На всякий случай покажем стандартное окно ошибки (если запускали из консоли — увидят).
  // eslint-disable-next-line no-console
  console.error(e)
  process.exit(1)
})

