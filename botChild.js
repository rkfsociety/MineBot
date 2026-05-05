'use strict'

const mineflayer = require('mineflayer')
let mcproto = null
try {
  // mineflayer использует minecraft-protocol; берём его для ping/детекта версии.
  // eslint-disable-next-line global-require
  mcproto = require('minecraft-protocol')
} catch {
  mcproto = null
}

/** @type {import('mineflayer').Bot | null} */
let bot = null

let authCfg = {}
let authDelayMs = 2000
let currentCfg = null
let stopping = false
let everSpawned = false
let connectTimer = null

function clearConnectTimer() {
  if (!connectTimer) return
  try {
    clearTimeout(connectTimer)
  } catch {}
  connectTimer = null
}

function send(msg) {
  try {
    if (process.send) process.send(msg)
  } catch {}
}

function formatAny(v) {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v)
  if (v instanceof Error) return v.stack || v.message || String(v)
  try {
    return JSON.stringify(v)
  } catch {
    try {
      return String(v)
    } catch {
      return '[unknown]'
    }
  }
}

function log(level, message) {
  send({
    type: 'log',
    level,
    message: formatAny(message),
    t: Date.now(),
  })
}

function setStatus(patch) {
  send({ type: 'status', patch })
}

function normalizeVersion(v) {
  const raw = v == null ? '' : String(v).trim()
  if (!raw) return false
  if (raw === 'auto' || raw === '0') return false
  // Важно: не навязываем формат "1.xx.x".
  // Mineflayer принимает строку версии, и формат может меняться в новых релизах игры.
  return raw
}

function formatAuthCommand(template, password) {
  return String(template).replaceAll('{password}', password || '')
}

function teardown() {
  if (!bot) return
  try {
    bot.removeAllListeners()
  } catch {}
  try {
    bot.quit('disconnect')
  } catch {}
  try {
    bot.end()
  } catch {}
  bot = null
}

async function start(payload) {
  stopping = false
  everSpawned = false
  clearConnectTimer()
  authCfg = payload && payload.authCfg ? payload.authCfg : {}
  authDelayMs = payload && payload.authDelayMs != null ? payload.authDelayMs : 2000

  const cfg = payload && payload.cfg ? payload.cfg : null
  if (!cfg) throw new Error('missing cfg')

  currentCfg = {
    host: String(cfg.host || 'localhost'),
    port: parseInt(String(cfg.port || '25565'), 10),
    username: String(cfg.username || 'tester'),
    version: normalizeVersion(cfg.version),
    password: cfg.password != null ? String(cfg.password) : '',
    registerFirst: Boolean(cfg.registerFirst),
  }

  setStatus({
    host: currentCfg.host,
    port: currentCfg.port,
    username: currentCfg.username,
    version: currentCfg.version === false ? 'auto' : String(currentCfg.version),
    hasPassword: Boolean(currentCfg.password),
    connecting: true,
    connected: false,
    spawned: false,
  })
  log(
    'info',
    `Подключение к ${currentCfg.host}:${currentCfg.port} как ${currentCfg.username} (версия: ${
      currentCfg.version === false ? 'auto' : currentCfg.version
    })`,
  )

  // Если выбрано auto — пробуем заранее определить версию/протокол через ping.
  // Это повышает шанс успешного коннекта к прокси (например Velocity), где авто-детект иногда ломается.
  let resolvedVersion = currentCfg.version
  if (resolvedVersion === false && mcproto && typeof mcproto.ping === 'function') {
    try {
      const r = await Promise.race([
        mcproto.ping({ host: currentCfg.host, port: currentCfg.port }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('ping_timeout')), 2500)),
      ])
      const name = r && r.version && r.version.name ? String(r.version.name) : ''
      const proto = r && r.version && r.version.protocol != null ? Number(r.version.protocol) : null
      if (name) {
        resolvedVersion = name
      } else if (Number.isFinite(proto)) {
        resolvedVersion = proto
      }
      if (resolvedVersion !== false) {
        log('info', `Определена версия сервера: ${resolvedVersion}`)
        setStatus({
          version: typeof resolvedVersion === 'number' ? String(resolvedVersion) : String(resolvedVersion),
        })
      }
    } catch (e) {
      log('warn', `Не удалось определить версию сервера (ping): ${formatAny(e)}`)
    }
  }

  bot = mineflayer.createBot({
    host: currentCfg.host,
    port: currentCfg.port,
    username: currentCfg.username,
    version: resolvedVersion,
    auth: 'offline',
  })

  // Таймаут на подключение: если не дошли до login/spawn, завершаем процесс,
  // чтобы UI не висел в "подключение" бесконечно.
  const connectTimeoutMs = parseInt(process.env.MC_CONNECT_TIMEOUT_MS || '20000', 10)
  if (Number.isFinite(connectTimeoutMs) && connectTimeoutMs > 1000) {
    connectTimer = setTimeout(() => {
      if (stopping || everSpawned) return
      log('error', `Таймаут подключения (${connectTimeoutMs}мс). Отключаюсь.`)
      setStatus({ connecting: false, connected: false, spawned: false })
      teardown()
      process.exit(1)
    }, connectTimeoutMs)
  }

  let authSent = false

  function sendAuthCommands() {
    if (!bot) return
    if (!currentCfg.password) {
      log('warn', 'Пароль пустой — если сервер с /login, укажите пароль в панели')
      return
    }
    const loginTpl = authCfg.loginCommand || '/login {password}'
    const regTpl = authCfg.registerCommand || '/register {password} {password}'
    if (currentCfg.registerFirst) {
      bot.chat(formatAuthCommand(regTpl, currentCfg.password))
      log('info', 'Отправлено: регистрация (команда из config.auth)')
    } else {
      bot.chat(formatAuthCommand(loginTpl, currentCfg.password))
      log('info', 'Отправлено: вход (команда из config.auth)')
    }
  }

  bot.on('login', () => {
    if (!bot) return
    clearConnectTimer()
    setStatus({
      connecting: false,
      connected: true,
      username: bot.username,
    })
    log('info', `Вошёл как ${bot.username}`)
  })

  bot.on('spawn', () => {
    everSpawned = true
    clearConnectTimer()
    setStatus({ spawned: true })
    log('info', 'Персонаж в мире')
    if (authSent) return
    authSent = true
    setTimeout(sendAuthCommands, authDelayMs)
  })

  bot.on('chat', (u, message) => {
    if (!bot) return
    if (u === bot.username) return
    log('info', `<${u}> ${message}`)
  })

  bot.on('messagestr', (text) => {
    log('info', `[сервер] ${text}`)
  })

  bot.on('kicked', (reason) => {
    clearConnectTimer()
    setStatus({ connecting: false, connected: false, spawned: false })
    const msg = formatAny(reason)
    log('error', `Кик: ${msg || 'неизвестная причина'}`)
    if (/Outdated client/i.test(msg)) {
      log(
        'warn',
        'Подсказка: сервер отклонил клиент по версии. В панели попробуй указать точную версию, ' +
          'которую пишет сервер (например 26.1.2), вместо auto.',
      )
    }
    // Если подключение не удалось (не дошли до spawn) — выходим, чтобы botService отметил бота как остановленного.
    // Это предотвращает "зависание" состояния после неудачного коннекта.
    teardown()
    if (!stopping && !everSpawned) process.exit(0)
  })

  bot.on('error', (err) => {
    clearConnectTimer()
    setStatus({ connecting: false })
    log('error', `Ошибка: ${formatAny(err)}`)
    // Аналогично: если умерли во время подключения — завершаем процесс бота.
    teardown()
    if (!stopping && !everSpawned) process.exit(1)
  })

  bot.on('end', () => {
    clearConnectTimer()
    setStatus({ connecting: false, connected: false, spawned: false })
    log('warn', 'Соединение закрыто')
    teardown()
    if (stopping) process.exit(0)
    if (!everSpawned) process.exit(0)
  })
}

async function stop() {
  stopping = true
  teardown()
  setStatus({ connecting: false, connected: false, spawned: false })
  process.exit(0)
}

async function chat(text) {
  if (!bot) throw new Error('bot_not_connected')
  if (!bot.entity) throw new Error('bot_not_spawned')
  bot.chat(String(text))
  log('chat', `→ ${String(text)}`)
}

process.on('message', async (msg) => {
  try {
    if (!msg || typeof msg !== 'object') return
    if (msg.type === 'start') await start(msg)
    else if (msg.type === 'stop') await stop()
    else if (msg.type === 'chat') await chat(msg.text)
  } catch (e) {
    log('error', e instanceof Error ? e.message : String(e))
  }
})

process.on('uncaughtException', (e) => {
  log('error', e && e.stack ? e.stack : String(e))
  process.exit(1)
})

process.on('unhandledRejection', (e) => {
  log('error', e && e.stack ? e.stack : String(e))
})

