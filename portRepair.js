'use strict'

const { execFile } = require('child_process')

function execPwsh(script) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true },
      (_err, stdout, stderr) => {
        resolve(String(stdout || '').trim() || String(stderr || '').trim())
      },
    )
  })
}

async function repairMineBotPortsWin32(ports) {
  const portList = (ports || []).map((p) => parseInt(String(p), 10)).filter((n) => Number.isFinite(n))
  if (!portList.length) return { ok: true, killedPids: [] }

  // Важно: убиваем только Node-процессы, у которых CommandLine содержит MineBot и один из наших entrypoints.
  const script = `
$ports = @(${portList.join(',')})
$needles = @('botService.js','panelServer.js','runner.js','electronMain.js')
$killed = @()
foreach ($pt in $ports) {
  $lines = (netstat -ano | Select-String (':' + $pt) | Select-String 'LISTENING')
  foreach ($ln in $lines) {
    $pid = ($ln.ToString() -split '\\s+')[-1]
    if ($pid -notmatch '^\\d+$') { continue }
    try {
      $p = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $pid)
      if (-not $p) { continue }
      if ($p.Name -ne 'node.exe' -and $p.Name -ne 'MineBot.exe') { continue }
      $cmd = [string]$p.CommandLine
      if ($cmd -notmatch 'MineBot') { continue }
      $hit = $false
      foreach ($n in $needles) { if ($cmd -like ('*' + $n + '*')) { $hit = $true } }
      if (-not $hit) { continue }
      Stop-Process -Id ([int]$pid) -Force
      $killed += [int]$pid
    } catch {}
  }
}
$killed | Sort-Object -Unique | ConvertTo-Json -Compress
`

  const out = await execPwsh(script)
  try {
    const arr = JSON.parse(out)
    return { ok: true, killedPids: Array.isArray(arr) ? arr : [] }
  } catch {
    return { ok: true, killedPids: [] }
  }
}

module.exports = { repairMineBotPortsWin32 }

