// moved from /paths.js (keep same exports)
'use strict'

const path = require('path')
const fs = require('fs')

function ensureDir(p) {
  try {
    fs.mkdirSync(p, { recursive: true })
  } catch {}
}

function getDataDir() {
  // В приоритете явная переменная окружения (из Tauri/runner).
  const fromEnv = process.env.MINEBOT_DATA_DIR
  if (fromEnv && String(fromEnv).trim()) return String(fromEnv).trim()

  // Windows: %APPDATA%\MineBot
  const appdata = process.env.APPDATA
  if (appdata && String(appdata).trim()) {
    return path.join(String(appdata).trim(), 'MineBot')
  }

  // Фолбэк: рядом с проектом (dev)
  return path.join(__dirname, '..', '.minebot-data')
}

function getSettingsPath() {
  const d = getDataDir()
  ensureDir(d)
  return path.join(d, 'settings.local.json')
}

function getLogsDir() {
  const d = path.join(getDataDir(), 'logs')
  ensureDir(d)
  return d
}

function getUpdatesDir() {
  const d = path.join(getDataDir(), 'updates')
  ensureDir(d)
  return d
}

function getRuntimeDir() {
  const d = path.join(getDataDir(), 'runtime')
  ensureDir(d)
  return d
}

module.exports = {
  getDataDir,
  getSettingsPath,
  getLogsDir,
  getUpdatesDir,
  getRuntimeDir,
}

