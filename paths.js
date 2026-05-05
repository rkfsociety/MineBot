'use strict'

const fs = require('fs')
const path = require('path')

function getDataDir() {
  // В приоритете явная переменная окружения (из Electron).
  const fromEnv = process.env.MINEBOT_DATA_DIR
  if (fromEnv && String(fromEnv).trim()) return String(fromEnv).trim()

  // Windows: %APPDATA%\MineBot
  const appdata = process.env.APPDATA
  if (appdata && String(appdata).trim()) {
    return path.join(String(appdata).trim(), 'MineBot')
  }

  // Фолбэк: рядом с проектом (dev)
  return path.join(__dirname, '.minebot-data')
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true })
}

function getSettingsPath() {
  const dir = getDataDir()
  ensureDir(dir)
  return path.join(dir, 'settings.local.json')
}

function getLogsDir() {
  const dir = path.join(getDataDir(), 'logs')
  ensureDir(dir)
  return dir
}

function getUpdatesDir() {
  const dir = path.join(getDataDir(), 'updates')
  ensureDir(dir)
  return dir
}

function getRuntimeDir() {
  const dir = path.join(getDataDir(), 'runtime')
  ensureDir(dir)
  return dir
}

module.exports = {
  getDataDir,
  getSettingsPath,
  getLogsDir,
  getUpdatesDir,
  getRuntimeDir,
}

