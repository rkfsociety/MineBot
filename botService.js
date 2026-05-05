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
let botStartedAt = null
let lastBotError = null
let fishingBotVersion = null
let lastBotExit = null
let authRemember = {}

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
    authRemember: cfg.authRemember && typeof cfg.authRemember === 'object' ? cfg.authRemember : {},
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
authRemember = (local && local.authRemember && typeof local.authRemember === 'object') ? local.authRemember : {}

function rememberKey() {
  return `${currentCfg.host}:${currentCfg.port}:${currentCfg.username}`
}

function getRemembered() {
  const k = rememberKey()
  const v = authRemember && authRemember[k]
  return v && typeof v === 'object' ? v : null
}

function setRemembered(patch) {
  const k = rememberKey()
  const prev = getRemembered() || {}
  authRemember[k] = { ...prev, ...patch, t: Date.now() }
  try {
    writeLocalSettings({ ...currentCfg, authRemember })
  } catch {}
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
  function once(u, redirectsLeft) {
    return new Promise((resolve, reject) => {
      const out = fs.createWriteStream(filePath)
      const req = https.get(u, { headers }, (res) => {
        const code = res.statusCode || 0
        if (code >= 300 && code < 400 && res.headers && res.headers.location) {
          // redirect (GitHub assets often redirect to S3)
          res.resume()
          out.close(() => {
            try {
              fs.unlinkSync(filePath)
            } catch {}
            if (redirectsLeft <= 0) return reject(new Error('too_many_redirects'))
            const next = String(res.headers.location)
            resolve(once(next, redirectsLeft - 1))
          })
          return
        }
        if (code >= 400) {
          reject(new Error(`HTTP ${code}`))
          res.resume()
          return
        }
        res.pipe(out)
        out.on('finish', () => out.close(() => resolve()))
      })
      req.on('error', (e) => {
        try { out.close() } catch {}
        try { fs.unlinkSync(filePath) } catch {}
        reject(e)
      })
    })
  }
  return once(url, 5)
}

async function ensureFishingBotJar() {
  const jarPath = path.join(RUNTIME_DIR, 'FishingBot.jar')
  try {
    if (fs.existsSync(jarPath) && fs.statSync(jarPath).size > 1_000_000) return jarPath
    if (fs.existsSync(jarPath) && fs.statSync(jarPath).size < 1_000_000) {
      try { fs.unlinkSync(jarPath) } catch {}
    }
  } catch {}

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
  const st = fs.statSync(tmp)
  if (!st || st.size < 1_000_000) {
    try { fs.unlinkSync(tmp) } catch {}
    throw new Error('download_failed_or_too_small')
  }
  fs.renameSync(tmp, jarPath)
  return jarPath
}

function writeFishingBotConfig(cfg) {
  const cfgPath = path.join(RUNTIME_DIR, 'fishingbot-config.json')
  const logsDir = path.join(LOGS_DIR, 'FishingBot')
  fs.mkdirSync(logsDir, { recursive: true })

  const versionStr = cfg.version === false ? 'AUTOMATIC' : String(cfg.version)
  // Авто-логин/регистрация теперь управляется из botService по сообщениям чата,
  // чтобы после первого /register в следующий раз выполнять /login автоматически.
  const startTexts = []

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
  botStartedAt = Date.now()
  lastBotError = null

  // state machine for auth commands
  let authStage = 'unknown' // unknown | need_register | registered | need_login | logged_in
  let authTimer = null
  let authDisabledByEngine = false
  let connectedAt = 0
  let playReadyAt = 0
  const commandDelayMs = parseInt(process.env.FB_COMMAND_DELAY_MS || '1200', 10)
  function clearAuthTimer() {
    if (!authTimer) return
    try { clearTimeout(authTimer) } catch {}
    authTimer = null
  }
  function sendLine(line) {
    if (!botProc || !botProc.stdin) return false
    try {
      botProc.stdin.write(String(line) + '\n')
      return true
    } catch {
      return false
    }
  }

  function sendLineWithDelay(line) {
    const now = Date.now()
    // Важно: чат-команды можно отправлять только после перехода в PLAY.
    const base = playReadyAt || connectedAt || botStartedAt || now
    const delay = Number.isFinite(commandDelayMs) && commandDelayMs > 0 ? commandDelayMs : 0
    const wait = Math.max(0, base + delay - now)
    if (wait <= 0) return sendLine(line)
    setTimeout(() => {
      if (!botProc) return
      sendLine(line)
    }, wait)
    return true
  }
  function fmt(tpl) {
    return String(tpl).replaceAll('{password}', currentCfg.password || '')
  }
  function maybeAuth() {
    if (!currentCfg.password) return
    if (authDisabledByEngine) return
    // Чат-команды отправляем только когда бот реально в PLAY (иначе registry LOGIN не содержит chat_command).
    if (!playReadyAt) return
    const loginTpl = authCfg.loginCommand || '/login {password}'
    const regTpl = authCfg.registerCommand || '/register {password} {password}'
    const remembered = getRemembered()
    if (remembered && remembered.registered) authStage = 'need_login'
    else authStage = 'need_register'

    // чуть подождём, чтобы бот успел подключиться/войти в лобби
    clearAuthTimer()
    authTimer = setTimeout(() => {
      if (!botProc) return
      if (authStage === 'need_register') {
        log('warn', 'Авто-авторизация: пробую /register')
        sendLineWithDelay(fmt(regTpl))
      } else if (authStage === 'need_login') {
        log('warn', 'Авто-авторизация: пробую /login')
        sendLineWithDelay(fmt(loginTpl))
      }
    }, 1200)
  }

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
          if (!fishingBotVersion) {
            const m = line.match(/Using FishingBot v([0-9.]+)/i)
            if (m) fishingBotVersion = m[1]
          }
          // Простейшая эвристика статуса.
          if (/has connected|connected/i.test(line)) {
            if (!connectedAt) connectedAt = Date.now()
            setBotState({ connecting: false, connected: true })
          }
          if (/spawn|in game|joined/i.test(line)) setBotState({ spawned: true })
          if (/kicked|disconnect|disconnected/i.test(line)) setBotState({ connecting: false, connected: false, spawned: false })

          // Признак, что мы уже в PLAY и можем слать чат-команды (включается ChatProxyModule).
          if (!playReadyAt && (/ChatProxyModule/i.test(line) && /(enabled|включен)/i.test(line))) {
            playReadyAt = Date.now()
            // если мы ждали авторизацию — пробуем теперь
            maybeAuth()
          }

          // Явный детект известной проблемы FishingBot на 26.1.x: нельзя отправлять чат-команды.
          if (line.includes('InvalidPacketException') || line.includes('PacketOutUnsignedChatCommand') || line.includes('ID пакета PacketOutUnsignedChatCommand')) {
            lastBotError =
              'FishingBot не смог отправить чат-команду (PacketOutUnsignedChatCommand). ' +
              'Чаще всего это происходит, если команда отправлена слишком рано (до PLAY), или это баг FishingBot.'
            authDisabledByEngine = true
            clearAuthTimer()
            log('error', 'Авто-авторизация отключена из-за ошибки отправки пакета. Попробуй увеличить задержку FB_COMMAND_DELAY_MS.')
          }

          // Детект подсказок авторизации из чата/сервера.
          const l = line.toLowerCase()
          const needReg =
            l.includes('/register') ||
            l.includes('register') && (l.includes('please') || l.includes('need') || l.includes('required')) ||
            l.includes('нужно зарегистр') ||
            l.includes('зарегистриру')
          const alreadyReg =
            l.includes('already registered') ||
            l.includes('уже зарегистр')
          const regOk =
            l.includes('registered') && (l.includes('success') || l.includes('successfully') || l.includes('успеш'))
          const needLogin =
            l.includes('/login') ||
            l.includes('please login') ||
            l.includes('нужно войти') ||
            l.includes('авториз')
          const loginOk =
            l.includes('logged in') ||
            l.includes('successfully logged') ||
            l.includes('вход выполнен') ||
            l.includes('авторизация успеш')

          if (needReg && authStage !== 'need_register') {
            authStage = 'need_register'
            maybeAuth()
          }
          if (alreadyReg || regOk) {
            authStage = 'registered'
            setRemembered({ registered: true })
            // после регистрации часто нужно /login
            if (currentCfg.password) {
              clearAuthTimer()
              authTimer = setTimeout(() => {
                const loginTpl = authCfg.loginCommand || '/login {password}'
                log('warn', 'Авто-авторизация: пробую /login')
                sendLineWithDelay(fmt(loginTpl))
              }, 900)
            }
          }
          if (needLogin && authStage !== 'need_login' && authStage !== 'logged_in') {
            authStage = 'need_login'
            maybeAuth()
          }
          if (loginOk) {
            authStage = 'logged_in'
          }
        }
      }
      botProc.stdout.on('data', onData)
      botProc.stderr.on('data', (c) => onData(String(c)))

      botProc.on('exit', (code, signal) => {
        clearAuthTimer()
        log('warn', `Бот остановлен (code=${code}, signal=${signal || 'none'})`)
        lastBotExit = { at: Date.now(), code, signal: signal || 'none' }
        botProc = null
        setBotState({ connecting: false, connected: false, spawned: false })
      })

      // Начальная попытка авторизации сразу после старта.
      maybeAuth()
    })().catch((e) => {
      clearAuthTimer()
      lastBotError = e instanceof Error ? (e.stack || e.message) : String(e)
      log('error', `Не смог запустить Java-бота: ${e instanceof Error ? e.message : String(e)}`)
      botProc = null
      setBotState({ connecting: false, connected: false, spawned: false })
    })
  } catch (e) {
    clearAuthTimer()
    lastBotError = e instanceof Error ? (e.stack || e.message) : String(e)
    log('error', `Не смог запустить Java-бота: ${e instanceof Error ? e.message : String(e)}`)
    botProc = null
    setBotState({ connecting: false, connected: false, spawned: false })
  }
}

function javaVersion() {
  try {
    const { spawnSync } = require('child_process')
    const r = spawnSync('java', ['-version'], { windowsHide: true, encoding: 'utf8' })
    // java -version пишет в stderr
    const out = String((r.stderr || r.stdout || '')).trim()
    return out.split(/\r?\n/)[0] || null
  } catch {
    return null
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

app.get('/api/debug', (_req, res) => {
  let jar = null
  try {
    const jarPath = path.join(RUNTIME_DIR, 'FishingBot.jar')
    if (fs.existsSync(jarPath)) {
      const st = fs.statSync(jarPath)
      jar = { path: jarPath, size: st.size, mtimeMs: st.mtimeMs }
    }
  } catch {}

  res.json({
    ok: true,
    now: Date.now(),
    engine: 'fishingbot-java',
    fishingBotVersion,
    node: process.version,
    java: javaVersion(),
    runtimeDir: RUNTIME_DIR,
    logsDir: LOGS_DIR,
    bot: {
      running: Boolean(botProc),
      pid: botProc && botProc.pid ? botProc.pid : null,
      startedAt: botStartedAt,
      lastError: lastBotError,
      lastExit: lastBotExit,
      state: botState,
      config: {
        host: currentCfg.host,
        port: currentCfg.port,
        username: currentCfg.username,
        version: currentCfg.version === false ? 'AUTOMATIC' : String(currentCfg.version),
        registerFirst: Boolean(currentCfg.registerFirst),
        hasPassword: Boolean(currentCfg.password),
      },
      jar,
    },
  })
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

