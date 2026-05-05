'use strict'

const { spawn } = require('child_process')
const path = require('path')

const PANEL_RESTART_CODE = 42

function startBotService() {
  const entry = path.join(__dirname, 'botService.js')
  const child = spawn(process.execPath, [entry], {
    stdio: 'inherit',
    env: { ...process.env },
  })

  child.on('exit', (code, signal) => {
    if (signal) return
    // Если botService упал — поднимем снова.
    setTimeout(startBotService, 500)
  })
}

function startPanelLoop() {
  const entry = path.join(__dirname, 'panelServer.js')
  const child = spawn(process.execPath, [entry], {
    stdio: 'inherit',
    // Не автопробрасываем открытие браузера: окно открывается кнопкой в UI.
    env: { ...process.env, WEB_OPEN: '0' },
  })

  child.on('exit', (code, signal) => {
    if (signal) {
      process.exit(0)
      return
    }
    if (code === PANEL_RESTART_CODE) {
      setTimeout(startPanelLoop, 250)
      return
    }
    // Если панель упала — тоже поднимем.
    setTimeout(startPanelLoop, 500)
  })
}

startBotService()
startPanelLoop()

