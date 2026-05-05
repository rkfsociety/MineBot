'use strict'

const { fork } = require('child_process')
const fs = require('fs')
const path = require('path')
const config = require('./config')
const { createWebUi } = require('./webUi')

const SETTINGS_PATH = path.join(__dirname, 'settings.local.json')
const PANEL_RESTART_CODE = 42

function loadAuthLocal() {
  try {
    return require('./auth.local')
  } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND') return null
    throw e
  }
}

const authLocal = loadAuthLocal()

/** MC_VERSION=auto — авто-определение протокола по серверу */
const authCfg = config.auth || {}
const authDelayMs = parseInt(process.env.MC_AUTH_DELAY_MS || '2000', 10)

const webCfg = config.web || {}
const webHost = process.env.WEB_HOST || webCfg.host || '127.0.0.1'
const webPort = parseInt(
  process.env.WEB_PORT || String(webCfg.port ?? 3847),
  10,
)
const webOpen =
  process.env.WEB_OPEN === '0' || process.env.WEB_OPEN === 'false'
    ? false
    : webCfg.openBrowser !== false

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

/** @type {import('mineflayer').Bot | null} */
let botProc = null
let botState = {
  connecting: false,
  connected: false,
  spawned: false,
}

const local = readLocalSettings()
let currentCfg = {
  host: (local && local.host) || process.env.MC_HOST || 'localhost',
  port:
    (local && Number.isFinite(parseInt(String(local.port), 10))
      ? parseInt(String(local.port), 10)
      : null) ?? parseInt(process.env.MC_PORT || '25565', 10),
  username: (local && local.username)
    ? String(local.username)
    : (authLocal?.username ?? process.env.MC_USER ?? 'tester'),
  version: normalizeVersion((local && local.version) || process.env.MC_VERSION),
  password: (local && local.password)
    ? String(local.password)
    : (authLocal?.password ?? ''),
  registerFirst:
    (local && local.registerFirst != null
      ? Boolean(local.registerFirst)
      : process.env.MC_REGISTER === '1' ||
        process.env.MC_REGISTER === 'true' ||
        process.env.MC_REGISTER === 'yes' ||
        Boolean(authCfg.registerOnFirstJoin)),
}

function setBotState(patch) {
  botState = { ...botState, ...patch }
  ui.setStatus({
    host: currentCfg.host,
    port: currentCfg.port,
    username: currentCfg.username,
    version: currentCfg.version === false ? 'auto' : String(currentCfg.version),
    hasPassword: Boolean(currentCfg.password),
    connecting: Boolean(botState.connecting),
    connected: Boolean(botState.connected),
    spawned: Boolean(botState.spawned),
  })
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
        p.kill('SIGKILL')
      } catch {}
      resolve()
    }, 1500)

    p.once('exit', () => {
      clearTimeout(killTimer)
      resolve()
    })

    try {
      p.send({ type: 'stop' })
    } catch {}
  })
}

function startBotProcess() {
  if (botProc) return
  const childPath = path.join(__dirname, 'botChild.js')
  botProc = fork(childPath, [], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] })

  botProc.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return
    if (msg.type === 'log') {
      ui.log(msg.level || 'info', msg.message || '')
      return
    }
    if (msg.type === 'status') {
      setBotState(msg.patch || {})
    }
  })

  botProc.on('exit', (code, signal) => {
    ui.log('warn', `Бот остановлен (code=${code}, signal=${signal || 'none'})`)
    botProc = null
    setBotState({ connecting: false, connected: false, spawned: false })
  })

  setBotState({ connecting: true, connected: false, spawned: false })
  try {
    botProc.send({
      type: 'start',
      cfg: {
        host: currentCfg.host,
        port: currentCfg.port,
        username: currentCfg.username,
        version: currentCfg.version === false ? 'auto' : String(currentCfg.version),
        password: currentCfg.password || '',
        registerFirst: Boolean(currentCfg.registerFirst),
      },
      authCfg,
      authDelayMs,
    })
  } catch (e) {
    ui.log('error', `Не смог запустить бота: ${e instanceof Error ? e.message : String(e)}`)
  }
}

async function restartPanelProcess() {
  ui.log('warn', 'Перезапуск панели...')
  // Аккуратно выключим бота и выйдем.
  try {
    await stopBotProcess()
  } catch {}

  setTimeout(() => process.exit(PANEL_RESTART_CODE), 200)
  return { ok: true }
}

const ui = createWebUi({
  host: webHost,
  port: webPort,
  openBrowser: webOpen,
  getConfig: () => ({
    host: currentCfg.host,
    port: currentCfg.port,
    username: currentCfg.username,
    version: currentCfg.version === false ? 'auto' : String(currentCfg.version),
    hasPassword: Boolean(currentCfg.password),
    registerFirst: Boolean(currentCfg.registerFirst),
  }),
  setConfig: (patch) => {
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
    if (patch.registerFirst != null)
      next.registerFirst = Boolean(patch.registerFirst)
    currentCfg = next
    try {
      writeLocalSettings(currentCfg)
    } catch (e) {
      ui.log('warn', `Не смог сохранить settings.local.json: ${e instanceof Error ? e.message : String(e)}`)
    }
    setBotState({})
  },
  connect: async () => {
    if (botProc) return { ok: false, error: 'already_connected' }
    startBotProcess()
    return { ok: true }
  },
  disconnect: async () => {
    await stopBotProcess()
    setBotState({ connecting: false, connected: false, spawned: false })
    return { ok: true }
  },
  restart: async () => {
    ui.log('warn', 'Перезапуск бота...')
    await stopBotProcess()
    startBotProcess()
    return { ok: true }
  },
  restartPanel: restartPanelProcess,
  sendChat: async (text) => {
    const raw = String(text || '').trim()
    if (!raw) return { ok: false, error: 'empty' }
    if (!botProc) return { ok: false, error: 'bot_not_connected' }
    try {
      botProc.send({ type: 'chat', text: raw })
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  },
})

setBotState({ connecting: false, connected: false, spawned: false })
