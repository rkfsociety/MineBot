'use strict'

const { app, BrowserWindow, dialog } = require('electron')
const path = require('path')
const { spawn } = require('child_process')

let mainWindow = null
let runnerProc = null

const PANEL_URL = process.env.PANEL_URL || 'http://127.0.0.1:3847/home'

function startRunner() {
  if (runnerProc) return
  const runnerPath = path.join(__dirname, 'runner.js')
  runnerProc = spawn(process.execPath, [runnerPath], {
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env },
  })
  runnerProc.on('exit', () => {
    runnerProc = null
  })
}

async function createWindow() {
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
    await mainWindow.loadURL(PANEL_URL)
  } catch (e) {
    dialog.showErrorBox(
      'MineBot',
      'Не удалось открыть панель. Проверьте, что порты 3847/3848 свободны.\n\n' +
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

