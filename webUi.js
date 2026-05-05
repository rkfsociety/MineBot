'use strict'

const express = require('express')
const path = require('path')
const { exec } = require('child_process')

/**
 * @param {object} opts
 * @param {string} opts.host
 * @param {number} opts.port
 * @param {boolean} opts.openBrowser
 * @param {() => import('mineflayer').Bot | null} opts.getBot
 */
function createWebUi(opts) {
  const { host, port, openBrowser, getBot } = opts
  const app = express()
  app.use(express.json({ limit: '8kb' }))

  /** @type {Set<import('http').ServerResponse>} */
  const sseClients = new Set()

  /** @type {Record<string, unknown>} */
  let status = {}

  function sseSend(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const res of sseClients) {
      try {
        res.write(payload)
      } catch {
        sseClients.delete(res)
      }
    }
  }

  function log(level, message) {
    const line = typeof message === 'string' ? message : String(message)
    if (level === 'error') console.error(line)
    else if (level === 'warn') console.warn(line)
    else console.log(line)
    sseSend('log', { level, message: line, t: Date.now() })
  }

  function setStatus(patch) {
    status = { ...status, ...patch }
    sseSend('status', status)
  }

  app.get('/api/status', (_req, res) => {
    res.json(status)
  })

  app.get('/api/stream', (_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    if (typeof res.flushHeaders === 'function') res.flushHeaders()
    sseClients.add(res)
    res.write(`event: status\ndata: ${JSON.stringify(status)}\n\n`)
    res.on('close', () => sseClients.delete(res))
  })

  const publicDir = path.join(__dirname, 'public')
  const indexFile = path.join(publicDir, 'index.html')

  function sendIndex(_req, res) {
    res.sendFile(indexFile)
  }

  app.get('/', sendIndex)
  app.get('/home', sendIndex)

  app.post('/api/chat', (req, res) => {
    const raw = req.body && req.body.text != null ? String(req.body.text) : ''
    const text = raw.trim()
    if (!text) {
      res.status(400).json({ error: 'Пустое сообщение' })
      return
    }
    if (text.length > 256) {
      res.status(400).json({ error: 'Слишком длинное сообщение' })
      return
    }
    const bot = getBot()
    if (!bot) {
      res.status(503).json({ error: 'Бот ещё не создан' })
      return
    }
    try {
      if (!bot.entity) {
        res.status(503).json({ error: 'Бот не в мире (ждите spawn)' })
        return
      }
      bot.chat(text)
      log('chat', `→ ${text}`)
      res.json({ ok: true })
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
    }
  })

  app.use(express.static(publicDir, { index: false }))

  const server = app.listen(port, host, () => {
    const openHost = host === '0.0.0.0' ? '127.0.0.1' : host
    const url = `http://${openHost}:${port}/home`
    log('info', `Веб-интерфейс: ${url}`)
    if (openBrowser) {
      if (process.platform === 'win32') {
        exec(`start "" "${url}"`, { windowsHide: true })
      } else if (process.platform === 'darwin') {
        exec(`open "${url}"`)
      } else {
        exec(`xdg-open "${url}"`)
      }
    }
  })

  return { app, server, log, setStatus }
}

module.exports = { createWebUi }
