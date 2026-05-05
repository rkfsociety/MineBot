'use strict'

const { spawn } = require('child_process')
const express = require('express')
const fs = require('fs')
const path = require('path')
const https = require('https')

const config = require('./config')
const { getSettingsPath, getRuntimeDir, getLogsDir } = require('./lib/paths')

const SETTINGS_PATH = getSettingsPath()
const RUNTIME_DIR = getRuntimeDir()
const LOGS_DIR = getLogsDir()

function normalizeVersion(v) {
  const raw = v == null ? '' : String(v).trim()
  if (!raw) return false
  if (raw === 'auto' || raw === '0') return false
  return raw
}

function readLocalSettings() {
  try {
    if (!fs.existsSync(SETTINGS_PATH)) return null
    const raw = fs.readFileSync(SETTINGS_PATH, 'utf8')
    const j = JSON.parse(raw)
    if (!j || typeof j !== 'object') return null
    return j
  } catch {
    return null
  }
}

function writeLocalSettings(cfg) {
  const safe = {
    host: cfg.host,
    port: cfg.port,
    username: cfg.username,
    version: cfg.version === false ? 'auto' : String(cfg.version),
    password: cfg.password || '',
    registerFirst: Boolean(cfg.registerFirst),
  }
  const tmp = `${SETTINGS_PATH}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(safe, null, 2), 'utf8')
  fs.renameSync(tmp, SETTINGS_PATH)
}

/** SSE */
/** @type {Set<import('http').ServerResponse>} */
const sseClients = new Set()
function sseSend(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const res of sseClients) {
    try {
      res.write(payload)
    } catch {
      sseClients.delete(res)
    }
  }
}

function log(level, message) {
  const line = typeof message === 'string' ? message : String(message)
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
  sseSend('log', { level, message: line, t: Date.now() })
}

/** Bot child */
let botProc = null
let botState = { connecting: false, connected: false, spawned: false }

const authCfg = (config && config.auth) || {}
const authDelayMs = parseInt(process.env.MC_AUTH_DELAY_MS || '2000', 10)

const local = readLocalSettings()
let currentCfg = {
  host: (local && local.host) || process.env.MC_HOST || 'localhost',
  port:
    (local && Number.isFinite(parseInt(String(local.port), 10))
      ? parseInt(String(local.port), 10)
      : null) ?? parseInt(process.env.MC_PORT || '25565', 10),
  username: (local && local.username)
    ? String(local.username)
    : process.env.MC_USER || 'tester',
  version: normalizeVersion((local && local.version) || process.env.MC_VERSION),
  password: (local && local.password) ? String(local.password) : '',
  registerFirst:
    (local && local.registerFirst != null)
      ? Boolean(local.registerFirst)
      : process.env.MC_REGISTER === '1' ||
        process.env.MC_REGISTER === 'true' ||
        process.env.MC_REGISTER === 'yes' ||
        Boolean(authCfg.registerOnFirstJoin),
}

function statusSnapshot() {
  return {
    host: currentCfg.host,
    port: currentCfg.port,
    username: currentCfg.username,
    version: currentCfg.version === false ? 'auto' : String(currentCfg.version),
    hasPassword: Boolean(currentCfg.password),
    running: Boolean(botProc),
    connecting: Boolean(botState.connecting),
    connected: Boolean(botState.connected),
    spawned: Boolean(botState.spawned),
  }
}

function setBotState(patch) {
  botState = { ...botState, ...patch }
  sseSend('status', statusSnapshot())
}

function stopBotProcess() {
  return new Promise((resolve) => {
    if (!botProc) return resolve()
    const p = botProc
    botProc = null
    try {
      p.removeAllListeners()
    } catch {}

    const killTimer = setTimeout(() => {
      try {
        p.kill()
      } catch {}
      resolve()
    }, 1500)

    p.once('exit', () => {
      clearTimeout(killTimer)
      resolve()
    })

    try {
      // Java: достаточно kill.
      p.kill()
    } catch {}
  })
}

function fetchJson(url, headers) {
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

async function ensureFishingBotJar() {
  const jarPath = path.join(RUNTIME_DIR, 'FishingBot.jar')
  if (fs.existsSync(jarPath) && fs.statSync(jarPath).size > 1_000_000) return jarPath

  const rel = await fetchJson('https://api.github.com/repos/MrKinau/FishingBot/releases/latest', {
    'User-Agent': 'MineBot',
    Accept: 'application/vnd.github+json',
  })
  const assets = Array.isArray(rel && rel.assets) ? rel.assets : []
  const jar =
    assets.find((a) => a && typeof a.name === 'string' && a.name.toLowerCase().endsWith('.jar')) ||
    assets.find((a) => a && typeof a.browser_download_url === 'string' && a.browser_download_url.toLowerCase().endsWith('.jar'))
  if (!jar || !jar.browser_download_url) throw new Error('no_fishingbot_jar_asset')

  const tmp = jarPath + '.download'
  await downloadToFile(jar.browser_download_url, tmp, { 'User-Agent': 'MineBot' })
  fs.renameSync(tmp, jarPath)
  return jarPath
}

function writeFishingBotConfig(cfg) {
  const cfgPath = path.join(RUNTIME_DIR, 'fishingbot-config.json')
  const logsDir = path.join(LOGS_DIR, 'FishingBot')
  fs.mkdirSync(logsDir, { recursive: true })

  const versionStr = cfg.version === false ? 'AUTOMATIC' : String(cfg.version)
  const startTexts = []
  if (cfg.password) {
    const loginTpl = authCfg.loginCommand || '/login {password}'
    const regTpl = authCfg.registerCommand || '/register {password} {password}'
    const t = cfg.registerFirst ? regTpl : loginTpl
    startTexts.push(String(t).replaceAll('{password}', cfg.password))
  }

  const j = {
    server: {
      ip: cfg.host,
      port: cfg.port,
      'online-mode': false,
      'default-protocol': versionStr,
    },
    account: {
      mail: cfg.username,
    },
    'start-text': {
      enabled: startTexts.length > 0,
      text: startTexts,
    },
    auto: {
      'auto-reconnect': false,
    },
    logs: {
      'log-packets': false,
    },
  }
  fs.writeFileSync(cfgPath, JSON.stringify(j, null, 2), 'utf8')
  return { cfgPath, logsDir }
}

function startBotProcess() {
  if (botProc) return
  setBotState({ connecting: true, connected: false, spawned: false })

  try {
    ;(async () => {
      const jarPath = await ensureFishingBotJar()
      const { cfgPath, logsDir } = writeFishingBotConfig({
        host: currentCfg.host,
        port: currentCfg.port,
        username: currentCfg.username,
        version: currentCfg.version,
        password: currentCfg.password || '',
        registerFirst: Boolean(currentCfg.registerFirst),
      })

      const args = ['-jar', jarPath, '-nogui', '-config', cfgPath, '-logsdir', logsDir]
      botProc = spawn('java', args, { cwd: RUNTIME_DIR, windowsHide: true })

      botProc.stdout.setEncoding('utf8')
      botProc.stderr.setEncoding('utf8')

      const onData = (chunk) => {
        const lines = String(chunk || '').split(/\r?\n/)
        for (const ln of lines) {
          const line = ln.trim()
          if (!line) continue
          log('info', line)
          // Простейшая эвристика статуса.
          if (/has connected|connected/i.test(line)) setBotState({ connecting: false, connected: true })
          if (/spawn|in game|joined/i.test(line)) setBotState({ spawned: true })
          if (/kicked|disconnect|disconnected/i.test(line)) setBotState({ connecting: false, connected: false, spawned: false })
        }
      }
      botProc.stdout.on('data', onData)
      botProc.stderr.on('data', (c) => onData(String(c)))

      botProc.on('exit', (code, signal) => {
        log('warn', `Бот остановлен (code=${code}, signal=${signal || 'none'})`)
        botProc = null
        setBotState({ connecting: false, connected: false, spawned: false })
      })
    })().catch((e) => {
      log('error', `Не смог запустить Java-бота: ${e instanceof Error ? e.message : String(e)}`)
      botProc = null
      setBotState({ connecting: false, connected: false, spawned: false })
    })
  } catch (e) {
    log('error', `Не смог запустить Java-бота: ${e instanceof Error ? e.message : String(e)}`)
    botProc = null
    setBotState({ connecting: false, connected: false, spawned: false })
  }
}

/** HTTP API */
const app = express()
app.use(express.json({ limit: '16kb' }))

// Разрешим запросы с панели на другом порту (локально).
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  if (_req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

app.get('/api/status', (_req, res) => {
  res.json(statusSnapshot())
})

app.get('/api/config', (_req, res) => {
  res.json({
    host: currentCfg.host,
    port: currentCfg.port,
    username: currentCfg.username,
    version: currentCfg.version === false ? 'auto' : String(currentCfg.version),
    hasPassword: Boolean(currentCfg.password),
    registerFirst: Boolean(currentCfg.registerFirst),
  })
})

app.post('/api/config', (req, res) => {
  const patch = req.body && typeof req.body === 'object' ? req.body : {}
  const next = { ...currentCfg }
  if (patch.host != null) next.host = String(patch.host).trim() || next.host
  if (patch.port != null) {
    const n = parseInt(String(patch.port), 10)
    if (Number.isFinite(n) && n > 0 && n < 65536) next.port = n
  }
  if (patch.username != null)
    next.username = String(patch.username).trim() || next.username
  if (patch.version != null) next.version = normalizeVersion(patch.version)
  if (patch.password != null) next.password = String(patch.password)
  if (patch.registerFirst != null) next.registerFirst = Boolean(patch.registerFirst)
  currentCfg = next
  try {
    writeLocalSettings(currentCfg)
  } catch (e) {
    log('warn', `Не смог сохранить settings.local.json: ${e instanceof Error ? e.message : String(e)}`)
  }
  sseSend('status', statusSnapshot())
  res.json({ ok: true, config: { ...statusSnapshot(), registerFirst: Boolean(currentCfg.registerFirst) } })
})

app.post('/api/connect', async (_req, res) => {
  if (botProc) return res.status(400).json({ ok: false, error: 'already_connected' })
  startBotProcess()
  res.json({ ok: true })
})

app.post('/api/disconnect', async (_req, res) => {
  await stopBotProcess()
  setBotState({ connecting: false, connected: false, spawned: false })
  res.json({ ok: true })
})

app.post('/api/restart', async (_req, res) => {
  log('warn', 'Перезапуск бота...')
  await stopBotProcess()
  startBotProcess()
  res.json({ ok: true })
})

app.post('/api/chat', (req, res) => {
  const raw = req.body && req.body.text != null ? String(req.body.text) : ''
  const text = raw.trim()
  if (!text) return res.status(400).json({ ok: false, error: 'empty' })
  if (text.length > 256) return res.status(400).json({ ok: false, error: 'too_long' })
  if (!botProc) return res.status(503).json({ ok: false, error: 'bot_not_connected' })
  try {
    // FishingBot читает команды/текст из stdin.
    try {
      botProc.stdin.write(text + '\n')
    } catch {}
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) })
  }
})

app.get('/api/stream', (_req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  if (typeof res.flushHeaders === 'function') res.flushHeaders()
  sseClients.add(res)
  res.write(`event: status\ndata: ${JSON.stringify(statusSnapshot())}\n\n`)
  res.on('close', () => sseClients.delete(res))
})

const botHost = process.env.BOT_HOST || '127.0.0.1'
const botPort = parseInt(process.env.BOT_PORT || '3848', 10)
app.listen(botPort, botHost, () => {
  log('info', `BotService: http://${botHost}:${botPort}`)
})

