'use strict'

const mineflayer = require('mineflayer')
const config = require('./config')
const { createWebUi } = require('./webUi')

function loadAuthLocal() {
  try {
    return require('./auth.local')
  } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND') return null
    throw e
  }
}

const authLocal = loadAuthLocal()

const host = process.env.MC_HOST || 'localhost'
const port = parseInt(process.env.MC_PORT || '25565', 10)
const username =
  authLocal?.username ?? process.env.MC_USER ?? 'tester'
/** MC_VERSION=auto — авто-определение протокола по серверу */
const version =
  process.env.MC_VERSION === 'auto' || process.env.MC_VERSION === '0'
    ? false
    : process.env.MC_VERSION || '26.1.2'
const password = authLocal?.password ?? ''
const authCfg = config.auth || {}
const registerFirst =
  process.env.MC_REGISTER === '1' ||
  process.env.MC_REGISTER === 'true' ||
  process.env.MC_REGISTER === 'yes' ||
  Boolean(authCfg.registerOnFirstJoin)
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

function formatAuthCommand(template) {
  return template.replaceAll('{password}', password)
}

/** @type {import('mineflayer').Bot | null} */
let bot = null

const ui = createWebUi({
  host: webHost,
  port: webPort,
  openBrowser: webOpen,
  getBot: () => bot,
})

ui.setStatus({
  host,
  port,
  username,
  version: version === false ? 'auto' : String(version),
  connected: false,
  spawned: false,
})

bot = mineflayer.createBot({
  host,
  port,
  username,
  version,
  auth: 'offline',
})

let authSent = false

function sendAuthCommands() {
  if (!password) {
    ui.log(
      'warn',
      'Нет auth.local.js или пустой password — скопируйте auth.local.example.js → auth.local.js',
    )
    return
  }
  const loginTpl = authCfg.loginCommand || '/login {password}'
  const regTpl =
    authCfg.registerCommand || '/register {password} {password}'
  if (registerFirst) {
    bot.chat(formatAuthCommand(regTpl))
    ui.log('info', 'Отправлено: регистрация nLogin (команда из config.auth)')
  } else {
    bot.chat(formatAuthCommand(loginTpl))
    ui.log('info', 'Отправлено: вход nLogin (команда из config.auth)')
  }
}

bot.on('login', () => {
  ui.log('info', `Вошёл как ${bot.username} на ${host}:${port}`)
  ui.setStatus({ connected: true, username: bot.username })
})

bot.on('spawn', () => {
  ui.log('info', 'Персонаж в мире')
  ui.setStatus({ spawned: true })
  if (authSent) return
  authSent = true
  setTimeout(sendAuthCommands, authDelayMs)
})

bot.on('chat', (u, message) => {
  if (u === bot.username) return
  ui.log('info', `<${u}> ${message}`)
})

bot.on('messagestr', (text) => {
  ui.log('info', `[сервер] ${text}`)
})

bot.on('kicked', (reason) => {
  ui.setStatus({ connected: false, spawned: false })
  ui.log('error', `Кик: ${reason}`)
})

bot.on('error', (err) => {
  ui.log('error', `Ошибка: ${err}`)
})

bot.on('end', () => {
  ui.setStatus({ connected: false, spawned: false })
  ui.log('warn', 'Соединение закрыто')
})
