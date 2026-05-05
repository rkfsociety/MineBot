#!/usr/bin/env node
'use strict'

const { execFileSync } = require('child_process')

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
}

function parseListeningPidsForPort(port) {
  const out = run('cmd.exe', ['/c', 'netstat', '-ano'])
  const lines = out.split(/\r?\n/)
  const pids = new Set()
  const needle = ':' + String(port)
  for (const line of lines) {
    if (!line.includes(needle)) continue
    if (!/LISTENING/i.test(line)) continue
    const parts = line.trim().split(/\s+/)
    const pidStr = parts[parts.length - 1]
    if (/^\d+$/.test(pidStr)) pids.add(parseInt(pidStr, 10))
  }
  return [...pids]
}

function getProcName(pid) {
  try {
    const out = run('cmd.exe', ['/c', 'tasklist', '/fi', `PID eq ${pid}`, '/fo', 'csv', '/nh'])
    const m = out.match(/^"([^"]+)"/)
    return m ? m[1] : null
  } catch {
    return null
  }
}

function killPid(pid) {
  try {
    run('cmd.exe', ['/c', 'taskkill', '/PID', String(pid), '/F'])
    return true
  } catch {
    return false
  }
}

function main() {
  const ports = (process.argv.slice(2).length ? process.argv.slice(2) : ['3847', '3848'])
    .map((s) => parseInt(String(s), 10))
    .filter((n) => Number.isFinite(n) && n > 0)

  const killed = []
  const seen = new Set()
  for (const port of ports) {
    for (const pid of parseListeningPidsForPort(port)) {
      if (seen.has(pid)) continue
      seen.add(pid)
      const name = (getProcName(pid) || '').toLowerCase()
      // safety: only kill node/minebot here
      if (name !== 'node.exe' && name !== 'minebot.exe') continue
      if (killPid(pid)) killed.push(pid)
    }
  }

  process.stdout.write(JSON.stringify({ ok: true, ports, killed }, null, 2) + '\n')
}

main()

