'use strict'

// moved from /portRepair.js (keep same exports)
const { execFile } = require('child_process')

function execPwsh(script) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(String(stderr || stdout || err.message || err)))
          return
        }
        resolve(String(stdout || '').trim())
      },
    )
  })
}

async function repairMineBotPortsWin32(ports) {
  const portList = (ports || [])
    .map((p) => parseInt(String(p), 10))
    .filter((n) => Number.isFinite(n))
  if (!portList.length) return { ok: true, killedPids: [] }

  // Важно: убиваем только Node-процессы MineBot (по entrypoints в CommandLine).
  // Не полагаемся на подстроку "MineBot" — путь может быть любым (например C:\github\MineBot\...).
  const script = `
$ports = @(${portList.join(',')})
$needles = @('botService.js','panelServer.js','runner.js','electronMain.js')
$killed = @()
foreach ($pt in $ports) {
  $lines = (netstat -ano | Select-String (':' + $pt) | Select-String 'LISTENING')
  foreach ($ln in $lines) {
    $p = ($ln.ToString() -split '\\s+')[-1]
    if ($p -notmatch '^\\d+$') { continue }
    try {
      $proc = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $p)
      if (-not $proc) { continue }
      if ($proc.Name -ne 'node.exe' -and $proc.Name -ne 'MineBot.exe') { continue }
      $cmd = [string]$proc.CommandLine
      $hit = $false
      foreach ($n in $needles) { if ($cmd -like ('*' + $n + '*')) { $hit = $true } }
      if (-not $hit) { continue }
      Stop-Process -Id ([int]$p) -Force
      $killed += [int]$p
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

