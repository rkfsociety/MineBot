'use strict'

const { app, BrowserWindow, dialog } = require('electron')
const path = require('path')
const { spawn } = require('child_process')
const fs = require('fs')

let mainWindow = null
let runnerProc = null

const PANEL_URL = process.env.PANEL_URL || 'http://127.0.0.1:3847/home'

function safeAppendLog(line) {
  try {
    const dir = app.getPath('userData')
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true })
    const fp = path.join(dir, 'logs', 'app.log')
    const msg = `[${new Date().toISOString()}] ${line}\r\n`
    fs.appendFileSync(fp, msg, 'utf8')
  } catch {}
}

function startRunner() {
  if (runnerProc) return
  const runnerPath = path.join(__dirname, 'runner.js')
  const dataDir = app.getPath('userData')
  try {
    fs.mkdirSync(dataDir, { recursive: true })
  } catch {}
  safeAppendLog(`Starting runner: ${runnerPath}`)
  runnerProc = spawn(process.execPath, [runnerPath], {
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      MINEBOT_DATA_DIR: dataDir,
      MINEBOT_EXE_PATH: process.execPath,
      MINEBOT_ELECTRON_PID: String(process.pid),
    },
  })
  runnerProc.on('exit', () => {
    safeAppendLog('Runner exited')
    runnerProc = null
  })
}

async function createWindow() {
  safeAppendLog(`MineBot starting. exe=${process.execPath}`)
  startRunner()

  mainWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    backgroundColor: '#0d1117',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      // UI локальная, но загружается по http с localhost
      sandbox: true,
    },
  })

  mainWindow.once('ready-to-show', () => mainWindow.show())

  // Подождём чуть-чуть, чтобы панель успела подняться.
  await new Promise((r) => setTimeout(r, 700))

  try {
    safeAppendLog(`Loading panel URL: ${PANEL_URL}`)
    await mainWindow.loadURL(PANEL_URL)
  } catch (e) {
    safeAppendLog(`Failed to load panel: ${e instanceof Error ? e.stack || e.message : String(e)}`)
    dialog.showErrorBox(
      'MineBot',
      'Не удалось открыть панель.\n\nЛог: %APPDATA%\\MineBot\\logs\\app.log\n\n' +
        String(e && e.message ? e.message : e),
    )
  }
}

app.setAppUserModelId('rkfsociety.minebot')

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
}

app.on('ready', createWindow)

app.on('window-all-closed', () => {
  // Окно закрыли — завершаем всё.
  try {
    if (runnerProc) runnerProc.kill()
  } catch {}
  app.quit()
})

process.on('uncaughtException', (e) => {
  safeAppendLog(`uncaughtException: ${e && e.stack ? e.stack : String(e)}`)
})

process.on('unhandledRejection', (e) => {
  safeAppendLog(`unhandledRejection: ${e && e.stack ? e.stack : String(e)}`)
})

