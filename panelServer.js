'use strict'

const express = require('express')
const path = require('path')
const config = require('./config')

const PANEL_RESTART_CODE = 42

const webCfg = (config && config.web) || {}
const host = process.env.WEB_HOST || webCfg.host || '127.0.0.1'
const port = parseInt(process.env.WEB_PORT || String(webCfg.port ?? 3847), 10)

const app = express()
app.use(express.json({ limit: '8kb' }))

const publicDir = path.join(__dirname, 'public')
const indexFile = path.join(publicDir, 'index.html')

function sendIndex(_req, res) {
  res.sendFile(indexFile)
}

app.get('/', sendIndex)
app.get('/home', sendIndex)

// Перезапуск только панели (runner её поднимет заново).
app.post('/api/panel/restart', (_req, res) => {
  res.json({ ok: true })
  setTimeout(() => process.exit(PANEL_RESTART_CODE), 150)
})

app.use(express.static(publicDir, { index: false }))

app.listen(port, host, () => {
  const openHost = host === '0.0.0.0' ? '127.0.0.1' : host
  console.log(`Панель: http://${openHost}:${port}/home`)
})

