'use strict'

const mineflayer = require('mineflayer')

/** @type {import('mineflayer').Bot | null} */
let bot = null

let authCfg = {}
let authDelayMs = 2000
let currentCfg = null
let stopping = false

function send(msg) {
  try {
    if (process.send) process.send(msg)
  } catch {}
}

function log(level, message) {
  send({
    type: 'log',
    level,
    message: typeof message === 'string' ? message : String(message),
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
  // Mineflayer ждёт версию Minecraft вида 1.xx.x (или auto).
  // Строки вида 26.1.2 часто относятся к сборке/лаунчеру/модлоадеру и не являются версией протокола MC.
  if (/^\d+\.\d+\.\d+$/.test(raw) && !raw.startsWith('1.')) {
    throw new Error(
      `Неверная версия "${raw}". Укажите версию Minecraft (например 1.21.2) или выберите auto.`,
    )
  }
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

  bot = mineflayer.createBot({
    host: currentCfg.host,
    port: currentCfg.port,
    username: currentCfg.username,
    version: currentCfg.version,
    auth: 'offline',
  })

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
    setStatus({
      connecting: false,
      connected: true,
      username: bot.username,
    })
    log('info', `Вошёл как ${bot.username}`)
  })

  bot.on('spawn', () => {
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
    setStatus({ connecting: false, connected: false, spawned: false })
    log('error', `Кик: ${reason}`)
  })

  bot.on('error', (err) => {
    setStatus({ connecting: false })
    log('error', `Ошибка: ${err}`)
  })

  bot.on('end', () => {
    setStatus({ connecting: false, connected: false, spawned: false })
    log('warn', 'Соединение закрыто')
    teardown()
    if (stopping) process.exit(0)
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

