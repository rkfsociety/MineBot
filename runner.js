'use strict'

const { spawn } = require('child_process')
const path = require('path')
const { repairMineBotPortsWin32 } = require('./lib/portRepair')

const PANEL_RESTART_CODE = 42
const FULL_RESTART_CODE = 43

let botChild = null
let panelChild = null

async function ensurePortsFree() {
  if (process.platform !== 'win32') return
  await repairMineBotPortsWin32([3847, 3848])
}

function killProcess(p) {
  try {
    if (!p) return
    p.removeAllListeners()
  } catch {}
  try {
    p.kill()
  } catch {}
}

async function startBotService() {
  await ensurePortsFree()
  const entry = path.join(__dirname, 'botService.js')
  botChild = spawn(process.execPath, [entry], {
    stdio: 'inherit',
    env: { ...process.env },
  })

  botChild.on('exit', (code, signal) => {
    if (signal) return
    // Если botService упал — поднимем снова.
    setTimeout(startBotService, 500)
  })
}

async function startPanelLoop() {
  await ensurePortsFree()
  const entry = path.join(__dirname, 'panelServer.js')
  panelChild = spawn(process.execPath, [entry], {
    stdio: 'inherit',
    // Не автопробрасываем открытие браузера: окно открывается кнопкой в UI.
    env: { ...process.env, WEB_OPEN: '0' },
  })

  panelChild.on('exit', (code, signal) => {
    if (signal) {
      process.exit(0)
      return
    }
    if (code === PANEL_RESTART_CODE) {
      setTimeout(startPanelLoop, 250)
      return
    }
    if (code === FULL_RESTART_CODE) {
      // Обновление: перезапускаем и панель, и botService.
      killProcess(botChild)
      setTimeout(() => {
        startBotService()
        startPanelLoop()
      }, 600)
      return
    }
    // Если панель упала — тоже поднимем.
    setTimeout(startPanelLoop, 500)
  })
}

ensurePortsFree().finally(() => {
  startBotService()
  startPanelLoop()
})

