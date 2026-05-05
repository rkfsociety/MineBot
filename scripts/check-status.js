#!/usr/bin/env node
'use strict'

async function get(url) {
  const res = await fetch(url, { headers: { 'accept': 'application/json' } })
  const text = await res.text()
  return { url, status: res.status, ok: res.ok, text }
}

async function main() {
  const urls = [
    'http://127.0.0.1:3847/api/status',
    'http://127.0.0.1:3848/api/status',
  ]
  const out = []
  for (const u of urls) {
    try {
      out.push(await get(u))
    } catch (e) {
      out.push({ url: u, ok: false, error: e instanceof Error ? e.message : String(e) })
    }
  }
  process.stdout.write(JSON.stringify(out, null, 2) + '\n')
}

main()

